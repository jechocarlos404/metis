"""Stacks — layered composition and archetype in one object, and the three
predicates that make the stack view worth having.

Gaps, drift and redundancy are not three features. They are three predicates
over `stack_slots` and `product_technologies`:

    required AND tech_id IS NULL          -> gap
    two slots in one stack, one capability -> redundancy
    product_technologies.via_slot_id NULL  -> drift

Get the slot right and the reports write themselves. Nothing here auto-fills a
gap: an empty required slot is information the PRD has to answer before tickets
are cut, and a plausible wrong binding is not.
"""

import uuid
from collections import defaultdict

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    Adoption,
    Capability,
    Concern,
    Product,
    ProductBundle,
    ProductTechnology,
    StackConcernAnswer,
    StackSlot,
    TechSatisfaction,
    TechStack,
    Technology,
)
from app.models.enums import TechFit
from app.schemas.governance import ConcernAnswerWrite
from app.schemas.stack import (
    Drift,
    ProductTechnologyWrite,
    Redundancy,
    SlotCreate,
    SlotRead,
    SlotUpdate,
    SlotView,
    StackCreate,
    StackUpdate,
)

#: Pipeline order, agent-first. The stack reads top-down the way the request does.
LAYER_ORDER = ["agent", "web", "api", "data", "infra", "ops"]


async def get_stack(session: AsyncSession, stack_id: uuid.UUID) -> TechStack:
    stack = await session.get(TechStack, stack_id)
    if stack is None:
        raise HTTPException(404, "Stack not found")
    return stack


async def list_stacks(
    session: AsyncSession,
    product_id: uuid.UUID | None = None,
    is_archetype: bool | None = None,
) -> list[TechStack]:
    stmt = select(TechStack).order_by(TechStack.seq)
    if product_id is not None:
        stmt = stmt.where(TechStack.product_id == product_id)
    if is_archetype is not None:
        stmt = stmt.where(TechStack.is_archetype.is_(is_archetype))
    return list((await session.scalars(stmt)).all())


async def summarize(session: AsyncSession, stack: TechStack) -> dict:
    slots = await list_slots(session, stack.id)
    instances = await session.scalar(
        select(func.count()).select_from(TechStack).where(TechStack.parent_id == stack.id)
    )
    return {
        "stack": stack,
        "slots": len(slots),
        "required_slots": sum(1 for s in slots if s.required),
        "instances": instances or 0,
    }


async def create_stack(session: AsyncSession, data: StackCreate) -> TechStack:
    if data.is_archetype and data.product_id is not None:
        raise HTTPException(422, "An archetype is a shape to fill — it belongs to no product")
    if data.product_id is not None and await session.get(Product, data.product_id) is None:
        raise HTTPException(404, "Product not found")
    if data.parent_id is not None:
        await get_stack(session, data.parent_id)
    stack = TechStack(**data.model_dump())
    session.add(stack)
    await session.commit()
    await session.refresh(stack)
    return stack


async def update_stack(
    session: AsyncSession, stack_id: uuid.UUID, data: StackUpdate
) -> TechStack:
    stack = await get_stack(session, stack_id)
    fields = data.model_dump(exclude_unset=True)
    if fields.get("product_id") is not None:
        if stack.is_archetype:
            raise HTTPException(422, "An archetype belongs to no product")
        if await session.get(Product, fields["product_id"]) is None:
            raise HTTPException(404, "Product not found")
    if fields.get("parent_id") is not None:
        if fields["parent_id"] == stack_id:
            raise HTTPException(422, "A stack cannot descend from itself")
        await get_stack(session, fields["parent_id"])
    for key, value in fields.items():
        setattr(stack, key, value)
    await session.commit()
    await session.refresh(stack)
    return stack


async def delete_stack(session: AsyncSession, stack_id: uuid.UUID) -> None:
    await session.delete(await get_stack(session, stack_id))
    await session.commit()


