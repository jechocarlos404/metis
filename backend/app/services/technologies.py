"""Buy plane — the world catalog, the group's stance on it, and the hinge that
joins it to the capability map.

The organising idea: Capability is the exchange currency. A Feature REALIZES a
capability (the build side); a Technology SATISFIES one (the buy side). Same
node, same currency — which is what turns build-vs-buy from a meeting into a
query.

Nothing derived is stored. Exposure, ranking and redundancy are recomputed on
every request; a number that can be recomputed must be, or it goes stale the
way a mirrored graph does.
"""

import uuid
from collections import defaultdict
from datetime import date, timedelta

import networkx as nx
from fastapi import HTTPException
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    Adoption,
    AdoptionStatus,
    Capability,
    Constraint,
    ConstraintScope,
    ConstraintSeverity,
    Encounter,
    EncounterDepth,
    Product,
    ProductTechnology,
    StackSlot,
    TechEdge,
    TechEdgeKind,
    TechFit,
    TechSatisfaction,
    Technology,
    TechVersion,
    Vendor,
)
from app.schemas.technology import (
    AdoptionWrite,
    EncounterCreate,
    Exposure,
    Offer,
    ProductBreak,
    SatisfactionCreate,
    SatisfactionUpdate,
    TechEdgeCreate,
    TechnologyCreate,
    TechnologyUpdate,
    VendorCreate,
    VendorUpdate,
    VersionCreate,
    VersionUpdate,
)

#: The promotion/demotion ramp, best first. Used for ordering, never stored.
ADOPTION_RANK = [
    AdoptionStatus.standard,
    AdoptionStatus.adopted,
    AdoptionStatus.trial,
    AdoptionStatus.candidate,
    AdoptionStatus.contained,
    AdoptionStatus.deprecated,
    AdoptionStatus.banned,
]
FIT_RANK = [TechFit.native, TechFit.partial, TechFit.workaround]
DEPTH_RANK = [EncounterDepth.evaluated, EncounterDepth.touched, EncounterDepth.shipped]

#: REQUIRES ∪ RUNS_ON is jointly acyclic. ALTERNATIVE_TO is symmetric and
#: SUPERSEDES/WRAPS annotate; none of them participate in the cycle check.
ACYCLIC_KINDS = {TechEdgeKind.REQUIRES, TechEdgeKind.RUNS_ON}

#: A release line inside this window counts as exposure, not as a surprise.
EOL_HORIZON = timedelta(days=180)


def _rank(order: list, value) -> int:
    return order.index(value) if value in order else len(order)


# ---- vendors ----

async def list_vendors(session: AsyncSession) -> list[Vendor]:
    return list((await session.scalars(select(Vendor).order_by(Vendor.seq))).all())


async def get_vendor(session: AsyncSession, vendor_id: uuid.UUID) -> Vendor:
    vendor = await session.get(Vendor, vendor_id)
    if vendor is None:
        raise HTTPException(404, "Vendor not found")
    return vendor


async def create_vendor(session: AsyncSession, data: VendorCreate) -> Vendor:
    vendor = Vendor(**data.model_dump())
    session.add(vendor)
    await session.commit()
    await session.refresh(vendor)
    return vendor


async def update_vendor(
    session: AsyncSession, vendor_id: uuid.UUID, data: VendorUpdate
) -> Vendor:
    vendor = await get_vendor(session, vendor_id)
    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(vendor, key, value)
    await session.commit()
    await session.refresh(vendor)
    return vendor


async def delete_vendor(session: AsyncSession, vendor_id: uuid.UUID) -> None:
    await session.delete(await get_vendor(session, vendor_id))
    await session.commit()


# ---- technologies ----

async def get_technology(session: AsyncSession, tech_id: uuid.UUID) -> Technology:
    technology = await session.get(Technology, tech_id)
    if technology is None:
        raise HTTPException(404, "Technology not found")
    return technology


