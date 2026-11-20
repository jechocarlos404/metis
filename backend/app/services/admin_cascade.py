"""Admin cascade delete: the deliberate override the guarded paths don't have.

`services/capabilities.delete_capability` refuses to orphan features and refuses
to pull supply out from under a stack. That guard is right for a single delete —
it turns a prompt failure into a 409. It is wrong for a janitor who has decided
the whole subtree is junk, which is what this module is for.

Two rules keep the override honest:

* One closure function serves both preview and execute. A preview computed by
  different code than the delete is a preview that can lie.
* A feature realizing several capabilities loses only the links into the
  closure; it is deleted only when no capability outside the closure is left
  for it to realize. Leaving it behind would orphan it, which the guarded
  paths refuse to do.
* Nothing is silently re-pointed. `capabilities.parent_id` is ON DELETE SET NULL,
  so letting Postgres handle a parent delete would quietly re-root the children
  at top level. The closure follows `parent_id` instead, and the preview says so.
"""

import uuid
from collections import defaultdict, deque
from dataclasses import dataclass
from typing import Literal

from fastapi import HTTPException
from sqlalchemy import delete as sa_delete
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    Capability,
    ConstraintScope,
    DeliveryStrategy,
    Encounter,
    Epic,
    Feature,
    CapabilityGuess,
    FeatureCapability,
    FeatureEdge,
    Goal,
    JourneyStep,
    Motivation,
    Product,
    ProductBundle,
    ProductDecomposition,
    ProductTechnology,
    StackConcernAnswer,
    StackSlot,
    Story,
    TechSatisfaction,
    TechStack,
    Ticket,
)
from app.schemas.admin import (
    CascadePreview,
    CascadeResult,
    Plane,
    RowImpact,
    RowRef,
    TableCount,
)

Follow = Literal["delete", "detach"]


@dataclass(frozen=True)
class ChildSpec:
    """One foreign key pointing at a parent, and what we do about it.

    `delete` puts the child in the closure; `detach` only counts it, because the
    FK is ON DELETE SET NULL and the row legitimately outlives its parent.
    """

    model: type
    fk: str
    action: Follow
    plane: Plane


# Transcribed from the live pg_constraint dump, not from the models — test
# `test_child_registry_matches_the_live_foreign_keys` asserts they agree, so this
# table cannot silently fall behind a schema change.
CHILDREN: dict[type, tuple[ChildSpec, ...]] = {
    Capability: (
        # PG says SET NULL. We recurse anyway: an admin ticking a parent does not
        # mean "flatten my capability map and tell me nothing".
        ChildSpec(Capability, "parent_id", "delete", "ontology"),
        ChildSpec(FeatureCapability, "capability_id", "delete", "ontology"),  # the RESTRICT that 409s
        ChildSpec(Motivation, "capability_id", "delete", "ontology"),
        ChildSpec(ProductBundle, "capability_id", "delete", "ontology"),
        ChildSpec(TechSatisfaction, "capability_id", "delete", "buy"),  # the other RESTRICT
        ChildSpec(CapabilityGuess, "capability_id", "delete", "ontology"),
        ChildSpec(Epic, "capability_id", "detach", "delivery"),
        ChildSpec(StackSlot, "capability_id", "detach", "buy"),
    ),
    Feature: (
        ChildSpec(FeatureCapability, "feature_id", "delete", "ontology"),
        ChildSpec(CapabilityGuess, "feature_id", "delete", "ontology"),
        ChildSpec(FeatureEdge, "src_id", "delete", "ontology"),
        ChildSpec(FeatureEdge, "dst_id", "delete", "ontology"),
        ChildSpec(Story, "feature_id", "detach", "delivery"),
        # a journey keeps the step as a labelled gap (FK SET NULL)
        ChildSpec(JourneyStep, "feature_id", "detach", "ontology"),
    ),
    Goal: (
        ChildSpec(Goal, "parent_goal_id", "delete", "ontology"),
        ChildSpec(Motivation, "goal_id", "delete", "ontology"),
        ChildSpec(Product, "goal_id", "detach", "ontology"),  # specs outlive their goal
    ),
    Product: (
        ChildSpec(ProductBundle, "product_id", "delete", "ontology"),
        ChildSpec(Feature, "product_id", "detach", "ontology"),  # features outlive their product
        ChildSpec(ProductDecomposition, "product_id", "delete", "delivery"),
        ChildSpec(Epic, "product_id", "delete", "delivery"),
        ChildSpec(Ticket, "product_id", "delete", "delivery"),
        ChildSpec(DeliveryStrategy, "product_id", "delete", "delivery"),
        ChildSpec(ConstraintScope, "product_id", "delete", "buy"),
        ChildSpec(ProductTechnology, "product_id", "delete", "buy"),
        ChildSpec(TechStack, "product_id", "delete", "buy"),
        ChildSpec(Encounter, "product_id", "detach", "buy"),
    ),
    ProductDecomposition: (ChildSpec(Epic, "decomposition_id", "delete", "delivery"),),
    Epic: (
        ChildSpec(Story, "epic_id", "delete", "delivery"),
        ChildSpec(Ticket, "epic_id", "delete", "delivery"),
    ),
    Story: (ChildSpec(Ticket, "story_id", "detach", "delivery"),),
    TechStack: (
        ChildSpec(TechStack, "parent_id", "delete", "buy"),
        ChildSpec(StackSlot, "stack_id", "delete", "buy"),
        ChildSpec(StackConcernAnswer, "stack_id", "delete", "buy"),
        ChildSpec(ConstraintScope, "stack_id", "delete", "buy"),
    ),
    StackSlot: (
        ChildSpec(ProductTechnology, "via_slot_id", "detach", "buy"),
        ChildSpec(StackConcernAnswer, "slot_id", "detach", "buy"),
    ),
}

