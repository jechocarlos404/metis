"""Capability map (slow plane) — CRUD, containment forest, and the traversals
that cross the REALIZES bridge: submap, scope, rollup, capability impact,
why(feature), mvp_cut, and health findings.

The map is a forest stored relationally (parent_id): single parent, acyclic.
Capabilities never carry work status — maturity is stored ("where it stands"),
progress is always the rollup over realizing features.
"""

import uuid
from collections import defaultdict

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Capability, Feature, Goal, GoalType, Motivation, WorkStatus
from app.schemas.capability import (
    CapabilityCreate,
    CapabilityNode,
    CapabilityRead,
    CapabilityUpdate,
    HealthFinding,
    Rollup,
)
from app.schemas.feature import WhyChain, WhyStep

GA_OR_LATER = {"ga", "deprecated", "retired"}


async def list_capabilities(session: AsyncSession) -> list[Capability]:
    return list((await session.scalars(select(Capability).order_by(Capability.seq))).all())


async def get_capability(session: AsyncSession, capability_id: uuid.UUID) -> Capability:
    capability = await session.get(Capability, capability_id)
    if capability is None:
        raise HTTPException(404, "Capability not found")
    return capability


async def _forbid_forest_cycle(
    session: AsyncSession, capability_id: uuid.UUID, parent_id: uuid.UUID
) -> None:
    """parent_id chains must stay a forest — walk up from the new parent."""
    seen = set()
    cursor: uuid.UUID | None = parent_id
    while cursor is not None:
        if cursor == capability_id:
            raise HTTPException(422, "Re-parenting would create a containment cycle")
        if cursor in seen:  # pre-existing corruption; refuse to extend it
            raise HTTPException(422, "Containment chain already contains a cycle")
        seen.add(cursor)
        parent = await session.get(Capability, cursor)
        if parent is None:
            raise HTTPException(404, f"Capability {cursor} not found")
        cursor = parent.parent_id


async def create_capability(session: AsyncSession, data: CapabilityCreate) -> Capability:
    if data.parent_id is not None and await session.get(Capability, data.parent_id) is None:
        raise HTTPException(404, f"Capability {data.parent_id} not found")
    capability = Capability(**data.model_dump())
    session.add(capability)
    await session.commit()
    await session.refresh(capability)
    return capability


async def update_capability(
    session: AsyncSession, capability_id: uuid.UUID, data: CapabilityUpdate
) -> Capability:
    capability = await get_capability(session, capability_id)
    fields = data.model_dump(exclude_unset=True)
    if fields.get("parent_id") is not None:
        await _forbid_forest_cycle(session, capability_id, fields["parent_id"])
    for key, value in fields.items():
        setattr(capability, key, value)
    await session.commit()
    await session.refresh(capability)
    return capability


async def delete_capability(session: AsyncSession, capability_id: uuid.UUID) -> None:
    capability = await get_capability(session, capability_id)
    realizing = await session.scalar(
        select(func.count()).select_from(Feature).where(Feature.capability_id == capability_id)
    )
    if realizing:
        raise HTTPException(
            409,
            f"{realizing} feature(s) realize this capability — re-point or delete "
            "them first (features may not be orphaned).",
        )
    await session.delete(capability)
    await session.commit()


# ---- containment traversals ----

async def _children_index(session: AsyncSession) -> dict[uuid.UUID | None, list[Capability]]:
    index: dict[uuid.UUID | None, list[Capability]] = defaultdict(list)
    for capability in await list_capabilities(session):
        index[capability.parent_id].append(capability)
    return index


def _submap_ids(
    root_id: uuid.UUID, children: dict[uuid.UUID | None, list[Capability]]
) -> set[uuid.UUID]:
    ids = {root_id}
    stack = [root_id]
    while stack:
        for child in children.get(stack.pop(), []):
            if child.id not in ids:
                ids.add(child.id)
                stack.append(child.id)
    return ids


async def submap_ids(session: AsyncSession, capability_id: uuid.UUID) -> set[uuid.UUID]:
    await get_capability(session, capability_id)
    return _submap_ids(capability_id, await _children_index(session))


async def scope(session: AsyncSession, capability_id: uuid.UUID) -> list[Feature]:
    """All features realizing the capability or anything in its submap —
    exactly what a PRD epic snapshot freezes."""
    ids = await submap_ids(session, capability_id)
    stmt = select(Feature).where(Feature.capability_id.in_(ids)).order_by(Feature.seq)
    return list((await session.scalars(stmt)).all())