async def create_technology(session: AsyncSession, data: TechnologyCreate) -> Technology:
    if data.vendor_id is not None:
        await get_vendor(session, data.vendor_id)
    if await session.scalar(select(Technology).where(Technology.slug == data.slug)):
        raise HTTPException(409, f"Technology slug `{data.slug}` already exists")
    technology = Technology(**data.model_dump())
    session.add(technology)
    await session.commit()
    await session.refresh(technology)
    return technology


async def update_technology(
    session: AsyncSession, tech_id: uuid.UUID, data: TechnologyUpdate
) -> Technology:
    technology = await get_technology(session, tech_id)
    fields = data.model_dump(exclude_unset=True)
    if fields.get("vendor_id") is not None:
        await get_vendor(session, fields["vendor_id"])
    slug = fields.get("slug")
    if slug is not None and slug != technology.slug:
        # slug is referenced by every join a human writes; renaming is deliberate.
        if await session.scalar(select(Technology).where(Technology.slug == slug)):
            raise HTTPException(409, f"Technology slug `{slug}` already exists")
    for key, value in fields.items():
        setattr(technology, key, value)
    await session.commit()
    await session.refresh(technology)
    return technology


async def delete_technology(session: AsyncSession, tech_id: uuid.UUID) -> None:
    technology = await get_technology(session, tech_id)
    bound = await session.scalar(
        select(func.count()).select_from(StackSlot).where(StackSlot.tech_id == tech_id)
    )
    if bound:
        raise HTTPException(
            409,
            f"{bound} stack slot(s) bind this technology — unbind them first "
            "(unbinding reopens the gap, which is the point).",
        )
    await session.delete(technology)
    await session.commit()


async def _satisfies_index(session: AsyncSession) -> dict[uuid.UUID, list[str]]:
    stmt = (
        select(TechSatisfaction.tech_id, Capability.name)
        .join(Capability, Capability.id == TechSatisfaction.capability_id)
        .order_by(Capability.name)
    )
    index: dict[uuid.UUID, list[str]] = defaultdict(list)
    for tech_id, name in await session.execute(stmt):
        index[tech_id].append(name)
    return index


async def _usage_counts(session: AsyncSession) -> dict[uuid.UUID, int]:
    stmt = select(ProductTechnology.tech_id, func.count()).group_by(ProductTechnology.tech_id)
    return {tech_id: count for tech_id, count in await session.execute(stmt)}


async def _adoption_index(session: AsyncSession) -> dict[uuid.UUID, Adoption]:
    return {a.tech_id: a for a in (await session.scalars(select(Adoption))).all()}


async def catalog(
    session: AsyncSession,
    q: str | None = None,
    kind: str | None = None,
    layer: str | None = None,
    adoption: str | None = None,
    limit: int = 50,
    offset: int = 0,
) -> dict:
    """The /tech page: faceted, paginated, and never unbounded — the catalog is
    world-scope, so an unfiltered full read is a mistake, not a convenience.

    kind and layer are orthogonal facets, not a hierarchy; facet_counts are
    computed over the same filter minus the facet being counted, so a chip
    never reports zero for something it would itself reveal."""
    adoptions = await _adoption_index(session)

    def matches(t: Technology, *, skip: str | None = None) -> bool:
        stance = adoptions.get(t.id)
        if q and q.lower() not in t.name.lower() and q.lower() not in t.slug.lower():
            return False
        if skip != "kind" and kind and str(t.kind) != kind:
            return False
        if skip != "layer" and layer and str(t.layer or "") != layer:
            return False
        if skip != "adoption" and adoption:
            # `none` is a real filter: no stance taken is a meaningful answer.
            if adoption == "none":
                return stance is None
            if stance is None or str(stance.status) != adoption:
                return False
        return True

    all_rows = list(
        (await session.scalars(select(Technology).order_by(Technology.slug))).all()
    )
    matched = [t for t in all_rows if matches(t)]

    facet_counts: dict[str, dict[str, int]] = {"kind": {}, "layer": {}, "adoption": {}}
    for t in all_rows:
        if matches(t, skip="kind"):
            facet_counts["kind"][str(t.kind)] = facet_counts["kind"].get(str(t.kind), 0) + 1
        if matches(t, skip="layer") and t.layer is not None:
            facet_counts["layer"][str(t.layer)] = facet_counts["layer"].get(str(t.layer), 0) + 1
        if matches(t, skip="adoption"):
            stance = adoptions.get(t.id)
            key = str(stance.status) if stance else "none"
            facet_counts["adoption"][key] = facet_counts["adoption"].get(key, 0) + 1

    page = matched[offset : offset + limit]
    satisfies = await _satisfies_index(session)
    used_by = await _usage_counts(session)
    rows = [
        {
            "technology": t,
            "adoption": adoptions[t.id].status if t.id in adoptions else None,
            "satisfies": satisfies.get(t.id, []),
            "used_by": used_by.get(t.id, 0),
        }
        for t in page
    ]
    return {"rows": rows, "total": len(matched), "facet_counts": facet_counts}