# Leaf-ward. Every RESTRICT referent is removed before its referent target, which
# is why the two RESTRICT FKs need no special handling: by the time `capabilities`
# is deleted, nothing points at it.
DELETE_ORDER: tuple[type, ...] = (
    StackConcernAnswer,
    ProductTechnology,
    ConstraintScope,
    StackSlot,
    TechStack,
    Ticket,
    Story,
    Epic,
    ProductDecomposition,
    DeliveryStrategy,
    FeatureEdge,
    FeatureCapability,
    CapabilityGuess,
    Feature,
    TechSatisfaction,
    Motivation,
    ProductBundle,
    Capability,
    Product,
    Goal,
)

ENTITY_MODELS: dict[str, type] = {
    "goals": Goal,
    "capabilities": Capability,
    "features": Feature,
    "feature_edges": FeatureEdge,
    "motivations": Motivation,
    "products": Product,
    "product_bundles": ProductBundle,
    "tickets": Ticket,
}

LABELS: dict[type, tuple[str, Plane]] = {
    Capability: ("Capabilities", "ontology"),
    ConstraintScope: ("Constraint scopes", "buy"),
    DeliveryStrategy: ("Delivery strategies", "delivery"),
    Encounter: ("Encounters", "buy"),
    Epic: ("Epics", "delivery"),
    Feature: ("Features", "ontology"),
    FeatureCapability: ("Feature capability links", "ontology"),
    CapabilityGuess: ("Guessed capability links", "ontology"),
    FeatureEdge: ("Feature edges", "ontology"),
    Goal: ("Goals", "ontology"),
    JourneyStep: ("Journey steps", "ontology"),
    Motivation: ("Motivations", "ontology"),
    Product: ("Products", "ontology"),
    ProductBundle: ("Product bundles", "ontology"),
    ProductDecomposition: ("Decompositions", "delivery"),
    ProductTechnology: ("Product technologies", "buy"),
    StackConcernAnswer: ("Stack concern answers", "buy"),
    StackSlot: ("Stack slots", "buy"),
    Story: ("Stories", "delivery"),
    TechSatisfaction: ("Technology satisfactions", "buy"),
    TechStack: ("Tech stacks", "buy"),
    Ticket: ("Tickets", "delivery"),
}

#: Column to read for a human label, per seed model. Join rows have none.
NAME_COLUMN: dict[type, str] = {
    Goal: "title",
    Capability: "name",
    Feature: "name",
    Product: "name",
    Ticket: "title",
}


def _counts(tally: dict[type, int]) -> list[TableCount]:
    """Ordered by size so the biggest surprise reads first."""
    rows = [
        TableCount(
            table=model.__tablename__,
            label=LABELS[model][0],
            plane=LABELS[model][1],
            count=n,
        )
        for model, n in tally.items()
        if n
    ]
    return sorted(rows, key=lambda r: (-r.count, r.label))


