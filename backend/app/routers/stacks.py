import uuid

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.schemas.governance import ConcernAnswerRead, ConcernAnswerWrite
from app.schemas.stack import (
    Drift,
    ProductTechnologyRead,
    ProductTechnologyWrite,
    Redundancy,
    SlotBind,
    SlotCreate,
    SlotRead,
    SlotUpdate,
    StackCreate,
    StackRead,
    StackSummary,
    StackUpdate,
    StackView,
)
from app.schemas.technology import Offer
from app.services import stacks as stack_service
from app.services import technologies as tech_service

router = APIRouter(prefix="/api/stacks", tags=["stacks"])


class Instantiate(BaseModel):
    archetype_id: uuid.UUID
    product_id: uuid.UUID
    name: str


class SlotOffers(BaseModel):
    """Offers for one slot, with the reason the list is empty when it is."""

    slot_id: uuid.UUID
    capability_id: uuid.UUID | None
    offers: list[Offer]
    blocked_by: list[str]


@router.get("", response_model=list[StackSummary])
async def list_stacks(
    product_id: uuid.UUID | None = None,
    is_archetype: bool | None = None,
    session: AsyncSession = Depends(get_db),
):
    stacks = await stack_service.list_stacks(session, product_id, is_archetype)
    return [
        StackSummary(
            **StackRead.model_validate(entry["stack"]).model_dump(),
            slots=entry["slots"],
            required_slots=entry["required_slots"],
            instances=entry["instances"],
        )
        for entry in [await stack_service.summarize(session, s) for s in stacks]
    ]


@router.post("", response_model=StackRead, status_code=201)
async def create_stack(data: StackCreate, session: AsyncSession = Depends(get_db)):
    return await stack_service.create_stack(session, data)


# NB: static routes must be registered before /{stack_id}.
@router.post("/instantiate", response_model=StackRead, status_code=201)
async def instantiate(data: Instantiate, session: AsyncSession = Depends(get_db)):
    """Fill an archetype's shape for a product. Slots carry over unbound."""
    return await stack_service.instantiate(
        session, data.archetype_id, data.product_id, data.name
    )


@router.get("/redundancy", response_model=list[Redundancy])
async def redundancy(session: AsyncSession = Depends(get_db)):
    """Where two technologies a product uses answer one capability. Surfaced,
    never resolved."""
    return await stack_service.redundancy(session)


@router.get("/drift", response_model=list[Drift])
async def drift(product_id: uuid.UUID, session: AsyncSession = Depends(get_db)):
    return await stack_service.drift(session, product_id)


@router.get("/usage", response_model=list[ProductTechnologyRead])
async def list_usage(product_id: uuid.UUID, session: AsyncSession = Depends(get_db)):
    return await stack_service.list_product_technologies(session, product_id)


@router.put("/usage", response_model=ProductTechnologyRead)
async def record_usage(
    product_id: uuid.UUID,
    data: ProductTechnologyWrite,
    session: AsyncSession = Depends(get_db),
):
    """Observed usage, normally written by a lockfile importer rather than a
    person. via_slot_id null is drift, not an error."""
    return await stack_service.record_usage(session, product_id, data)


@router.delete("/usage", status_code=204)
async def drop_usage(
    product_id: uuid.UUID, tech_id: uuid.UUID, session: AsyncSession = Depends(get_db)
):
    await stack_service.drop_usage(session, product_id, tech_id)


@router.get("/slots/{slot_id}/offers", response_model=SlotOffers)
async def slot_offers(slot_id: uuid.UUID, session: AsyncSession = Depends(get_db)):
    slot = await stack_service.get_slot(session, slot_id)
    stack = await stack_service.get_stack(session, slot.stack_id)
    if slot.capability_id is None:
        return SlotOffers(slot_id=slot_id, capability_id=None, offers=[], blocked_by=[])
    offers = await tech_service.offers(
        session, slot.capability_id, stack.product_id, stack.id
    )
    return SlotOffers(
        slot_id=slot_id,
        capability_id=slot.capability_id,
        offers=offers,
        blocked_by=(
            []
            if offers
            else await tech_service.blocked_reason(
                session, slot.capability_id, stack.product_id, stack.id
            )
        ),
    )


@router.post("/slots/{slot_id}/bind", response_model=SlotRead)
async def bind_slot(
    slot_id: uuid.UUID, data: SlotBind, session: AsyncSession = Depends(get_db)
):
    """A human action, never automatic."""
    return await stack_service.bind_slot(session, slot_id, data.tech_id)


@router.patch("/slots/{slot_id}", response_model=SlotRead)
async def update_slot(
    slot_id: uuid.UUID, data: SlotUpdate, session: AsyncSession = Depends(get_db)
):
    return await stack_service.update_slot(session, slot_id, data)


@router.delete("/slots/{slot_id}", status_code=204)
async def delete_slot(slot_id: uuid.UUID, session: AsyncSession = Depends(get_db)):
    await stack_service.delete_slot(session, slot_id)


@router.get("/{stack_id}", response_model=StackView)
async def get_stack(stack_id: uuid.UUID, session: AsyncSession = Depends(get_db)):
    return await stack_service.view(session, stack_id)


@router.patch("/{stack_id}", response_model=StackRead)
async def update_stack(
    stack_id: uuid.UUID, data: StackUpdate, session: AsyncSession = Depends(get_db)
):
    return await stack_service.update_stack(session, stack_id, data)


@router.delete("/{stack_id}", status_code=204)
async def delete_stack(stack_id: uuid.UUID, session: AsyncSession = Depends(get_db)):
    await stack_service.delete_stack(session, stack_id)


@router.post("/{stack_id}/slots", response_model=SlotRead, status_code=201)
async def create_slot(
    stack_id: uuid.UUID, data: SlotCreate, session: AsyncSession = Depends(get_db)
):
    return await stack_service.create_slot(session, stack_id, data)


@router.get("/{stack_id}/concerns", response_model=list[ConcernAnswerRead])
async def list_concern_answers(stack_id: uuid.UUID, session: AsyncSession = Depends(get_db)):
    return await stack_service.list_concern_answers(session, stack_id)


@router.put("/{stack_id}/concerns", response_model=ConcernAnswerRead)
async def answer_concern(
    stack_id: uuid.UUID, data: ConcernAnswerWrite, session: AsyncSession = Depends(get_db)
):
    return await stack_service.answer_concern(session, stack_id, data)


@router.delete("/{stack_id}/concerns/{concern_id}", status_code=204)
async def unanswer_concern(
    stack_id: uuid.UUID, concern_id: uuid.UUID, session: AsyncSession = Depends(get_db)
):
    await stack_service.unanswer_concern(session, stack_id, concern_id)