async def detail(session: AsyncSession, tech_id: uuid.UUID) -> dict:
    technology = await get_technology(session, tech_id)
    adoptions = await _adoption_index(session)
    edges = list(
        (
            await session.scalars(
                select(TechEdge).where(
                    or_(TechEdge.src_id == tech_id, TechEdge.dst_id == tech_id)
                )
            )
        ).all()
    )
    return {
        "technology": technology,
        "adoption": adoptions[tech_id].status if tech_id in adoptions else None,
        "satisfies": (await _satisfies_index(session)).get(tech_id, []),
        "used_by": (await _usage_counts(session)).get(tech_id, 0),
        "vendor": (
            await session.get(Vendor, technology.vendor_id) if technology.vendor_id else None
        ),
        "versions": list(
            (
                await session.scalars(
                    select(TechVersion)
                    .where(TechVersion.tech_id == tech_id)
                    .order_by(TechVersion.label)
                )
            ).all()
        ),
        "satisfactions": await list_satisfactions(session, tech_id=tech_id),
        "outgoing": [e for e in edges if e.src_id == tech_id],
        "incoming": [e for e in edges if e.dst_id == tech_id],
        "encounters": await list_encounters(session, tech_id),
    }


# ---- versions ----

async def list_versions(session: AsyncSession, tech_id: uuid.UUID) -> list[TechVersion]:
    await get_technology(session, tech_id)
    stmt = (
        select(TechVersion).where(TechVersion.tech_id == tech_id).order_by(TechVersion.label)
    )
    return list((await session.scalars(stmt)).all())


async def create_version(
    session: AsyncSession, tech_id: uuid.UUID, data: VersionCreate
) -> TechVersion:
    await get_technology(session, tech_id)
    existing = await session.scalar(
        select(TechVersion).where(
            TechVersion.tech_id == tech_id, TechVersion.label == data.label
        )
    )
    if existing is not None:
        raise HTTPException(409, f"Version `{data.label}` already recorded")
    version = TechVersion(tech_id=tech_id, **data.model_dump())
    session.add(version)
    await session.commit()
    await session.refresh(version)
    return version


async def update_version(
    session: AsyncSession, version_id: uuid.UUID, data: VersionUpdate
) -> TechVersion:
    version = await session.get(TechVersion, version_id)
    if version is None:
        raise HTTPException(404, "Version not found")
    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(version, key, value)
    await session.commit()
    await session.refresh(version)
    return version


async def delete_version(session: AsyncSession, version_id: uuid.UUID) -> None:
    version = await session.get(TechVersion, version_id)
    if version is None:
        raise HTTPException(404, "Version not found")
    await session.delete(version)
    await session.commit()