async def instantiate(
    session: AsyncSession, archetype_id: uuid.UUID, product_id: uuid.UUID, name: str
) -> TechStack:
    """Copy an archetype's slots for a product. Capabilities and shape carry
    over; bindings do not — every slot lands unfilled, and parent_id keeps the
    lineage so "which products still follow the archetype" stays answerable."""
    archetype = await get_stack(session, archetype_id)
    if not archetype.is_archetype:
        raise HTTPException(422, "Only an archetype can be instantiated")
    if await session.get(Product, product_id) is None:
        raise HTTPException(404, "Product not found")
    stack = TechStack(
        name=name,
        description=archetype.description,
        is_archetype=False,
        parent_id=archetype.id,
        product_id=product_id,
    )
    session.add(stack)
    await session.flush()
    for slot in await list_slots(session, archetype.id):
        session.add(
            StackSlot(
                stack_id=stack.id,
                layer=slot.layer,
                role=slot.role,
                capability_id=slot.capability_id,
                tech_id=None,
                required=slot.required,
                position=slot.position,
            )
        )
    await session.commit()
    await session.refresh(stack)
    return stack


# ---- slots ----

async def list_slots(session: AsyncSession, stack_id: uuid.UUID) -> list[StackSlot]:
    stmt = select(StackSlot).where(StackSlot.stack_id == stack_id)
    slots = list((await session.scalars(stmt)).all())
    slots.sort(key=lambda s: (_layer_index(s.layer), s.position, s.role))
    return slots


def _layer_index(layer) -> int:
    value = str(layer)
    return LAYER_ORDER.index(value) if value in LAYER_ORDER else len(LAYER_ORDER)


async def get_slot(session: AsyncSession, slot_id: uuid.UUID) -> StackSlot:
    slot = await session.get(StackSlot, slot_id)
    if slot is None:
        raise HTTPException(404, "Slot not found")
    return slot


async def _check_capability_bundled(
    session: AsyncSession, stack: TechStack, capability_id: uuid.UUID | None
) -> None:
    """A product stack may only answer capabilities its product actually bundles.
    No cross-table FK can express this, so it lives here. Archetypes are exempt:
    they have no product to check against — that is what makes them a shape."""
    if capability_id is None or stack.product_id is None:
        return
    if await session.get(Capability, capability_id) is None:
        raise HTTPException(404, "Capability not found")
    bundled = await session.scalar(
        select(ProductBundle).where(
            ProductBundle.product_id == stack.product_id,
            ProductBundle.capability_id == capability_id,
        )
    )
    if bundled is None:
        raise HTTPException(
            422,
            "The product does not bundle that capability — bundle it first, or "
            "the stack answers something the product never promised.",
        )


async def create_slot(
    session: AsyncSession, stack_id: uuid.UUID, data: SlotCreate
) -> StackSlot:
    stack = await get_stack(session, stack_id)
    await _check_capability_bundled(session, stack, data.capability_id)
    if data.tech_id is not None and await session.get(Technology, data.tech_id) is None:
        raise HTTPException(404, "Technology not found")
    slot = StackSlot(stack_id=stack_id, **data.model_dump())
    session.add(slot)
    await session.commit()
    await session.refresh(slot)
    return slot


async def update_slot(
    session: AsyncSession, slot_id: uuid.UUID, data: SlotUpdate
) -> StackSlot:
    slot = await get_slot(session, slot_id)
    fields = data.model_dump(exclude_unset=True)
    if "capability_id" in fields:
        stack = await get_stack(session, slot.stack_id)
        await _check_capability_bundled(session, stack, fields["capability_id"])
    for key, value in fields.items():
        setattr(slot, key, value)
    await session.commit()
    await session.refresh(slot)
    return slot


async def delete_slot(session: AsyncSession, slot_id: uuid.UUID) -> None:
    await session.delete(await get_slot(session, slot_id))
    await session.commit()


async def bind_slot(
    session: AsyncSession, slot_id: uuid.UUID, tech_id: uuid.UUID | None
) -> StackSlot:
    """Bind a technology to a slot. A human action: nothing in this codebase
    fills a slot on its own. Passing None unbinds, which reopens the gap."""
    slot = await get_slot(session, slot_id)
    if tech_id is not None:
        if await session.get(Technology, tech_id) is None:
            raise HTTPException(404, "Technology not found")
        if slot.capability_id is not None:
            satisfies = await session.scalar(
                select(TechSatisfaction).where(
                    TechSatisfaction.tech_id == tech_id,
                    TechSatisfaction.capability_id == slot.capability_id,
                )
            )
            if satisfies is None:
                raise HTTPException(
                    422,
                    "That technology does not satisfy the slot's capability — "
                    "record the satisfaction first, with its fit.",
                )
    slot.tech_id = tech_id
    await session.commit()
    await session.refresh(slot)
    return slot