async def compute_closure(
    session: AsyncSession, refs: list[RowRef]
) -> tuple[dict[type, set[uuid.UUID]], dict[type, int], list[RowRef]]:
    """Frontier BFS over CHILDREN. Returns (to_delete, detach_counts, missing).

    Dedup by (model, id) is what makes the self-referencing FKs — capability
    subtrees, nested tech stacks — terminate instead of looping.
    """
    to_delete: dict[type, set[uuid.UUID]] = defaultdict(set)
    frontier: deque[tuple[type, set[uuid.UUID]]] = deque()
    missing: list[RowRef] = []

    seeds: dict[type, set[uuid.UUID]] = defaultdict(set)
    for ref in refs:
        seeds[ENTITY_MODELS[ref.entity]].add(ref.id)

    for model, ids in seeds.items():
        found = set(await session.scalars(select(model.id).where(model.id.in_(ids))))
        missing.extend(
            RowRef(entity=r.entity, id=r.id)
            for r in refs
            if ENTITY_MODELS[r.entity] is model and r.id not in found
        )
        if found:
            to_delete[model] |= found
            frontier.append((model, found))

    while frontier:
        while frontier:
            model, ids = frontier.popleft()
            for spec in CHILDREN.get(model, ()):
                if spec.action != "delete":
                    continue
                child_ids = set(
                    await session.scalars(
                        select(spec.model.id).where(getattr(spec.model, spec.fk).in_(ids))
                    )
                )
                new = child_ids - to_delete[spec.model]
                if new:
                    to_delete[spec.model] |= new
                    frontier.append((spec.model, new))
        # Features whose every link is in the closure have nothing left to
        # realize; they join it (and their own children expand next round).
        orphans = await _orphaned_features(session, to_delete)
        if orphans:
            to_delete[Feature] |= orphans
            frontier.append((Feature, orphans))

    # Detach counts last, and only for rows that survive. A story whose epic is
    # in the closure is deleted, not detached; counting it during expansion would
    # report the same row under both headings.
    detach: dict[type, int] = defaultdict(int)
    for model, ids in list(to_delete.items()):
        for spec in CHILDREN.get(model, ()):
            if spec.action != "detach":
                continue
            stmt = (
                select(func.count())
                .select_from(spec.model)
                .where(getattr(spec.model, spec.fk).in_(ids))
            )
            if to_delete.get(spec.model):
                stmt = stmt.where(spec.model.id.notin_(to_delete[spec.model]))
            detach[spec.model] += await session.scalar(stmt) or 0

    return {m: ids for m, ids in to_delete.items() if ids}, dict(detach), missing


async def _orphaned_features(
    session: AsyncSession, to_delete: dict[type, set[uuid.UUID]]
) -> set[uuid.UUID]:
    links = to_delete.get(FeatureCapability)
    if not links:
        return set()
    touched = set(
        await session.scalars(
            select(FeatureCapability.feature_id).where(FeatureCapability.id.in_(links))
        )
    ) - to_delete.get(Feature, set())
    if not touched:
        return set()
    survivors = set(
        await session.scalars(
            select(FeatureCapability.feature_id).where(
                FeatureCapability.feature_id.in_(touched),
                FeatureCapability.id.notin_(links),
            )
        )
    )
    # A feature that declares its capabilities unknown may stand with none.
    declared = set(
        await session.scalars(
            select(Feature.id).where(
                Feature.id.in_(touched), Feature.unknown_capabilities.is_(True)
            )
        )
    )
    return touched - survivors - declared


async def _label(session: AsyncSession, model: type, row_id: uuid.UUID) -> str:
    column = NAME_COLUMN.get(model)
    if column is not None:
        value = await session.scalar(select(getattr(model, column)).where(model.id == row_id))
        return value or str(row_id)[:8]
    if model is FeatureEdge:
        edge = await session.get(FeatureEdge, row_id)
        if edge is None:
            return str(row_id)[:8]
        names = dict(
            (
                await session.execute(
                    select(Feature.id, Feature.name).where(
                        Feature.id.in_([edge.src_id, edge.dst_id])
                    )
                )
            ).all()
        )
        src = names.get(edge.src_id, "?")
        dst = names.get(edge.dst_id, "?")
        return f"{src} {edge.kind} {dst}"
    if model is Motivation:
        row = await session.get(Motivation, row_id)
        if row is None:
            return str(row_id)[:8]
        goal = await session.scalar(select(Goal.title).where(Goal.id == row.goal_id))
        cap = await session.scalar(
            select(Capability.name).where(Capability.id == row.capability_id)
        )
        return f"{goal or '?'} → {cap or '?'}"
    if model is ProductBundle:
        row = await session.get(ProductBundle, row_id)
        if row is None:
            return str(row_id)[:8]
        product = await session.scalar(select(Product.name).where(Product.id == row.product_id))
        cap = await session.scalar(
            select(Capability.name).where(Capability.id == row.capability_id)
        )
        return f"{product or '?'} ⊃ {cap or '?'}"
    return str(row_id)[:8]