# ---- adoption (the group's stance) ----

async def get_adoption(session: AsyncSession, tech_id: uuid.UUID) -> Adoption | None:
    return await session.scalar(select(Adoption).where(Adoption.tech_id == tech_id))


async def set_adoption(
    session: AsyncSession, tech_id: uuid.UUID, data: AdoptionWrite
) -> Adoption:
    """Upsert — there is exactly one stance per technology."""
    await get_technology(session, tech_id)
    adoption = await get_adoption(session, tech_id)
    if adoption is None:
        adoption = Adoption(tech_id=tech_id, **data.model_dump())
        session.add(adoption)
    else:
        for key, value in data.model_dump().items():
            setattr(adoption, key, value)
    await session.commit()
    await session.refresh(adoption)
    return adoption


async def clear_adoption(session: AsyncSession, tech_id: uuid.UUID) -> None:
    """Withdraw the stance. The absent row means "no stance taken" — it is not
    a demotion to `candidate`, and nothing may backfill it."""
    adoption = await get_adoption(session, tech_id)
    if adoption is None:
        raise HTTPException(404, "No stance recorded for this technology")
    await session.delete(adoption)
    await session.commit()


# ---- satisfactions (the hinge) ----

async def list_satisfactions(
    session: AsyncSession,
    tech_id: uuid.UUID | None = None,
    capability_id: uuid.UUID | None = None,
) -> list[TechSatisfaction]:
    stmt = select(TechSatisfaction).order_by(TechSatisfaction.seq)
    if tech_id is not None:
        stmt = stmt.where(TechSatisfaction.tech_id == tech_id)
    if capability_id is not None:
        stmt = stmt.where(TechSatisfaction.capability_id == capability_id)
    return list((await session.scalars(stmt)).all())


async def create_satisfaction(
    session: AsyncSession, data: SatisfactionCreate
) -> TechSatisfaction:
    await get_technology(session, data.tech_id)
    if await session.get(Capability, data.capability_id) is None:
        raise HTTPException(404, "Capability not found")
    existing = await session.scalar(
        select(TechSatisfaction).where(
            TechSatisfaction.tech_id == data.tech_id,
            TechSatisfaction.capability_id == data.capability_id,
        )
    )
    if existing is not None:
        raise HTTPException(409, "This technology already satisfies that capability")
    satisfaction = TechSatisfaction(**data.model_dump())
    session.add(satisfaction)
    await session.commit()
    await session.refresh(satisfaction)
    return satisfaction


async def update_satisfaction(
    session: AsyncSession, satisfaction_id: uuid.UUID, data: SatisfactionUpdate
) -> TechSatisfaction:
    satisfaction = await session.get(TechSatisfaction, satisfaction_id)
    if satisfaction is None:
        raise HTTPException(404, "Satisfaction not found")
    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(satisfaction, key, value)
    await session.commit()
    await session.refresh(satisfaction)
    return satisfaction


async def delete_satisfaction(session: AsyncSession, satisfaction_id: uuid.UUID) -> None:
    satisfaction = await session.get(TechSatisfaction, satisfaction_id)
    if satisfaction is None:
        raise HTTPException(404, "Satisfaction not found")
    await session.delete(satisfaction)
    await session.commit()


# ---- tech edges ----

async def list_edges(session: AsyncSession) -> list[TechEdge]:
    return list((await session.scalars(select(TechEdge))).all())


async def _would_create_cycle(
    session: AsyncSession, src_id: uuid.UUID, dst_id: uuid.UUID
) -> bool:
    """Write-time guard over REQUIRES ∪ RUNS_ON. Built from SQL per call rather
    than from a cached graph: the buy plane runs no topo order, ready set or
    cut, so there is nothing to keep warm and nothing to go stale."""
    stmt = select(TechEdge.src_id, TechEdge.dst_id).where(TechEdge.kind.in_(ACYCLIC_KINDS))
    g = nx.DiGraph()
    g.add_edges_from(await session.execute(stmt))
    if not (g.has_node(src_id) and g.has_node(dst_id)):
        return False
    # Adding src -> dst closes a cycle iff dst already reaches src.
    return nx.has_path(g, dst_id, src_id)


