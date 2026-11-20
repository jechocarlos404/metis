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
(capabilities.parent_id). The bridge between planes is each feature's set of
capability_ids (REALIZES, many-to-many), carried as a node attribute so
capability impact can be computed from this graph alone.

Postgres is the system of record: every mutation commits there first, then
write-through updates this graph. Any in-memory failure marks the graph dirty
and it is rebuilt from SQL on next use (never the other way around).

The graph lives on ``app.state`` — run uvicorn with exactly one worker.
"""

import asyncio
import math
import uuid
from itertools import islice
from typing import Any

import networkx as nx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.models import EdgeKind, Feature, FeatureEdge

PRECEDENCE_KINDS = {str(EdgeKind.DEPENDS_ON), str(EdgeKind.BLOCKS)}

# layout() grid, in svg units: column pitch, row pitch, space between product
# blocks, and the rows-per-column budget factor (higher = taller blocks).
_COL_W = 200
_ROW_H = 96
_BLOCK_GAP = 220
_BLOCK_ASPECT = 1.2


class GraphCycleError(Exception):
    def __init__(self, cycle: list[uuid.UUID]):
        self.cycle = cycle
        super().__init__("Dependency cycle detected")


def _node_attrs(feature: Feature | Any) -> dict[str, Any]:
    return {
        "seq": feature.seq,
        "name": feature.name,
        "capability_ids": tuple(feature.capability_ids),
        "product_id": feature.product_id,
        # Someone else's feature: shown and traversed, never our work queue.
        "external": feature.external,
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
            "capability_ids": [str(c) for c in attrs.get("capability_ids", ())],
            "product_id": str(attrs["product_id"]) if attrs.get("product_id") else None,
            "external": attrs.get("external", False),
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

    def _ours(self, node: uuid.UUID) -> bool:
        return not self._g.nodes[node].get("external", False)

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

    def recheck(
        self,
        feature_id: uuid.UUID,
        capability_names: dict[uuid.UUID, str],
        product_names: dict[uuid.UUID, str],
    ) -> dict[str, Any] | None:
        """If this feature changes, what else must be rechecked? None if unknown.

        breaks: its dependents on the precedence graph (same set as impact),
        nearest first; `via` names the chain from this feature outward.
        retest: same-product features sharing a confirmed capability, rare
        shared capabilities first (score = sum of 1 / product features using
        it). A capability used by more than half of the product's features, and
        by at least 6, is broad: counted, not listed. elsewhere: our other
        products with the same capabilities, information only. Crosses the
        bridge explicitly; capability_ids are confirmed links, never guesses."""
        if not self._g.has_node(feature_id):
            return None
        nodes = self._g.nodes
        me = nodes[feature_id]
        product = me.get("product_id")
        caps = set(me.get("capability_ids", ()))

        # Reversed precedence: u -> v means v needs u, so paths run outward.
        paths = nx.single_source_shortest_path(self._precedence_subgraph().reverse(), feature_id)
        del paths[feature_id]
        breaks = [
            {
                **self._summary(n),
                "direct": len(path) == 2,
                "via": [nodes[v]["name"] for v in path[1:-1]],
            }
            for n, path in sorted(paths.items(), key=lambda i: (len(i[1]), nodes[i[0]]["name"]))
        ]

        peers = [n for n in nodes if product is not None and nodes[n].get("product_id") == product]
        users: dict[uuid.UUID, set[uuid.UUID]] = {}
        for n in peers:
            for cid in nodes[n].get("capability_ids", ()):
                if cid in caps:
                    users.setdefault(cid, set()).add(n)
        skip = set(paths) | {feature_id}
        broad_ids = {c for c, us in users.items() if len(us) > len(peers) / 2 and len(us) >= 6}

        shared: dict[uuid.UUID, list[uuid.UUID]] = {}
        rarest_first = sorted(
            users.keys() - broad_ids, key=lambda c: (len(users[c]), capability_names.get(c, ""))
        )
        for cid in rarest_first:
            for n in users[cid] - skip:
                shared.setdefault(n, []).append(cid)
        retest = [
            {
                **self._summary(n),
                "shared": [{"id": str(c), "name": capability_names.get(c, str(c))} for c in cids],
                "score": round(sum(1 / len(users[c]) for c in cids), 4),
            }
            for n, cids in shared.items()
        ]
        retest.sort(key=lambda r: (-r["score"], r["name"]))
        broad = sorted(
            (
                {
                    "id": str(c),
                    "name": capability_names.get(c, str(c)),
                    "features": len(users[c] - skip),
                }
                for c in broad_ids
            ),
            key=lambda b: (-b["features"], b["name"]),
        )

        others: dict[uuid.UUID, tuple[set[uuid.UUID], set[uuid.UUID]]] = {}
        for n in nodes:
            pid = nodes[n].get("product_id")
            if pid is None or pid == product or nodes[n].get("external", False):
                continue
            hit = caps.intersection(nodes[n].get("capability_ids", ()))
            if hit:
                entry = others.setdefault(pid, (set(), set()))
                entry[0].update(hit)
                entry[1].add(n)
        elsewhere = sorted(
            (
                {
                    "id": str(pid),
                    "name": product_names.get(pid, str(pid)),
                    "capabilities": sorted(capability_names.get(c, str(c)) for c in hit),
                    "features": len(features),
                }
                for pid, (hit, features) in others.items()
            ),
            key=lambda e: (-len(e["capabilities"]), -e["features"], e["name"]),
        )
        return {
            "feature": self._summary(feature_id),
            "breaks": breaks,
            "retest": retest,
            "broad": broad,
            "elsewhere": elsewhere,
        }

    def ready_set(self) -> list[dict[str, Any]]:
        """The work frontier: our pending features whose precedence
        dependencies are all done. External features are never our work."""
        dep = self._precedence_subgraph()
        ready = []
        for node in self._g.nodes:
            if self._g.nodes[node]["status"] != "pending" or not self._ours(node):
                continue
            if all(
                self._g.nodes[d]["status"] == "done" for d in nx.descendants(dep, node)
            ):
                ready.append(node)
        ready.sort(key=lambda n: (self._g.nodes[n]["priority"] or 99, self._g.nodes[n]["seq"]))
        return [self._summary(n) for n in ready]

    def topo_order(self) -> list[dict[str, Any]]:
        """Our features ordered dependencies-first (external ones are not ours
        to build). Raises GraphCycleError on a cycle."""
        dep = self._precedence_subgraph()
        try:
            order = list(reversed(list(nx.topological_sort(dep))))
        except nx.NetworkXUnfeasible:
            cycle = [edge[0] for edge in nx.find_cycle(dep)]
            raise GraphCycleError(cycle) from None
        return [self._summary(n) for n in order if self._ours(n)]

    def mvp_cut(self, target_ids: set[uuid.UUID]) -> dict[str, Any]:
        """Prerequisite closure for a delivery cut: essential = targets ∪ their
        precedence-descendants (what must exist for the targets to work),
        dependencies-first; deferrable = every other feature, hottest priority
        first. Capabilities are grouped flat — a feature counts toward every
        capability it realizes — and submap
        aggregation is the caller's job. Raises GraphCycleError if the
        essential subgraph contains a cycle."""
        dep = self._precedence_subgraph()
        # A cut is a plan for our work; external features are neither targets
        # nor prerequisites we could build.
        targets = {t for t in target_ids if self._g.has_node(t) and self._ours(t)}
        required = set(targets)
        for target in targets:
            required |= nx.descendants(dep, target)
        required = {n for n in required if self._ours(n)}
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
                {n for n in self._g.nodes if self._ours(n)} - required,
                key=lambda n: (self._g.nodes[n]["priority"] or 99, self._g.nodes[n]["seq"]),
            )
        ]
        capabilities: dict[uuid.UUID, dict[str, int]] = {}
        for node in self._g.nodes:
            if not self._ours(node):
                continue
            for cid in self._g.nodes[node].get("capability_ids", ()):
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

    # ---- capability impact (read off the feature graph) ----

    def capability_impact(self, capability_ids: set[uuid.UUID]) -> dict[str, list[uuid.UUID]]:
        """Blast radius at capability resolution for a submap's worth of ids.
        Walks feature needs, never capability pairs: dependents = capabilities
        of the features that need (through links of links) a feature realizing
        the submap, dependencies = capabilities of what those features need.
        Projecting edges onto capabilities first would let a shared capability
        (File Storage, sign-in) bridge products that never need each other.
        Aggregation over a subtree is the caller's job (the capability service
        owns the PART_OF forest); so is ordering, since names live there."""
        dep = self._precedence_subgraph()
        seeds = [
            n for n in self._g.nodes
            if capability_ids.intersection(self._g.nodes[n].get("capability_ids", ()))
        ]
        needers: set[uuid.UUID] = set()
        needed: set[uuid.UUID] = set()
        for n in seeds:
            needers |= nx.ancestors(dep, n)
            needed |= nx.descendants(dep, n)

        def capabilities_of(features: set[uuid.UUID]) -> list[uuid.UUID]:
            found = {c for f in features for c in self._g.nodes[f].get("capability_ids", ())}
            return sorted(found - capability_ids, key=str)

        return {"dependents": capabilities_of(needers), "dependencies": capabilities_of(needed)}

    def layout(self) -> dict[str, Any]:
        """Server-computed positions, one block per product.

        Inside a block, column order is dependency depth (dependencies left); a
        depth with more nodes than the block's row budget wraps into extra
        columns beside it, so every dependency still sits left of its dependents.
        Blocks are shelf-packed into rows across a wide canvas. Cycles are
        collapsed via condensation so layout never fails."""
        dep = self._precedence_subgraph()
        cond = nx.condensation(dep)  # DAG of strongly-connected components
        # cond edges follow dependent -> dependency; reverse so generation 0 = pure dependencies
        generations = list(nx.topological_generations(cond.reverse(copy=False)))

        depth_of: dict[uuid.UUID, int] = {}
        for depth, scc_ids in enumerate(generations):
            for scc_id in scc_ids:
                for node in cond.nodes[scc_id]["members"]:
                    depth_of[node] = depth

        blocks: dict[Any, list[uuid.UUID]] = {}
        for node in sorted(self._g.nodes, key=lambda n: self._g.nodes[n]["seq"]):
            blocks.setdefault(self._g.nodes[node].get("product_id"), []).append(node)

        # Lay out each block locally: (col, row) per node.
        placed: list[tuple[int, int, dict[uuid.UUID, tuple[int, int]]]] = []
        for members in blocks.values():
            row_budget = max(3, math.ceil(math.sqrt(len(members) * _BLOCK_ASPECT)))
            by_depth: dict[int, list[uuid.UUID]] = {}
            for node in members:
                by_depth.setdefault(depth_of.get(node, 0), []).append(node)
            cells: dict[uuid.UUID, tuple[int, int]] = {}
            col = 0
            for depth in sorted(by_depth):
                column = by_depth[depth]
                for i, node in enumerate(column):
                    cells[node] = (col + i // row_budget, i % row_budget)
                col += math.ceil(len(column) / row_budget)
            rows = min(row_budget, max(len(c) for c in by_depth.values()))
            placed.append((col, rows, cells))

        # Shelf-pack blocks, biggest first, into a canvas about 16:10 wide.
        placed.sort(key=lambda b: -b[0] * b[1])
        area = sum((c * _COL_W + _BLOCK_GAP) * (r * _ROW_H + _BLOCK_GAP) for c, r, _ in placed)
        width = max([c * _COL_W for c, _, _ in placed] + [math.sqrt(area * 1.6)])
        pos: dict[uuid.UUID, tuple[int, int]] = {}
        x = y = shelf_h = 0
        for cols, rows, cells in placed:
            w, h = cols * _COL_W, rows * _ROW_H
            if x and x + w > width:
                x, y, shelf_h = 0, y + shelf_h + _BLOCK_GAP, 0
            for node, (c, r) in cells.items():
                pos[node] = (40 + x + c * _COL_W, 30 + y + r * _ROW_H)
            x += w + _BLOCK_GAP
            shelf_h = max(shelf_h, h)

        nodes = []
        for node in sorted(self._g.nodes, key=lambda n: self._g.nodes[n]["seq"]):
            px, py = pos[node]
            nodes.append({**self._summary(node), "x": px, "y": py})

        edges = [
            {"src": str(src), "dst": str(dst), "kind": data["kind"]}
            for src, dst, data in self._g.edges(data=True)
        ]
        return {"nodes": nodes, "edges": edges}