def _warnings(
    refs: list[RowRef], to_delete: dict[type, set[uuid.UUID]]
) -> list[str]:
    out: list[str] = []
    seeded = {(ENTITY_MODELS[r.entity], r.id) for r in refs}

    for model, noun in ((Capability, "capabilities"), (Goal, "goals")):
        extra = len(to_delete.get(model, set())) - sum(1 for m, _ in seeded if m is model)
        if extra > 0:
            out.append(
                f"{extra} descendant {noun} are included — deleting a parent would "
                f"otherwise silently re-root its children to top level."
            )

    buy = sum(len(ids) for m, ids in to_delete.items() if LABELS[m][1] == "buy")
    if buy:
        out.append(
            f"{buy} row(s) on the buy plane will be deleted — technology supply "
            f"disappears from under any stack that relied on it."
        )
    return out


async def preview(session: AsyncSession, refs: list[RowRef]) -> CascadePreview:
    to_delete, detach, missing = await compute_closure(session, refs)
    missing_ids = {r.id for r in missing}

    rows: list[RowImpact] = []
    for ref in refs:
        model = ENTITY_MODELS[ref.entity]
        if ref.id in missing_ids:
            rows.append(
                RowImpact(entity=ref.entity, id=ref.id, label=str(ref.id)[:8], missing=True)
            )
            continue
        alone, alone_detach, _ = await compute_closure(session, [ref])
        alone[model] = alone.get(model, set()) - {ref.id}  # the row itself is implied
        rows.append(
            RowImpact(
                entity=ref.entity,
                id=ref.id,
                label=await _label(session, model, ref.id),
                deletes=_counts({m: len(ids) for m, ids in alone.items()}),
                detaches=_counts(alone_detach),
            )
        )

    totals = {m: len(ids) for m, ids in to_delete.items()}
    return CascadePreview(
        rows=rows,
        total_deletes=_counts(totals),
        total_detaches=_counts(detach),
        total_rows=sum(totals.values()),
        warnings=_warnings(refs, to_delete),
    )


async def execute(session: AsyncSession, refs: list[RowRef], graph=None) -> CascadeResult:
    to_delete, detach, missing = await compute_closure(session, refs)
    if missing:
        # Before the first DELETE, so a stale id in a 200-row selection removes
        # nothing rather than most of it.
        raise HTTPException(
            404,
            f"{len(missing)} selected row(s) no longer exist — nothing was deleted. "
            "Reload and try again.",
        )

    deleted: dict[type, int] = {}
    try:
        for model in DELETE_ORDER:
            ids = to_delete.get(model)
            if not ids:
                continue
            result = await session.execute(
                sa_delete(model)
                .where(model.id.in_(ids))
                .execution_options(synchronize_session=False)
            )
            deleted[model] = result.rowcount
        await session.commit()
    except IntegrityError as exc:
        await session.rollback()
        raise HTTPException(
            409,
            "Delete refused by a constraint outside the ontology plane — "
            "nothing was deleted.",
        ) from exc

    # Deliberately no expire_all(): the closure reads only id columns, so no
    # deleted entity entered the identity map through this path, and expiring
    # would break any object the caller already holds.
    # One mark_dirty beats N remove_node calls: cheaper, order-free, and correct
    # for rows the closure never enumerated. ensure_fresh() rebuilds from PG.
    if graph is not None and (to_delete.get(Feature) or to_delete.get(FeatureEdge)):
        graph.mark_dirty()

    return CascadeResult(
        deleted=_counts(deleted),
        detached=_counts(detach),
        total=sum(deleted.values()),
    )
