"""Feature + edge mutations. Single write path shared by REST routers and agent tools.

Every mutation commits to Postgres first (system of record), then write-through
updates the in-memory graph (`graph` param). If the graph update fails it is
marked dirty and rebuilt lazily — never the other way around.
"""

import uuid

from fastapi import HTTPException
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    Capability,
    CapabilityGuess,
    EdgeKind,
    Feature,
    FeatureCapability,
    FeatureEdge,
    Product,
)
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


async def _resolve_links(
    session: AsyncSession, capability_ids: list[uuid.UUID], unknown: bool
) -> list[uuid.UUID]:
    """The REALIZES set, deduped in order. At least one unless the feature
    declares its capabilities unknown: an undeclared empty list is either
    misfiled or unjustified work — refuse it here, because no column can."""
    ids = list(dict.fromkeys(capability_ids))
    if not ids and not unknown:
        raise HTTPException(
            422,
            "A feature must realize at least one capability (capability_ids), "
            "or declare its capabilities unknown (unknown_capabilities).",
        )
    found = set(await session.scalars(select(Capability.id).where(Capability.id.in_(ids))))
    for cid in ids:
        if cid not in found:
            raise HTTPException(404, f"Capability {cid} not found")
    return ids


async def _require_product(session: AsyncSession, product_id: uuid.UUID | None) -> None:
    if product_id is not None and await session.get(Product, product_id) is None:
        raise HTTPException(404, f"Product {product_id} not found")


async def create_feature(
    session: AsyncSession, data: FeatureCreate, graph=None
) -> Feature:
    ids = await _resolve_links(session, data.capability_ids, data.unknown_capabilities)
    await _require_product(session, data.product_id)
    feature = Feature(**data.model_dump(exclude={"capability_ids"}))
    feature.capability_links = [FeatureCapability(capability_id=cid) for cid in ids]
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
    if fields.get("unknown_capabilities") is None:
        fields.pop("unknown_capabilities", None)
    unknown = fields.get("unknown_capabilities", feature.unknown_capabilities)
    if "capability_ids" in fields:
        ids = await _resolve_links(session, fields.pop("capability_ids") or [], unknown)
        keep = {link.capability_id: link for link in feature.capability_links}
        feature.capability_links = [
            keep.get(cid) or FeatureCapability(capability_id=cid) for cid in ids
        ]
        # A fact and a guess about the same link never coexist: confirming the
        # link retires its guess in the same commit.
        await session.execute(
            delete(CapabilityGuess).where(
                CapabilityGuess.feature_id == feature.id,
                CapabilityGuess.capability_id.in_(ids),
            )
        )
    else:
        # Clearing the declaration on a feature with no links is the same orphan.
        await _resolve_links(session, feature.capability_ids, unknown)
    if fields.get("product_id") is not None:
        await _require_product(session, fields["product_id"])
    for key, value in fields.items():
        setattr(feature, key, value)
    await session.commit()
    await session.refresh(feature)
    if graph is not None:
        graph.upsert_node(feature)
    return feature


async def refresh_product_features(
    session: AsyncSession, product_id: uuid.UUID, graph=None
) -> None:
    """A product's external flag decides whether its features are our work;
    re-sync their graph nodes after it changes."""
    if graph is None:
        return
    features = await session.scalars(select(Feature).where(Feature.product_id == product_id))
    for feature in features:
        await session.refresh(feature, ["product"])
        graph.upsert_node(feature)


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
        chain = graph.would_create_cycle(data.src_id, data.dst_id, data.kind)
        if chain:
            # Name the chain it would close, in plain words: people and agents
            # both need to know which link to remove.
            rows = await session.scalars(select(Feature).where(Feature.id.in_(chain)))
            names = {f.id: f"“{f.name}”" for f in rows}
            through = f" through {', '.join(names[n] for n in chain[1:-1])}" if len(chain) > 2 else ""
            raise HTTPException(
                422,
                f"That would make a circular dependency: {names[chain[0]]} already needs "
                f"{names[chain[-1]]}{through}. Remove a link in that chain first.",
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
