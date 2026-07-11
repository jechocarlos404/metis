import uuid

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.db import get_db
from app.models import Epic
from app.schemas.work import EpicNested, TicketCreate, TicketRead, TicketUpdate
from app.services import tickets as ticket_service

router = APIRouter(prefix="/api", tags=["work"])


@router.get("/products/{product_id}/epics", response_model=list[EpicNested])
async def list_epics(product_id: uuid.UUID, session: AsyncSession = Depends(get_db)):
    stmt = (
        select(Epic)
        .where(Epic.product_id == product_id)
        .options(selectinload(Epic.stories), selectinload(Epic.tickets))
        .order_by(Epic.position)
    )
    return (await session.scalars(stmt)).unique().all()


@router.get("/products/{product_id}/tickets", response_model=list[TicketRead])
async def list_tickets(product_id: uuid.UUID, session: AsyncSession = Depends(get_db)):
    return await ticket_service.list_tickets(session, product_id)


@router.post("/tickets", response_model=TicketRead, status_code=201)
async def create_ticket(data: TicketCreate, session: AsyncSession = Depends(get_db)):
    return await ticket_service.create_ticket(session, data)


@router.get("/tickets/{ticket_id}", response_model=TicketRead)
async def get_ticket(ticket_id: uuid.UUID, session: AsyncSession = Depends(get_db)):
    return await ticket_service.get_ticket(session, ticket_id)


@router.patch("/tickets/{ticket_id}", response_model=TicketRead)
async def update_ticket(
    ticket_id: uuid.UUID, data: TicketUpdate, session: AsyncSession = Depends(get_db)
):
    return await ticket_service.update_ticket(session, ticket_id, data)


@router.delete("/tickets/{ticket_id}", status_code=204)
async def delete_ticket(ticket_id: uuid.UUID, session: AsyncSession = Depends(get_db)):
    await ticket_service.delete_ticket(session, ticket_id)
