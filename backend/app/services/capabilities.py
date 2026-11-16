"""Capability map (slow plane) — CRUD, containment forest, and the traversals
that cross the REALIZES bridge: submap, scope, rollup, capability impact,
why(feature), mvp_cut, and health findings.

The map is a forest stored relationally (parent_id): single parent, acyclic.
Capabilities never carry work status — maturity is stored ("where it stands"),
progress is always the rollup over realizing features.
"""

import uuid
from dataclasses import dataclass
from collections import defaultdict

from fastapi import HTTPException
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    Capability,
    CapabilityMaturity,
    Feature,
    FeatureCapability,
    Goal,
    GoalType,
    Motivation,
    Product,
    ProductBundle,
    TechSatisfaction,
    WorkStatus,
)
from app.schemas.capability import (
    CapabilityCreate,
    CapabilityMatch,
    CapabilityNeed,
    CapabilityNode,
    CapabilityRead,
    CapabilityUpdate,
    CoverageReport,
    CoverageRequest,
    FeatureCoverage,
    HealthFinding,
    IdeaFeature,
    InventoryEntry,
    ProductCoverage,
    ProductRef,
    Rollup,
)
from app.schemas.feature import WhyChain, WhyStep
from app.services.slugs import slugify, unique_slug

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
    fields = data.model_dump()
    fields["slug"] = await unique_slug(session, Capability, data.name, data.slug)
    capability = Capability(**fields)
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
        select(func.count())
        .select_from(FeatureCapability)
        .where(FeatureCapability.capability_id == capability_id)
    )
    if realizing:
        raise HTTPException(
            409,
            f"{realizing} feature(s) realize this capability — unlink or delete "
            "them first (a capability in use cannot vanish from under them).",
        )
    # Buy side of the same currency: tech_satisfactions.capability_id is
    # RESTRICT, mirroring the feature FK. Report it rather than let the FK raise.
    satisfying = await session.scalar(
        select(func.count())
        .select_from(TechSatisfaction)
        .where(TechSatisfaction.capability_id == capability_id)
    )
    if satisfying:
        raise HTTPException(
            409,
            f"{satisfying} technolog(ies) satisfy this capability — a capability "
            "with supply cannot be deleted out from under a stack.",
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
    """Our features realizing the capability or anything in its submap —
    exactly what a PRD epic snapshot freezes, and what progress rolls up over.
    External features are someone else's work. A feature realizing several
    capabilities in the submap appears once."""
    ids = await submap_ids(session, capability_id)
    realizing = select(FeatureCapability.feature_id).where(
        FeatureCapability.capability_id.in_(ids)
    )
    stmt = (
        select(Feature)
        .where(Feature.id.in_(realizing), ours_clause())
        .order_by(Feature.seq)
    )
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
    features = list((await session.scalars(select(Feature).where(ours_clause()))).all())
    by_capability: dict[uuid.UUID, list[Feature]] = defaultdict(list)
    for feature in features:
        for cid in feature.capability_ids:
            by_capability[cid].append(feature)

    def build(capability: Capability) -> CapabilityNode:
        # Dedup by id: a feature realizing two capabilities in one submap is
        # one feature of progress, not two.
        in_scope = list(
            {
                f.id: f
                for cid in _submap_ids(capability.id, children)
                for f in by_capability.get(cid, [])
            }.values()
        )
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
            "name": by_id[cid].name,
            "maturity": str(by_id[cid].maturity),
            "required": counts["required"],
            "total": counts["total"],
            "essential": counts["required"] > 0,
        }
        for cid, counts in cut["capabilities"].items()
        if cid in by_id
    ]
    capabilities.sort(key=lambda c: (not c["essential"], c["name"]))
    return {
        "targets": sorted(str(t) for t in target_ids),
        "essential": cut["essential"],
        "deferrable": cut["deferrable"],
        "capabilities": capabilities,
    }


# ---- why (provenance chain) ----

