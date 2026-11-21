"""Two people saying "A needs B" and "B needs A" at the same moment: exactly
one is kept, the other is refused as a circle. A cycle that slips in poisons
every whole-graph answer (build order, smallest version) until someone finds
and removes it by hand.

Each write runs in its own session, so on its own connection: an advisory lock
is re-entrant on one connection and would prove nothing there.
"""

import asyncio

import networkx as nx
from fastapi import HTTPException
from sqlalchemy import delete, select

from app.models import FeatureEdge, TechEdge, TechEdgeKind, TechKind
from app.schemas.feature import EdgeCreate, FeatureCreate
from app.schemas.technology import TechEdgeCreate, TechnologyCreate
from app.services import features as feature_service
from app.services import technologies as tech_service
from app.services.graph_service import FeatureGraph

TRIALS = 20


async def _race(db, write, a, b, edge_table, reset=None):
    """Fire a->b and b->a together, TRIALS times; return the outcomes."""
    outcomes = []
    for _ in range(TRIALS):
        async with db() as session:
            await session.execute(delete(edge_table))
            await session.commit()
        if reset is not None:
            await reset()

        async def one(src, dst):
            async with db() as session:
                return await write(session, src, dst)

        results = await asyncio.gather(one(a, b), one(b, a), return_exceptions=True)
        refused = [r for r in results if isinstance(r, HTTPException)]
        assert all(r.status_code == 422 for r in refused), results
        assert len(refused) + sum(isinstance(r, edge_table) for r in results) == 2, results
        async with db() as session:
            rows = (await session.execute(select(edge_table.src_id, edge_table.dst_id))).all()
        outcomes.append((len(refused), nx.is_directed_acyclic_graph(nx.DiGraph(rows))))
    return outcomes


async def test_concurrent_opposite_feature_dependencies_keep_exactly_one(db):
    graph = FeatureGraph(db)
    async with db() as session:
        a = await feature_service.create_feature(
            session, FeatureCreate(name="Write a note", unknown_capabilities=True), graph
        )
        b = await feature_service.create_feature(
            session, FeatureCreate(name="Sync notes", unknown_capabilities=True), graph
        )

    async def write(session, src, dst):
        return await feature_service.create_edge(
            session, EdgeCreate(src_id=src.id, dst_id=dst.id, kind="DEPENDS_ON"), graph
        )

    # The in-memory graph starts each trial matching the emptied table.
    outcomes = await _race(db, write, a, b, FeatureEdge, reset=graph.load)
    assert outcomes == [(1, True)] * TRIALS


async def test_concurrent_opposite_tech_requirements_keep_exactly_one(db):
    async with db() as session:
        a, b = [
            await tech_service.create_technology(
                session, TechnologyCreate(slug=slug, name=slug, kind=TechKind.service)
            )
            for slug in ("api", "runtime")
        ]

    async def write(session, src, dst):
        return await tech_service.create_edge(
            session, TechEdgeCreate(src_id=src.id, dst_id=dst.id, kind=TechEdgeKind.REQUIRES)
        )

    outcomes = await _race(db, write, a, b, TechEdge)
    assert outcomes == [(1, True)] * TRIALS