async def create_edge(session: AsyncSession, data: TechEdgeCreate) -> TechEdge:
    if data.src_id == data.dst_id:
        raise HTTPException(422, "An edge cannot connect a technology to itself")
    await get_technology(session, data.src_id)
    await get_technology(session, data.dst_id)
    if data.kind in ACYCLIC_KINDS and await _would_create_cycle(
        session, data.src_id, data.dst_id
    ):
        raise HTTPException(
            422,
            f"{data.kind} edge would create a cycle in REQUIRES ∪ RUNS_ON — "
            "break the existing chain first.",
        )
    existing = await session.scalar(
        select(TechEdge).where(
            TechEdge.src_id == data.src_id,
            TechEdge.dst_id == data.dst_id,
            TechEdge.kind == data.kind,
        )
    )
    if existing is not None:
        return existing
    edge = TechEdge(**data.model_dump())
    session.add(edge)
    await session.commit()
    await session.refresh(edge)
    return edge


async def delete_edge(session: AsyncSession, edge_id: uuid.UUID) -> None:
    edge = await session.get(TechEdge, edge_id)
    if edge is None:
        raise HTTPException(404, "Edge not found")
    await session.delete(edge)
    await session.commit()


# ---- encounters ----

async def list_encounters(session: AsyncSession, tech_id: uuid.UUID) -> list[Encounter]:
    """Question 5: who here has touched this. Who, how deep, how recently —
    enough to know who to ask, and deliberately no more."""
    rows = list(
        (
            await session.scalars(select(Encounter).where(Encounter.tech_id == tech_id))
        ).all()
    )
    rows.sort(key=lambda e: (-_rank(DEPTH_RANK, e.depth), -e.last_at.toordinal()))
    return rows


async def create_encounter(session: AsyncSession, data: EncounterCreate) -> Encounter:
    await get_technology(session, data.tech_id)
    if data.product_id is not None and await session.get(Product, data.product_id) is None:
        raise HTTPException(404, "Product not found")
    existing = await session.scalar(
        select(Encounter).where(
            Encounter.tech_id == data.tech_id,
            Encounter.person == data.person,
            Encounter.product_id == data.product_id,
        )
    )
    if existing is not None:
        existing.depth = data.depth
        existing.last_at = data.last_at
        await session.commit()
        await session.refresh(existing)
        return existing
    encounter = Encounter(**data.model_dump())
    session.add(encounter)
    await session.commit()
    await session.refresh(encounter)
    return encounter


async def delete_encounter(session: AsyncSession, encounter_id: uuid.UUID) -> None:
    encounter = await session.get(Encounter, encounter_id)
    if encounter is None:
        raise HTTPException(404, "Encounter not found")
    await session.delete(encounter)
    await session.commit()


# ---- the questions ----

async def dependents(session: AsyncSession, tech_id: uuid.UUID) -> list[ProductBreak]:
    """Question 2: which products break if we drop this. required is a break,
    optional is an inconvenience, and off_stack means the dependency was never
    declared in the first place."""
    await get_technology(session, tech_id)
    stmt = (
        select(Product, StackSlot)
        .select_from(ProductTechnology)
        .join(Product, Product.id == ProductTechnology.product_id)
        .outerjoin(StackSlot, StackSlot.id == ProductTechnology.via_slot_id)
        .where(ProductTechnology.tech_id == tech_id)
    )
    breaks = [
        ProductBreak(
            product_id=product.id,
            product=product.name,
            slot_id=slot.id if slot else None,
            layer=slot.layer if slot else None,
            role=slot.role if slot else None,
            required=bool(slot.required) if slot else False,
            off_stack=slot is None,
        )
        for product, slot in await session.execute(stmt)
    ]
    breaks.sort(key=lambda b: (not b.required, not b.off_stack, b.product))
    return breaks