# ---- the view, and its three predicates ----

async def drift(session: AsyncSession, product_id: uuid.UUID) -> list[Drift]:
    """Used by the product, declared by no slot. The first drift report is a
    deliverable, not a defect — resist creating slots so the number goes to
    zero."""
    stmt = (
        select(Technology)
        .join(ProductTechnology, ProductTechnology.tech_id == Technology.id)
        .where(
            ProductTechnology.product_id == product_id,
            ProductTechnology.via_slot_id.is_(None),
        )
        .order_by(Technology.slug)
    )
    return [
        Drift(tech_id=t.id, slug=t.slug) for t in (await session.scalars(stmt)).all()
    ]


async def unanswered_concerns(session: AsyncSession, stack_id: uuid.UUID) -> list[str]:
    """Every stack must answer every concern with some slot. An unmet capability
    is a roadmap item; an unanswered concern is a review blocker."""
    answered = {
        answer.concern_id
        for answer in await session.scalars(
            select(StackConcernAnswer).where(
                StackConcernAnswer.stack_id == stack_id,
                StackConcernAnswer.slot_id.is_not(None),
            )
        )
    }
    stmt = select(Concern).order_by(Concern.name)
    return [c.name for c in (await session.scalars(stmt)).all() if c.id not in answered]


async def view(session: AsyncSession, stack_id: uuid.UUID) -> dict:
    stack = await get_stack(session, stack_id)
    slots = await list_slots(session, stack_id)

    capabilities = {
        c.id: c.name
        for c in (await session.scalars(select(Capability))).all()
    }
    technologies = {t.id: t for t in (await session.scalars(select(Technology))).all()}
    stances = {a.tech_id: a.status for a in (await session.scalars(select(Adoption))).all()}
    fits = {
        (s.tech_id, s.capability_id): s.fit
        for s in (await session.scalars(select(TechSatisfaction))).all()
    }

    per_capability: dict[uuid.UUID, int] = defaultdict(int)
    for slot in slots:
        if slot.capability_id is not None:
            per_capability[slot.capability_id] += 1

    drifting: set[uuid.UUID] = set()
    if stack.product_id is not None:
        drifting = {d.tech_id for d in await drift(session, stack.product_id)}

    views = []
    for slot in slots:
        fit = fits.get((slot.tech_id, slot.capability_id)) if slot.tech_id else None
        stance = stances.get(slot.tech_id) if slot.tech_id else None
        flags = []
        if slot.tech_id is None and slot.required:
            flags.append("gap")
        if slot.capability_id is not None and per_capability[slot.capability_id] > 1:
            flags.append("redundant")
        if slot.tech_id is not None and slot.tech_id in drifting:
            flags.append("drift")
        if fit == TechFit.workaround:
            flags.append("workaround")
        if stance is not None and str(stance) == "trial":
            flags.append("trial")
        views.append(
            SlotView(
                **SlotRead.model_validate(slot).model_dump(),
                capability=capabilities.get(slot.capability_id),
                tech=technologies[slot.tech_id].slug if slot.tech_id else None,
                fit=fit,
                stance=stance,
                flags=flags,
            )
        )

    return {
        "stack": stack,
        "slots": views,
        "drift": (
            await drift(session, stack.product_id) if stack.product_id is not None else []
        ),
        "unanswered_concerns": await unanswered_concerns(session, stack_id),
    }


