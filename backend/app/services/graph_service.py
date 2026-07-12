"""In-memory feature graph — replaces Neo4j.

Nodes are feature UUIDs with display attributes; edges are typed
(DEPENDS_ON | BLOCKS | RELATES_TO), keyed by kind in a MultiDiGraph.

The PRECEDENCE graph is the only graph execution algorithms run on:
``DEPENDS_ON ∪ reverse(BLOCKS)``, jointly acyclic. Semantics:
``A --DEPENDS_ON--> B`` means *A needs B*; ``A --BLOCKS--> B`` means *B
cannot proceed until A lands* (structurally B needs A). Therefore:
- impact(B) ("who breaks if B changes")   = nx.ancestors on the precedence graph
- dependencies(A) ("what A needs")        = nx.descendants on the precedence graph
- topo_order (dependencies first)         = reversed topological sort
RELATES_TO participates in nothing.

Containment is NOT here: the capability map (PART_OF) is relational
(capabilities.parent_id). The bridge between planes is each feature's
capability_id, carried as a node attribute so the capability coupling
projection can be computed from this graph alone.

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

PRECEDENCE_KINDS = {str(EdgeKind.DEPENDS_ON), str(EdgeKind.BLOCKS)}


class GraphCycleError(Exception):
    def __init__(self, cycle: list[uuid.UUID]):
        self.cycle = cycle
        super().__init__("Dependency cycle detected")


def _node_attrs(feature: Feature | Any) -> dict[str, Any]:
    return {
        "seq": feature.seq,
        "name": feature.name,
        "capability_id": feature.capability_id,
        "facets": dict(feature.facets or {}),
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
            "name": attrs["name"],
            "capability_id": str(attrs["capability_id"]) if attrs.get("capability_id") else None,
            "facets": attrs.get("facets", {}),
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

    def _precedence_subgraph(self) -> nx.DiGraph:
        """DEPENDS_ON ∪ reverse(BLOCKS): edge u->v means *u needs v*."""
        g = nx.DiGraph()
        g.add_nodes_from(self._g.nodes)
        for src, dst, data in self._g.edges(data=True):
            if data["kind"] == str(EdgeKind.DEPENDS_ON):
                g.add_edge(src, dst)
            elif data["kind"] == str(EdgeKind.BLOCKS):
                g.add_edge(dst, src)
        return g

    def would_create_cycle(self, src: uuid.UUID, dst: uuid.UUID, kind: EdgeKind | str) -> bool:
        """Write-time guard: would adding src --kind--> dst close a precedence
        cycle? RELATES_TO never can. Unknown nodes can't be on a cycle yet."""
        if str(kind) not in PRECEDENCE_KINDS:
            return False
        if not (self._g.has_node(src) and self._g.has_node(dst)):
            return False
        need_from, need_to = (src, dst) if str(kind) == str(EdgeKind.DEPENDS_ON) else (dst, src)
        # Adding need_from -> need_to cycles iff need_to already reaches need_from.
        return nx.has_path(self._precedence_subgraph(), need_to, need_from)

    def impact(self, feature_id: uuid.UUID) -> dict[str, list[dict[str, Any]]]:
        """dependents = blast radius (who breaks); dependencies = what it needs."""
        if not self._g.has_node(feature_id):
            return {"dependents": [], "dependencies": []}
        dep = self._precedence_subgraph()
        return {
            "dependents": [self._summary(n) for n in nx.ancestors(dep, feature_id)],
            "dependencies": [self._summary(n) for n in nx.descendants(dep, feature_id)],
        }

    def ready_set(self) -> list[dict[str, Any]]:
        """The work frontier: pending features whose precedence dependencies
        are all done."""
        dep = self._precedence_subgraph()
        ready = []
        for node in self._g.nodes:
            if self._g.nodes[node]["status"] != "pending":
                continue
            if all(
                self._g.nodes[d]["status"] == "done" for d in nx.descendants(dep, node)
            ):
                ready.append(node)
        ready.sort(key=lambda n: (self._g.nodes[n]["priority"] or 99, self._g.nodes[n]["seq"]))
        return [self._summary(n) for n in ready]

    def topo_order(self) -> list[dict[str, Any]]:
        """Features ordered dependencies-first. Raises GraphCycleError on a cycle."""
        dep = self._precedence_subgraph()
        try:
            order = list(reversed(list(nx.topological_sort(dep))))
        except nx.NetworkXUnfeasible:
            cycle = [edge[0] for edge in nx.find_cycle(dep)]
            raise GraphCycleError(cycle) from None
        return [self._summary(n) for n in order]

    def mvp_cut(self, target_ids: set[uuid.UUID]) -> dict[str, Any]:
        """Prerequisite closure for a delivery cut: essential = targets ∪ their
        precedence-descendants (what must exist for the targets to work),
        dependencies-first; deferrable = every other feature, hottest priority
        first. Capabilities are grouped flat by capability_id — submap
        aggregation is the caller's job. Raises GraphCycleError if the
        essential subgraph contains a cycle."""
        dep = self._precedence_subgraph()
        targets = {t for t in target_ids if self._g.has_node(t)}
        required = set(targets)
        for target in targets:
            required |= nx.descendants(dep, target)
        sub = dep.subgraph(required)
        try:
            order = list(reversed(list(nx.topological_sort(sub))))
        except nx.NetworkXUnfeasible:
            cycle = [edge[0] for edge in nx.find_cycle(sub)]
            raise GraphCycleError(cycle) from None
        essential = [{**self._summary(n), "is_target": n in targets} for n in order]
        deferrable = [
            self._summary(n)
            for n in sorted(
                set(self._g.nodes) - required,
                key=lambda n: (self._g.nodes[n]["priority"] or 99, self._g.nodes[n]["seq"]),
            )
        ]
        capabilities: dict[uuid.UUID, dict[str, int]] = {}
        for node in self._g.nodes:
            cid = self._g.nodes[node].get("capability_id")
            if not cid:
                continue
            entry = capabilities.setdefault(cid, {"required": 0, "total": 0})
            entry["total"] += 1
            if node in required:
                entry["required"] += 1
        return {"essential": essential, "deferrable": deferrable, "capabilities": capabilities}

    def find_cycles(self, limit: int = 20) -> list[list[dict[str, Any]]]:
        dep = self._precedence_subgraph()
        return [
            [self._summary(n) for n in cycle]
            for cycle in islice(nx.simple_cycles(dep), limit)
        ]

    # ---- capability coupling (slow-plane projection) ----

    def coupling_edges(self) -> set[tuple[uuid.UUID, uuid.UUID]]:
        """Project the precedence graph onto capabilities: (c1, c2) means some
        feature realizing c1 needs a feature realizing c2. Computed, never
        stored. Same-capability edges are internal and dropped."""
        edges: set[tuple[uuid.UUID, uuid.UUID]] = set()
        for u, v in self._precedence_subgraph().edges:
            cu = self._g.nodes[u].get("capability_id")
            cv = self._g.nodes[v].get("capability_id")
            if cu and cv and cu != cv:
                edges.add((cu, cv))
        return edges

    def capability_impact(self, capability_ids: set[uuid.UUID]) -> dict[str, list[uuid.UUID]]:
        """Blast radius at capability resolution for a submap's worth of ids:
        dependents = capabilities whose features break, dependencies = what the
        submap's features need. Aggregation over a subtree is the caller's job
        (the capability service owns the PART_OF forest)."""
        g = nx.DiGraph()
        g.add_edges_from(self.coupling_edges())
        dependents: set[uuid.UUID] = set()
        dependencies: set[uuid.UUID] = set()
        for cid in capability_ids:
            if g.has_node(cid):
                dependents |= nx.ancestors(g, cid)
                dependencies |= nx.descendants(g, cid)
        return {
            "dependents": sorted(dependents - capability_ids, key=str),
            "dependencies": sorted(dependencies - capability_ids, key=str),
        }

    def layout(self) -> dict[str, Any]:
        """Server-computed positions: column = dependency depth (dependencies left),
        row = index within column. Cycles are collapsed via condensation so layout
        never fails."""
        dep = self._precedence_subgraph()
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
