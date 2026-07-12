"""Feature + edge mutations. Single write path shared by REST routers and agent tools.

Every mutation commits to Postgres first (system of record), then write-through
updates the in-memory graph (`graph` param). If the graph update fails it is
marked dirty and rebuilt lazily — never the other way around.
"""

import uuid

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Capability, EdgeKind, Feature, FeatureEdge
from app.schemas.feature import EdgeCreate, FeatureCreate, FeatureUpdate


async def list_features(session: AsyncSession, q: str | None = None) -> list[Feature]:
    stmt = select(Feature).order_by(Feature.seq)
    if q:
        stmt = stmt.where(Feature.name.ilike(f"%{q}%"))
    return list((await session.scalars(stmt)).all())


async def get_feature(session: AsyncSession, feature_id: uuid.UUID) -> Feature:
    feature = await session.get(Feature, feature_id)
    if feature is None:
        raise HTTPException(404, "Feature not found")
    return feature


async def _require_capability(session: AsyncSession, capability_id: uuid.UUID) -> None:
    if await session.get(Capability, capability_id) is None:
        raise HTTPException(404, f"Capability {capability_id} not found")


async def create_feature(
    session: AsyncSession, data: FeatureCreate, graph=None
) -> Feature:
    await _require_capability(session, data.capability_id)
    feature = Feature(**data.model_dump())
    session.add(feature)
    await session.commit()
    await session.refresh(feature)
    if graph is not None:
        graph.upsert_node(feature)
    return feature


async def update_feature(
    session: AsyncSession, feature_id: uuid.UUID, data: FeatureUpdate, graph=None
) -> Feature:
    feature = await get_feature(session, feature_id)
    fields = data.model_dump(exclude_unset=True)
    if fields.get("capability_id") is not None:
        await _require_capability(session, fields["capability_id"])
    for key, value in fields.items():
        setattr(feature, key, value)
    await session.commit()
    await session.refresh(feature)
    if graph is not None:
        graph.upsert_node(feature)
    return feature


async def delete_feature(session: AsyncSession, feature_id: uuid.UUID, graph=None) -> None:
    feature = await get_feature(session, feature_id)
    await session.delete(feature)
    await session.commit()
    if graph is not None:
        graph.remove_node(feature_id)


async def list_edges(session: AsyncSession) -> list[FeatureEdge]:
    return list((await session.scalars(select(FeatureEdge))).all())


async def create_edge(session: AsyncSession, data: EdgeCreate, graph=None) -> FeatureEdge:
    if data.src_id == data.dst_id:
        raise HTTPException(422, "An edge cannot connect a feature to itself")
    for fid in (data.src_id, data.dst_id):
        if await session.get(Feature, fid) is None:
            raise HTTPException(404, f"Feature {fid} not found")
    # Precedence edges (DEPENDS_ON, BLOCKS) are rejected at write time if they
    # would close a cycle — the invariant lives here, not at topo time.
    if graph is not None and data.kind != EdgeKind.RELATES_TO:
        await graph.ensure_fresh()
        if graph.would_create_cycle(data.src_id, data.dst_id, data.kind):
            raise HTTPException(
                422,
                f"{data.kind} edge would create a dependency cycle — "
                "break the existing chain first (see /api/graph/cycles).",
            )
    existing = await session.scalar(
        select(FeatureEdge).where(
            FeatureEdge.src_id == data.src_id,
            FeatureEdge.dst_id == data.dst_id,
            FeatureEdge.kind == data.kind,
        )
    )
    if existing is not None:
        return existing
    edge = FeatureEdge(**data.model_dump())
    session.add(edge)
    await session.commit()
    await session.refresh(edge)
    if graph is not None:
        graph.add_edge(edge.src_id, edge.dst_id, edge.kind)
    return edge


async def delete_edge(session: AsyncSession, edge_id: uuid.UUID, graph=None) -> None:
    edge = await session.get(FeatureEdge, edge_id)
    if edge is None:
        raise HTTPException(404, "Edge not found")
    src, dst, kind = edge.src_id, edge.dst_id, edge.kind
    await session.delete(edge)
    await session.commit()
    if graph is not None:
        graph.remove_edge(src, dst, kind)