async def exposure(session: AsyncSession, today: date | None = None) -> list[Exposure]:
    """Question 3, as a view would be: three independent death modes, each
    sufficient on its own. A stance of `deprecated` with no version rows still
    surfaces — the modes do not depend on each other."""
    today = today or date.today()
    horizon = today + EOL_HORIZON

    adoptions = await _adoption_index(session)
    vendors = {v.id: v for v in (await session.scalars(select(Vendor))).all()}
    soonest: dict[uuid.UUID, TechVersion] = {}
    for version in await session.scalars(
        select(TechVersion).where(TechVersion.eol_on.is_not(None))
    ):
        current = soonest.get(version.tech_id)
        if current is None or version.eol_on < current.eol_on:
            soonest[version.tech_id] = version

    products: dict[uuid.UUID, int] = {}
    required_slots: dict[uuid.UUID, int] = {}
    slots = {s.id: s for s in (await session.scalars(select(StackSlot))).all()}
    seen: set[tuple[uuid.UUID, uuid.UUID]] = set()
    for usage in await session.scalars(select(ProductTechnology)):
        if (usage.tech_id, usage.product_id) not in seen:
            seen.add((usage.tech_id, usage.product_id))
            products[usage.tech_id] = products.get(usage.tech_id, 0) + 1
        slot = slots.get(usage.via_slot_id) if usage.via_slot_id else None
        if slot is not None and slot.required:
            required_slots[usage.tech_id] = required_slots.get(usage.tech_id, 0) + 1

    findings: list[Exposure] = []
    for technology in await session.scalars(select(Technology).order_by(Technology.slug)):
        stance = adoptions.get(technology.id)
        version = soonest.get(technology.id)
        vendor = vendors.get(technology.vendor_id) if technology.vendor_id else None
        reasons = []
        if stance is not None and stance.status in (
            AdoptionStatus.deprecated,
            AdoptionStatus.banned,
        ):
            reasons.append("stance")
        if version is not None and version.eol_on < horizon:
            reasons.append("eol")
        if vendor is not None and vendor.bus_factor == 1:
            reasons.append("bus_factor")
        if not reasons:
            continue
        findings.append(
            Exposure(
                tech_id=technology.id,
                slug=technology.slug,
                reasons=reasons,
                version=version.label if version else None,
                eol_on=version.eol_on if version else None,
                stance=stance.status if stance else None,
                bus_factor=vendor.bus_factor if vendor else None,
                products=products.get(technology.id, 0),
                required_slots=required_slots.get(technology.id, 0),
            )
        )
    findings.sort(key=lambda e: (-e.required_slots, -e.products, e.slug))
    return findings


async def _blocking_constraints(
    session: AsyncSession,
    product_id: uuid.UUID | None,
    stack_id: uuid.UUID | None,
) -> list[Constraint]:
    """Constraints in scope: global (both scope columns null), plus any scoped
    to this product or this stack."""
    stmt = (
        select(Constraint, ConstraintScope)
        .join(ConstraintScope, ConstraintScope.constraint_id == Constraint.id)
    )
    in_scope = []
    for constraint, scope in await session.execute(stmt):
        if scope.product_id is None and scope.stack_id is None:
            in_scope.append(constraint)
        elif product_id is not None and scope.product_id == product_id:
            in_scope.append(constraint)
        elif stack_id is not None and scope.stack_id == stack_id:
            in_scope.append(constraint)
    return in_scope