def _rollup(features: list[Feature]) -> Rollup:
    counts = {status: 0 for status in WorkStatus}
    for feature in features:
        counts[feature.status] += 1
    return Rollup(
        total=len(features),
        pending=counts[WorkStatus.pending],
        in_progress=counts[WorkStatus.in_progress],
        done=counts[WorkStatus.done],
    )


async def rollup(session: AsyncSession, capability_id: uuid.UUID) -> Rollup:
    return _rollup(await scope(session, capability_id))


async def capability_map(session: AsyncSession) -> list[CapabilityNode]:
    """The whole forest with an aggregated rollup per node (over its submap)."""
    children = await _children_index(session)
    features = list((await session.scalars(select(Feature))).all())
    by_capability: dict[uuid.UUID, list[Feature]] = defaultdict(list)
    for feature in features:
        by_capability[feature.capability_id].append(feature)

    def build(capability: Capability) -> CapabilityNode:
        in_scope = [
            f
            for cid in _submap_ids(capability.id, children)
            for f in by_capability.get(cid, [])
        ]
        return CapabilityNode(
            **CapabilityRead.model_validate(capability).model_dump(),
            rollup=_rollup(in_scope),
            children=[build(child) for child in children.get(capability.id, [])],
        )

    return [build(root) for root in children.get(None, [])]


# ---- mvp cut (prerequisite closure over the bridge) ----

async def mvp_cut(
    session: AsyncSession,
    graph,
    feature_ids: list[uuid.UUID],
    capability_ids: list[uuid.UUID],
) -> dict:
    """Essential vs deferrable relative to target features/capabilities.
    Capability targets expand to their whole scope — thin-slice MVPs should
    target features directly. The closure itself runs on the fast plane
    (graph.mvp_cut); this wrapper resolves targets and names capabilities."""
    target_ids: set[uuid.UUID] = set()
    for feature_id in feature_ids:
        if await session.get(Feature, feature_id) is None:
            raise HTTPException(404, f"Feature {feature_id} not found")
        target_ids.add(feature_id)
    for capability_id in capability_ids:
        target_ids.update(f.id for f in await scope(session, capability_id))
    if not target_ids:
        raise HTTPException(
            422,
            "Targets resolve to no features — the cut is computed over the "
            "feature plane; decompose the capability first.",
        )
    await graph.ensure_fresh()
    cut = graph.mvp_cut(target_ids)
    by_id = {c.id: c for c in await list_capabilities(session)}
    capabilities = [
        {
            "id": str(cid),
            "display_id": f"CAP-{by_id[cid].seq:03d}",
            "name": by_id[cid].name,
            "maturity": str(by_id[cid].maturity),
            "required": counts["required"],
            "total": counts["total"],
            "essential": counts["required"] > 0,
        }
        for cid, counts in cut["capabilities"].items()
        if cid in by_id
    ]
    capabilities.sort(key=lambda c: (not c["essential"], c["display_id"]))
    return {
        "targets": sorted(str(t) for t in target_ids),
        "essential": cut["essential"],
        "deferrable": cut["deferrable"],
        "capabilities": capabilities,
    }


# ---- why (provenance chain) ----

async def why(session: AsyncSession, feature: Feature) -> WhyChain:
    """f --REALIZES--> c --PART_OF*--> root, collecting MOTIVATES goals (and
    their org parents) at every capability on the path."""
    chain: list[WhyStep] = [
        WhyStep(
            kind="feature",
            id=feature.id,
            display_id=f"FTR-{feature.seq:03d}",
            name=feature.name,
            relation="",
        )
    ]
    seen_goals: set[uuid.UUID] = set()
    cursor: uuid.UUID | None = feature.capability_id
    relation = "REALIZES"
    guard: set[uuid.UUID] = set()
    while cursor is not None and cursor not in guard:
        guard.add(cursor)
        capability = await session.get(Capability, cursor)
        if capability is None:
            break
        chain.append(
            WhyStep(
                kind="capability",
                id=capability.id,
                display_id=f"CAP-{capability.seq:03d}",
                name=capability.name,
                relation=relation,
            )
        )
        motivations = await session.scalars(
            select(Motivation).where(Motivation.capability_id == capability.id)
        )
        for motivation in motivations:
            goal = await session.get(Goal, motivation.goal_id)
            goal_relation = "MOTIVATES"
            while goal is not None and goal.id not in seen_goals:
                seen_goals.add(goal.id)
                prefix = "OG" if goal.goal_type == GoalType.org else "PG"
                chain.append(
                    WhyStep(
                        kind="goal",
                        id=goal.id,
                        display_id=f"{prefix}-{goal.seq:02d}",
                        name=goal.title,
                        relation=goal_relation,
                    )
                )
                goal_relation = "parent"
                goal = (
                    await session.get(Goal, goal.parent_goal_id)
                    if goal.parent_goal_id
                    else None
                )
        cursor = capability.parent_id
        relation = "PART_OF"
    return WhyChain(feature_id=feature.id, chain=chain)


