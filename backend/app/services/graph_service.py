"""In-memory feature graph — replaces Neo4j.

Nodes are feature UUIDs with display attributes; edges are typed
(DEPENDS_ON | BLOCKS | RELATES_TO | PART_OF), keyed by kind in a MultiDiGraph.

Edge semantics: ``A --DEPENDS_ON--> B`` means *A depends on B*. Therefore:
- impact(B) ("who breaks if B changes")   = nx.ancestors on the DEPENDS_ON subgraph
- dependencies(A) ("what A needs")        = nx.descendants on the DEPENDS_ON subgraph
- topo_order (dependencies first)         = reversed topological sort

Postgres is the system of record: every mutation commits there first, then
write-through updates this graph. Any in-memory failure marks the graph dirty
and it is rebuilt from SQL on next use (never the other way around).

The graph lives on ``app.state`` — run uvicorn with exactly one worker.
"""

import asyncio
import uuid
from itertools import islice
from typing import Any

import networkx as nx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.models import EdgeKind, Feature, FeatureEdge


class GraphCycleError(Exception):
    def __init__(self, cycle: list[uuid.UUID]):
        self.cycle = cycle
        super().__init__("Dependency cycle detected")


def _node_attrs(feature: Feature | Any) -> dict[str, Any]:
    return {
        "seq": feature.seq,
        "name": feature.name,
        "type": str(feature.type),
        "status": str(feature.status),
        "priority": feature.priority,
    }


class FeatureGraph:
    def __init__(self, sessionmaker: async_sessionmaker[AsyncSession] | None = None):
        self._sessionmaker = sessionmaker
        self._g = nx.MultiDiGraph()
        self._dirty = False
        self._lock = asyncio.Lock()

    # ---- lifecycle ----

    async def load(self) -> None:
        async with self._lock:
            await self._rebuild()

    async def ensure_fresh(self) -> None:
        if not self._dirty:
            return
        async with self._lock:
            if self._dirty:
                await self._rebuild()

    async def _rebuild(self) -> None:
        if self._sessionmaker is None:
            return
        g = nx.MultiDiGraph()
        async with self._sessionmaker() as session:
            for feature in await session.scalars(select(Feature)):
                g.add_node(feature.id, **_node_attrs(feature))
            for edge in await session.scalars(select(FeatureEdge)):
                g.add_edge(edge.src_id, edge.dst_id, key=str(edge.kind), kind=str(edge.kind))
        self._g = g
        self._dirty = False

    def mark_dirty(self) -> None:
        self._dirty = True

    # ---- write-through mutators (called after the DB commit) ----

    def upsert_node(self, feature: Feature) -> None:
        try:
            self._g.add_node(feature.id, **_node_attrs(feature))
        except Exception:
            self.mark_dirty()

    def remove_node(self, feature_id: uuid.UUID) -> None:
        try:
            if self._g.has_node(feature_id):
                self._g.remove_node(feature_id)
        except Exception:
            self.mark_dirty()

    def add_edge(self, src: uuid.UUID, dst: uuid.UUID, kind: EdgeKind | str) -> None:
        try:
            self._g.add_edge(src, dst, key=str(kind), kind=str(kind))
        except Exception:
            self.mark_dirty()

    def remove_edge(self, src: uuid.UUID, dst: uuid.UUID, kind: EdgeKind | str) -> None:
        try:
            if self._g.has_edge(src, dst, key=str(kind)):
                self._g.remove_edge(src, dst, key=str(kind))
        except Exception:
            self.mark_dirty()

    # ---- queries ----

    def node_count(self) -> int:
        return self._g.number_of_nodes()

    def edge_count(self) -> int:
        return self._g.number_of_edges()

    def _summary(self, node_id: uuid.UUID) -> dict[str, Any]:
        attrs = self._g.nodes[node_id]
        return {
            "id": str(node_id),
            "display_id": f"FTR-{attrs['seq']:03d}",
            "name": attrs["name"],
            "type": attrs["type"],
            "status": attrs["status"],
            "priority": attrs.get("priority"),
        }

    def relationships(self, feature_id: uuid.UUID) -> dict[str, list[dict[str, Any]]]:
        if not self._g.has_node(feature_id):
            return {"outgoing": [], "incoming": []}
        outgoing = [
            {"kind": data["kind"], "feature": self._summary(dst)}
            for _, dst, data in self._g.out_edges(feature_id, data=True)
        ]
        incoming = [
            {"kind": data["kind"], "feature": self._summary(src)}
            for src, _, data in self._g.in_edges(feature_id, data=True)
        ]
        return {"outgoing": outgoing, "incoming": incoming}

    def _depends_subgraph(self) -> nx.DiGraph:
        g = nx.DiGraph()
        g.add_nodes_from(self._g.nodes)
        for src, dst, data in self._g.edges(data=True):
            if data["kind"] == str(EdgeKind.DEPENDS_ON):
                g.add_edge(src, dst)
        return g

    def impact(self, feature_id: uuid.UUID) -> dict[str, list[dict[str, Any]]]:
        """dependents = blast radius (who breaks); dependencies = what it needs."""
        if not self._g.has_node(feature_id):
            return {"dependents": [], "dependencies": []}
        dep = self._depends_subgraph()
        return {
            "dependents": [self._summary(n) for n in nx.ancestors(dep, feature_id)],
            "dependencies": [self._summary(n) for n in nx.descendants(dep, feature_id)],
        }

    def topo_order(self) -> list[dict[str, Any]]:
        """Features ordered dependencies-first. Raises GraphCycleError on a cycle."""
        dep = self._depends_subgraph()
        try:
            order = list(reversed(list(nx.topological_sort(dep))))
        except nx.NetworkXUnfeasible:
            cycle = [edge[0] for edge in nx.find_cycle(dep)]
            raise GraphCycleError(cycle) from None
        return [self._summary(n) for n in order]

    def find_cycles(self, limit: int = 20) -> list[list[dict[str, Any]]]:
        dep = self._depends_subgraph()
        return [
            [self._summary(n) for n in cycle]
            for cycle in islice(nx.simple_cycles(dep), limit)
        ]

    def layout(self) -> dict[str, Any]:
        """Server-computed positions: column = dependency depth (dependencies left),
        row = index within column. Cycles are collapsed via condensation so layout
        never fails."""
        dep = self._depends_subgraph()
        cond = nx.condensation(dep)  # DAG of strongly-connected components
        # cond edges follow dependent -> dependency; reverse so generation 0 = pure dependencies
        generations = list(nx.topological_generations(cond.reverse(copy=False)))

        col_of: dict[uuid.UUID, int] = {}
        for col, scc_ids in enumerate(generations):
            for scc_id in scc_ids:
                for node in cond.nodes[scc_id]["members"]:
                    col_of[node] = col

        rows: dict[int, int] = {}
        nodes = []
        for node in sorted(self._g.nodes, key=lambda n: self._g.nodes[n]["seq"]):
            col = col_of.get(node, 0)
            row = rows.get(col, 0)
            rows[col] = row + 1
            nodes.append({**self._summary(node), "x": 40 + col * 200, "y": 30 + row * 96})

        edges = [
            {"src": str(src), "dst": str(dst), "kind": data["kind"]}
            for src, dst, data in self._g.edges(data=True)
        ]
        return {"nodes": nodes, "edges": edges}