def _violates(constraint: Constraint, technology: Technology) -> bool:
    """One expression shape: {"field": <facet key>, "not_in": [...]}. Anything
    else is ignored rather than guessed at — a general expression language is
    the trap this deliberately does not walk into."""
    expression = constraint.expression or {}
    field = expression.get("field")
    forbidden = expression.get("not_in")
    if not field or not isinstance(forbidden, list):
        return False
    return (technology.facets or {}).get(field) in forbidden


async def offers(
    session: AsyncSession,
    capability_id: uuid.UUID,
    product_id: uuid.UUID | None = None,
    stack_id: uuid.UUID | None = None,
) -> list[Offer]:
    """Question 1, and steps 3–5 of the stack recommendation: every technology
    that satisfies this capability, pruned by blocking constraints and ranked.

    The ordering is fit, then the group's stance, then prior experience, then
    ops burden, then slug. All of it is computed — if the ordering came out of a
    prompt nobody could audit it, and the same question would answer differently
    on Tuesday.

    A technology with no adoption row is still a valid answer; that LEFT join is
    how the world catalog earns its keep."""
    if await session.get(Capability, capability_id) is None:
        raise HTTPException(404, "Capability not found")

    adoptions = await _adoption_index(session)
    constraints = await _blocking_constraints(session, product_id, stack_id)
    depth_by_tech: dict[uuid.UUID, EncounterDepth] = {}
    for encounter in await session.scalars(select(Encounter)):
        current = depth_by_tech.get(encounter.tech_id)
        if current is None or _rank(DEPTH_RANK, encounter.depth) > _rank(DEPTH_RANK, current):
            depth_by_tech[encounter.tech_id] = encounter.depth

    stmt = (
        select(TechSatisfaction, Technology)
        .join(Technology, Technology.id == TechSatisfaction.tech_id)
        .where(TechSatisfaction.capability_id == capability_id)
    )
    candidates: list[Offer] = []
    for satisfaction, technology in await session.execute(stmt):
        violated = [c for c in constraints if _violates(c, technology)]
        blocked = [c.name for c in violated if c.severity == ConstraintSeverity.block]
        if blocked:
            continue  # pruned before fit is scored, per the constraint contract
        stance = adoptions.get(technology.id)
        candidates.append(
            Offer(
                tech_id=technology.id,
                slug=technology.slug,
                name=technology.name,
                kind=technology.kind,
                fit=satisfaction.fit,
                stance=stance.status if stance else None,
                cost=satisfaction.cost or {},
                notes=satisfaction.notes,
                experience=depth_by_tech.get(technology.id),
                rank=0,
                warned_by=[c.name for c in violated if c.severity == ConstraintSeverity.warn],
            )
        )

    candidates.sort(
        key=lambda o: (
            _rank(FIT_RANK, o.fit),
            _rank(ADOPTION_RANK, o.stance) if o.stance else len(ADOPTION_RANK),
            -_rank(DEPTH_RANK, o.experience) if o.experience else 1,
            o.cost.get("ops_burden", 9) if isinstance(o.cost.get("ops_burden"), int) else 9,
            o.slug,
        )
    )
    for position, offer in enumerate(candidates, start=1):
        offer.rank = position
    return candidates


async def blocked_reason(
    session: AsyncSession,
    capability_id: uuid.UUID,
    product_id: uuid.UUID | None = None,
    stack_id: uuid.UUID | None = None,
) -> list[str]:
    """Names of the blocking constraints that pruned every offer, so an empty
    resolver can say why instead of just being empty."""
    constraints = await _blocking_constraints(session, product_id, stack_id)
    blocking = [c for c in constraints if c.severity == ConstraintSeverity.block]
    if not blocking:
        return []
    stmt = (
        select(Technology)
        .join(TechSatisfaction, TechSatisfaction.tech_id == Technology.id)
        .where(TechSatisfaction.capability_id == capability_id)
    )
    names: list[str] = []
    for technology in await session.scalars(stmt):
        names.extend(c.name for c in blocking if _violates(c, technology))
    return sorted(set(names))