async def redundancy(session: AsyncSession) -> list[Redundancy]:
    """Question 4: where two technologies a product uses answer one capability.
    Definable only because Capability is the shared unit. Workaround-grade
    overlap is excluded — Postgres full-text is not competing with a vector
    store, and reporting it as duplication makes the whole report noise."""
    stmt = (
        select(Product, Capability, Technology)
        .select_from(ProductTechnology)
        .join(Product, Product.id == ProductTechnology.product_id)
        .join(TechSatisfaction, TechSatisfaction.tech_id == ProductTechnology.tech_id)
        .join(Capability, Capability.id == TechSatisfaction.capability_id)
        .join(Technology, Technology.id == ProductTechnology.tech_id)
        .where(TechSatisfaction.fit.in_([TechFit.native, TechFit.partial]))
    )
    grouped: dict[tuple[uuid.UUID, uuid.UUID], dict] = {}
    for product, capability, technology in await session.execute(stmt):
        entry = grouped.setdefault(
            (product.id, capability.id),
            {
                "product_id": product.id,
                "product": product.name,
                "capability_id": capability.id,
                "capability": capability.name,
                "competing": set(),
            },
        )
        entry["competing"].add(technology.slug)

    findings = [
        Redundancy(**{**entry, "competing": sorted(entry["competing"])})
        for entry in grouped.values()
        if len(entry["competing"]) > 1
    ]
    findings.sort(key=lambda r: (-len(r.competing), r.product, r.capability))
    return findings


# ---- observed usage ----

async def list_product_technologies(
    session: AsyncSession, product_id: uuid.UUID
) -> list[ProductTechnology]:
    stmt = (
        select(ProductTechnology)
        .where(ProductTechnology.product_id == product_id)
        .order_by(ProductTechnology.seq)
    )
    return list((await session.scalars(stmt)).all())


async def record_usage(
    session: AsyncSession, product_id: uuid.UUID, data: ProductTechnologyWrite
) -> ProductTechnology:
    if await session.get(Product, product_id) is None:
        raise HTTPException(404, "Product not found")
    if await session.get(Technology, data.tech_id) is None:
        raise HTTPException(404, "Technology not found")
    if data.via_slot_id is not None:
        await get_slot(session, data.via_slot_id)
    usage = await session.scalar(
        select(ProductTechnology).where(
            ProductTechnology.product_id == product_id,
            ProductTechnology.tech_id == data.tech_id,
        )
    )
    if usage is None:
        usage = ProductTechnology(product_id=product_id, **data.model_dump())
        session.add(usage)
    else:
        usage.via_slot_id = data.via_slot_id
    await session.commit()
    await session.refresh(usage)
    return usage


async def drop_usage(
    session: AsyncSession, product_id: uuid.UUID, tech_id: uuid.UUID
) -> None:
    usage = await session.scalar(
        select(ProductTechnology).where(
            ProductTechnology.product_id == product_id,
            ProductTechnology.tech_id == tech_id,
        )
    )
    if usage is None:
        raise HTTPException(404, "This product does not use that technology")
    await session.delete(usage)
    await session.commit()


# ---- concern answers ----

async def list_concern_answers(
    session: AsyncSession, stack_id: uuid.UUID
) -> list[StackConcernAnswer]:
    stmt = (
        select(StackConcernAnswer)
        .where(StackConcernAnswer.stack_id == stack_id)
        .order_by(StackConcernAnswer.seq)
    )
    return list((await session.scalars(stmt)).all())


async def answer_concern(
    session: AsyncSession, stack_id: uuid.UUID, data: ConcernAnswerWrite
) -> StackConcernAnswer:
    await get_stack(session, stack_id)
    if await session.get(Concern, data.concern_id) is None:
        raise HTTPException(404, "Concern not found")
    if data.slot_id is not None:
        slot = await get_slot(session, data.slot_id)
        if slot.stack_id != stack_id:
            raise HTTPException(422, "That slot belongs to a different stack")
    answer = await session.scalar(
        select(StackConcernAnswer).where(
            StackConcernAnswer.stack_id == stack_id,
            StackConcernAnswer.concern_id == data.concern_id,
        )
    )
    if answer is None:
        answer = StackConcernAnswer(stack_id=stack_id, **data.model_dump())
        session.add(answer)
    else:
        answer.slot_id = data.slot_id
    await session.commit()
    await session.refresh(answer)
    return answer


async def unanswer_concern(
    session: AsyncSession, stack_id: uuid.UUID, concern_id: uuid.UUID
) -> None:
    answer = await session.scalar(
        select(StackConcernAnswer).where(
            StackConcernAnswer.stack_id == stack_id,
            StackConcernAnswer.concern_id == concern_id,
        )
    )
    if answer is None:
        raise HTTPException(404, "Concern answer not found")
    await session.delete(answer)
    await session.commit()