async def why(session: AsyncSession, feature: Feature) -> WhyChain:
    """f --REALIZES--> c --PART_OF*--> root, for every capability f realizes,
    collecting MOTIVATES goals (and their org parents) at each capability on
    the way. One flat chain: each REALIZES step opens a branch, and a parent
    or goal two branches share appears once."""
    chain: list[WhyStep] = [
        WhyStep(kind="feature", id=feature.id, name=feature.name, relation="")
    ]
    seen_goals: set[uuid.UUID] = set()
    seen_capabilities: set[uuid.UUID] = set()
    for start in feature.capability_ids:
        cursor: uuid.UUID | None = start
        relation = "REALIZES"
        while cursor is not None and cursor not in seen_capabilities:
            seen_capabilities.add(cursor)
            capability = await session.get(Capability, cursor)
            if capability is None:
                break
            chain.append(
                WhyStep(
                    kind="capability",
                    id=capability.id,
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


async def bundled_capabilities(
    session: AsyncSession, product_id: uuid.UUID
) -> list[Capability]:
    stmt = (
        select(Capability)
        .join(ProductBundle, ProductBundle.capability_id == Capability.id)
        .where(ProductBundle.product_id == product_id)
        .order_by(Capability.seq)
    )
    return list((await session.scalars(stmt)).all())


async def bundle_product(
    session: AsyncSession, product_id: uuid.UUID, capability_id: uuid.UUID
) -> ProductBundle:
    if await session.get(Product, product_id) is None:
        raise HTTPException(404, "Product not found")
    if await session.get(Capability, capability_id) is None:
        raise HTTPException(404, "Capability not found")
    existing = await session.scalar(
        select(ProductBundle).where(
            ProductBundle.product_id == product_id,
            ProductBundle.capability_id == capability_id,
        )
    )
    if existing is not None:
        return existing
    bundle = ProductBundle(product_id=product_id, capability_id=capability_id)
    session.add(bundle)
    await session.commit()
    await session.refresh(bundle)
    return bundle


async def unbundle_product(
    session: AsyncSession, product_id: uuid.UUID, capability_id: uuid.UUID
) -> None:
    bundle = await session.scalar(
        select(ProductBundle).where(
            ProductBundle.product_id == product_id,
            ProductBundle.capability_id == capability_id,
        )
    )
    if bundle is None:
        raise HTTPException(404, "Bundle not found")
    await session.delete(bundle)
    await session.commit()


# ---- inventory & coverage ----

PROVEN = {CapabilityMaturity.beta, CapabilityMaturity.ga}


def name_closeness(column, name: str):
    """How near a stored name is to a typed one, for suggestions only. Plain
    trigram similarity misses abbreviations ("Auth" vs "Authentication" is
    0.25), so take the best of it and word similarity in both directions."""
    return func.greatest(
        func.similarity(column, name),
        func.word_similarity(name, column),
        func.word_similarity(column, name),
    )


def ours_clause():
    """The one rule for "ours": a feature is ours unless its product is
    external. A feature with no product is internal work, so ours."""
    return or_(
        Feature.product_id.is_(None),
        Feature.product_id.in_(select(Product.id).where(Product.external.is_(False))),
    )


@dataclass(frozen=True)
class Usage:
    """Who realizes a capability, over its submap. `ours` is the inventory's
    whole question: false only when features realize it and every one of them
    belongs to an external product — then we know it exists, not that we have it."""

    products: list[ProductRef]
    external_products: list[ProductRef]
    features: int  # our features only
    ours: bool


async def _usage(session: AsyncSession) -> dict[uuid.UUID, Usage]:
    """Per capability, over its submap. A parent is in use wherever any of its
    children is."""
    children = await _children_index(session)
    by_id = {p.id: p for p in (await session.scalars(select(Product))).all()}
    ours_f: dict[uuid.UUID, set[uuid.UUID]] = defaultdict(set)
    ext_f: dict[uuid.UUID, set[uuid.UUID]] = defaultdict(set)
    ours_p: dict[uuid.UUID, set[uuid.UUID]] = defaultdict(set)
    ext_p: dict[uuid.UUID, set[uuid.UUID]] = defaultdict(set)
    rows = await session.execute(
        select(FeatureCapability.capability_id, Feature.id, Feature.product_id).join(
            Feature, Feature.id == FeatureCapability.feature_id
        )
    )
    for capability_id, feature_id, product_id in rows:
        external = product_id is not None and by_id[product_id].external
        (ext_f if external else ours_f)[capability_id].add(feature_id)
        if product_id is not None:
            (ext_p if external else ours_p)[capability_id].add(product_id)

    def gather(index, submap):
        return set().union(*(index.get(cid, set()) for cid in submap))

    usage: dict[uuid.UUID, Usage] = {}
    for capability in (c for group in children.values() for c in group):
        submap = _submap_ids(capability.id, children)
        ours_features = gather(ours_f, submap)
        external_features = gather(ext_f, submap)
        usage[capability.id] = Usage(
            products=_refs(gather(ours_p, submap), by_id),
            external_products=_refs(gather(ext_p, submap), by_id),
            features=len(ours_features),
            ours=bool(ours_features) or not external_features,
        )
    return usage


def _refs(ids: set[uuid.UUID], by_id: dict[uuid.UUID, Product]) -> list[ProductRef]:
    return sorted(
        (ProductRef.model_validate(by_id[pid]) for pid in ids if pid in by_id),
        key=lambda p: p.name,
    )


async def inventory(session: AsyncSession) -> list[InventoryEntry]:
    """Everything we can already do, most-reused first, then what we only know
    from external products: the raw material for the next product."""
    usage = await _usage(session)
    entries = [
        InventoryEntry(
            **CapabilityRead.model_validate(c).model_dump(),
            ours=usage[c.id].ours,
            products=usage[c.id].products,
            external_products=usage[c.id].external_products,
            features=usage[c.id].features,
        )
        for c in await list_capabilities(session)
    ]
    entries.sort(
        key=lambda e: (
            not e.ours,
            -len(e.products),
            -e.features,
            -len(e.external_products),
            e.name.lower(),
        )
    )
    return entries


async def coverage(session: AsyncSession, request: CoverageRequest) -> CoverageReport:
    """How much of a product idea we already have. Needs resolve by exact slug
    only — a wrong match would overstate what we have, which is worse than an
    honest gap — and every unresolved need lists near names to confirm. A
    capability known only from external products resolves (so you see who has
    it) but counts as missing: knowing it exists is not having it."""
    capabilities = await list_capabilities(session)
    by_slug = {c.slug: c for c in capabilities}
    usage = await _usage(session)

    def as_match(c: Capability) -> CapabilityMatch:
        u = usage[c.id]
        return CapabilityMatch(
            id=c.id,
            slug=c.slug,
            name=c.name,
            maturity=c.maturity,
            ours=u.ours,
            products=u.products,
            external_products=u.external_products,
        )

    async def candidates(name: str) -> list[CapabilityMatch]:
        score = name_closeness(Capability.name, name)
        stmt = (
            select(Capability)
            .where(score > 0.3)
            .order_by(score.desc(), Capability.seq)
            .limit(3)
        )
        return [as_match(c) for c in await session.scalars(stmt)]

    features: list[FeatureCoverage] = []
    seen: dict[str, Capability | None] = {}
    for idea in request.features:
        needs: list[CapabilityNeed] = []
        for name in dict.fromkeys(n.strip() for n in idea.capabilities if n.strip()):
            key = slugify(name)
            found = by_slug.get(key)
            seen.setdefault(key, found)
            needs.append(
                CapabilityNeed(
                    name=name,
                    match=as_match(found) if found else None,
                    candidates=[] if found else await candidates(name),
                )
            )
        features.append(
            FeatureCoverage(
                name=idea.name,
                capabilities=needs,
                existing=sum(1 for n in needs if n.match and n.match.ours),
                total=len(needs),
            )
        )

    # Maturity describes our implementation, so only ours can be proven.
    found_caps = [c for c in seen.values() if c is not None and usage[c.id].ours]
    missing: dict[str, str] = {}
    for f in features:
        for n in f.capabilities:
            if n.match is None or not n.match.ours:
                missing.setdefault(slugify(n.name), n.name)
    return CoverageReport(
        features=features,
        needed=len(seen),
        existing=len(found_caps),
        mature=sum(1 for c in found_caps if c.maturity in PROVEN),
        missing=list(missing.values()),
    )


# ---- health (findings generators) ----

async def health(session: AsyncSession) -> list[HealthFinding]:
    findings: list[HealthFinding] = []
    children = await _children_index(session)
    capabilities = [c for group in children.values() for c in group]

    counts_by_capability: dict[uuid.UUID, int] = defaultdict(int)
    for capability_id, count in await session.execute(
        select(FeatureCapability.capability_id, func.count()).group_by(
            FeatureCapability.capability_id
        )
    ):
        counts_by_capability[capability_id] = count

    # The schema cannot refuse a feature with no capability (the link table
    # can only add rows), so the invariant is checked here as well as on write.
    unlinked = await session.scalars(
        select(Feature)
        .where(
            Feature.id.notin_(select(FeatureCapability.feature_id)),
            Feature.unknown_capabilities.is_(False),
        )
        .order_by(Feature.seq)
    )
    for feature in unlinked:
        findings.append(
            HealthFinding(
                kind="unlinked_feature",
                subject_id=feature.id,
                subject_name=feature.name,
                detail="realizes no capability — the inventory cannot see what it was built on.",
            )
        )

    motivated = {
        m.capability_id for m in (await session.scalars(select(Motivation))).all()
    }
    goals_with_motivations = {
        m.goal_id for m in (await session.scalars(select(Motivation))).all()
    }

    usage = await _usage(session)
    for capability in capabilities:
        # Known only from someone else's product: not our promise to keep.
        if not usage[capability.id].ours:
            continue
        in_scope = sum(
            counts_by_capability.get(cid, 0)
            for cid in _submap_ids(capability.id, children)
        )
        if in_scope == 0 and str(capability.maturity) not in GA_OR_LATER:
            findings.append(
                HealthFinding(
                    kind="aspirational_gap",
                    subject_id=capability.id,
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


async def score_items(
    session: AsyncSession, items: list[tuple[str, list[str]]]
) -> tuple[CoverageReport | None, list[FeatureCoverage | None]]:
    """Run (name, capability names) items through coverage() and hand each item
    its own FeatureCoverage by position — never by name, since two items may
    share one. Items naming no capability get None and stay out of the report."""
    indices = [i for i, (_, caps) in enumerate(items) if any(c.strip() for c in caps)]
    scored: list[FeatureCoverage | None] = [None] * len(items)
    if not indices:
        return None, scored
    report = await coverage(
        session,
        CoverageRequest(
            features=[IdeaFeature(name=items[i][0], capabilities=items[i][1]) for i in indices]
        ),
    )
    for k, i in enumerate(indices):
        scored[i] = report.features[k]
    return report, scored


async def product_coverage(session: AsyncSession, product_id: uuid.UUID) -> ProductCoverage:
    """Score a product against our inventory — derived from coverage(), never a
    second computation: its features become the idea, its links the needs."""
    product = await session.get(Product, product_id)
    if product is None:
        raise HTTPException(404, "Product not found")
    features = list(
        await session.scalars(
            select(Feature).where(Feature.product_id == product_id).order_by(Feature.seq)
        )
    )
    names = {c.id: c.name for c in await list_capabilities(session)}
    report, scored = await score_items(
        session, [(f.name, [names[c] for c in f.capability_ids]) for f in features]
    )
    covered = {i for i, fc in enumerate(scored) if fc is not None and fc.existing == fc.total}
    return ProductCoverage(
        product=ProductRef.model_validate(product),
        total_features=len(features),
        buildable=[
            f.name for i, f in enumerate(features) if i in covered and not f.unknown_capabilities
        ],
        unknown_features=[f.name for f in features if f.unknown_capabilities],
        known_covered=[
            f.name for f in features if f.name in covered and f.unknown_capabilities
        ],
        report=report,
    )
