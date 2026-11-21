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
from sqlalchemy import func, literal, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

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
    Journey,
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
    Technology,
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
        # Features go with their product: detached, one would count as ours.
        ChildSpec(Feature, "product_id", "delete", "ontology"),
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

#: A link row reads as its two ends by name: (fk, end model) on each side,
#: and the word between. A feature edge's word is its kind.
LINK_ENDS: dict[type, tuple[tuple[str, type], str, tuple[str, type]]] = {
    FeatureCapability: (("feature_id", Feature), "→", ("capability_id", Capability)),
    FeatureEdge: (("src_id", Feature), "", ("dst_id", Feature)),
    Motivation: (("goal_id", Goal), "→", ("capability_id", Capability)),
    ProductBundle: (("product_id", Product), "⊃", ("capability_id", Capability)),
    ProductTechnology: (("product_id", Product), "uses", ("tech_id", Technology)),
    TechSatisfaction: (("tech_id", Technology), "satisfies", ("capability_id", Capability)),
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
    return (await _names(session, model, {row_id})).get(row_id, str(row_id)[:8])


def _n(n: int, one: str, many: str) -> str:
    return f"{n} {one if n == 1 else many}"


async def _names(session: AsyncSession, model: type, ids: set[uuid.UUID]) -> dict[uuid.UUID, str]:
    """Each row's name: its own (NAME_COLUMN), or a link's two ends
    (LINK_ENDS), read in one query per table. A guessed link names the
    feature or technology it is about. Other rows have none."""
    if not ids:
        return {}
    column = NAME_COLUMN.get(model)
    if column is not None:
        rows = await session.execute(select(model.id, getattr(model, column)).where(model.id.in_(ids)))
        return {row_id: name or str(row_id)[:8] for row_id, name in rows}
    if model is CapabilityGuess:
        feature, tech, cap = aliased(Feature), aliased(Technology), aliased(Capability)
        stmt = (
            select(model.id, func.coalesce(feature.name, tech.name), literal("→ (guess)"), cap.name)
            .outerjoin(feature, feature.id == model.feature_id)
            .outerjoin(tech, tech.id == model.tech_id)
            .outerjoin(cap, cap.id == model.capability_id)
        )
    elif model in LINK_ENDS:
        (left_fk, left_model), word, (right_fk, right_model) = LINK_ENDS[model]
        left, right = aliased(left_model), aliased(right_model)
        middle = model.kind if model is FeatureEdge else literal(word)
        stmt = (
            select(
                model.id,
                getattr(left, NAME_COLUMN.get(left_model, "name")),
                middle,
                getattr(right, NAME_COLUMN.get(right_model, "name")),
            )
            .outerjoin(left, left.id == getattr(model, left_fk))
            .outerjoin(right, right.id == getattr(model, right_fk))
        )
    else:
        return {}
    rows = await session.execute(stmt.where(model.id.in_(ids)))
    return {
        row_id: f"{a or '?'} {getattr(word, 'value', word)} {b or '?'}" for row_id, a, word, b in rows
    }


def _warnings(
    refs: list[RowRef],
    to_delete: dict[type, set[uuid.UUID]],
    names: dict[type, dict[uuid.UUID, str]],
) -> list[str]:
    out: list[str] = []
    selected = {r.id for r in refs}

    # The rows under a selected one, by name: nobody ticked them.
    for model, one, many in ((Capability, "capability", "capabilities"), (Goal, "goal", "goals")):
        extra = sorted(
            (names.get(model, {}).get(i, str(i)[:8]) for i in to_delete.get(model, set()) - selected),
            key=str.lower,
        )
        if extra:
            out.append(f"Also deletes {_n(len(extra), one, many)} under a selected one: {', '.join(extra)}.")

    buy = sum(len(ids) for m, ids in to_delete.items() if LABELS[m][1] == "buy")
    if buy:
        out.append(
            f"Deletes {_n(buy, 'row', 'rows')} of technology data, so any stack "
            f"that relied on it loses that supply."
        )
    return out


class NamedCount(TableCount):
    """A table's share of the closure. `names` lists every row by name for the
    tables whose rows have one, a link by its two ends (`_names`); the rest
    are only counted."""

    names: list[str] = []


class NamedPreview(CascadePreview):
    total_deletes: list[NamedCount]


async def _named_where(session: AsyncSession, model: type, ids: set[uuid.UUID]) -> dict[uuid.UUID, str]:
    """A row a delete keeps but unlinks, by its name and where it sits: a
    story's title alone says little. Other rows as `_names` names them."""
    where = {
        Epic: (Epic.title, Product.name, Product, Product.id == Epic.product_id),
        Story: (Story.title, Epic.title, Epic, Epic.id == Story.epic_id),
        StackSlot: (
            func.concat(StackSlot.layer, "::", StackSlot.role),
            TechStack.name,
            TechStack,
            TechStack.id == StackSlot.stack_id,
        ),
        JourneyStep: (JourneyStep.label, Journey.name, Journey, Journey.id == JourneyStep.journey_id),
    }.get(model)
    if where is None:
        return await _names(session, model, ids)
    name, place, joined, on = where
    rows = await session.execute(select(model.id, name, place).join(joined, on).where(model.id.in_(ids)))
    return {row_id: f"{a} ({b})" for row_id, a, b in rows}


async def detaches(session: AsyncSession, model: type, row_id: uuid.UUID) -> list[NamedCount]:
    """What deleting this one row keeps but unlinks: the rows its `detach`
    specs point at (ON DELETE SET NULL), each named. Only the row's own
    foreign keys, never the closure: the guarded deletes (a capability's, a
    feature's) remove one row, and say this before anyone confirms."""
    out: list[NamedCount] = []
    for spec in CHILDREN.get(model, ()):
        if spec.action != "detach":
            continue
        ids = set(
            await session.scalars(select(spec.model.id).where(getattr(spec.model, spec.fk) == row_id))
        )
        if not ids:
            continue
        label, plane = LABELS[spec.model]
        names = await _named_where(session, spec.model, ids)
        out.append(
            NamedCount(
                table=spec.model.__tablename__,
                label=label,
                plane=plane,
                count=len(ids),
                names=sorted(names.values(), key=str.lower),
            )
        )
    return out


async def preview(session: AsyncSession, refs: list[RowRef]) -> NamedPreview:
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

    names = {m: await _names(session, m, ids) for m, ids in to_delete.items()}
    by_table = {m.__tablename__: m for m in to_delete}
    totals = {m: len(ids) for m, ids in to_delete.items()}
    return NamedPreview(
        rows=rows,
        total_deletes=[
            NamedCount(
                **t.model_dump(),
                names=sorted(names[by_table[t.table]].values(), key=str.lower),
            )
            for t in _counts(totals)
        ],
        total_detaches=_counts(detach),
        total_rows=sum(totals.values()),
        warnings=_warnings(refs, to_delete, names),
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