# ---- motivations ----

async def add_motivation(
    session: AsyncSession, capability_id: uuid.UUID, goal_id: uuid.UUID
) -> Motivation:
    await get_capability(session, capability_id)
    if await session.get(Goal, goal_id) is None:
        raise HTTPException(404, "Goal not found")
    existing = await session.scalar(
        select(Motivation).where(
            Motivation.capability_id == capability_id, Motivation.goal_id == goal_id
        )
    )
    if existing is not None:
        return existing
    motivation = Motivation(capability_id=capability_id, goal_id=goal_id)
    session.add(motivation)
    await session.commit()
    await session.refresh(motivation)
    return motivation


async def remove_motivation(
    session: AsyncSession, capability_id: uuid.UUID, goal_id: uuid.UUID
) -> None:
    motivation = await session.scalar(
        select(Motivation).where(
            Motivation.capability_id == capability_id, Motivation.goal_id == goal_id
        )
    )
    if motivation is None:
        raise HTTPException(404, "Motivation not found")
    await session.delete(motivation)
    await session.commit()


async def motivating_goals(session: AsyncSession, capability_id: uuid.UUID) -> list[Goal]:
    stmt = (
        select(Goal)
        .join(Motivation, Motivation.goal_id == Goal.id)
        .where(Motivation.capability_id == capability_id)
        .order_by(Goal.seq)
    )
    return list((await session.scalars(stmt)).all())


# ---- health (findings generators) ----

async def health(session: AsyncSession) -> list[HealthFinding]:
    findings: list[HealthFinding] = []
    children = await _children_index(session)
    capabilities = [c for group in children.values() for c in group]

    counts_by_capability: dict[uuid.UUID, int] = defaultdict(int)
    for capability_id, count in await session.execute(
        select(Feature.capability_id, func.count()).group_by(Feature.capability_id)
    ):
        counts_by_capability[capability_id] = count

    motivated = {
        m.capability_id for m in (await session.scalars(select(Motivation))).all()
    }
    goals_with_motivations = {
        m.goal_id for m in (await session.scalars(select(Motivation))).all()
    }

    for capability in capabilities:
        in_scope = sum(
            counts_by_capability.get(cid, 0)
            for cid in _submap_ids(capability.id, children)
        )
        if in_scope == 0 and str(capability.maturity) not in GA_OR_LATER:
            findings.append(
                HealthFinding(
                    kind="aspirational_gap",
                    subject_id=capability.id,
                    subject_display_id=f"CAP-{capability.seq:03d}",
                    subject_name=capability.name,
                    detail=f"maturity `{capability.maturity}` but no feature realizes it "
                    "— promised, nothing building toward it.",
                )
            )
        if capability.parent_id is None and not (
            _submap_ids(capability.id, children) & motivated
        ):
            findings.append(
                HealthFinding(
                    kind="unmotivated_capability",
                    subject_id=capability.id,
                    subject_display_id=f"CAP-{capability.seq:03d}",
                    subject_name=capability.name,
                    detail="no goal motivates this capability or anything under it "
                    "— why does it exist?",
                )
            )

    product_goals = await session.scalars(
        select(Goal).where(Goal.goal_type == GoalType.product)
    )
    for goal in product_goals:
        if goal.id not in goals_with_motivations:
            findings.append(
                HealthFinding(
                    kind="empty_intent",
                    subject_id=goal.id,
                    subject_display_id=f"PG-{goal.seq:02d}",
                    subject_name=goal.title,
                    detail="product goal motivates no capability — decompose or drop.",
                )
            )
    return findings
