import uuid

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Epic, Story, Ticket
from app.schemas.work import TicketCreate, TicketUpdate


async def list_tickets(session: AsyncSession, product_id: uuid.UUID) -> list[Ticket]:
    stmt = (
        select(Ticket)
        .where(Ticket.product_id == product_id)
        .order_by(Ticket.position, Ticket.seq)
    )
    return list((await session.scalars(stmt)).all())


async def get_ticket(session: AsyncSession, ticket_id: uuid.UUID) -> Ticket:
    ticket = await session.get(Ticket, ticket_id)
    if ticket is None:
        raise HTTPException(404, "Ticket not found")
    return ticket


async def create_ticket(session: AsyncSession, data: TicketCreate) -> Ticket:
    if data.epic_id is not None and await session.get(Epic, data.epic_id) is None:
        raise HTTPException(404, "Epic not found")
    if data.story_id is not None and await session.get(Story, data.story_id) is None:
        raise HTTPException(404, "Story not found")
    position = await session.scalar(
        select(func.count()).select_from(Ticket).where(Ticket.product_id == data.product_id)
    )
    ticket = Ticket(**data.model_dump(), position=position or 0)
    session.add(ticket)
    await session.commit()
    await session.refresh(ticket)
    return ticket


async def update_ticket(
    session: AsyncSession, ticket_id: uuid.UUID, data: TicketUpdate
) -> Ticket:
    ticket = await get_ticket(session, ticket_id)
    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(ticket, key, value)
    await session.commit()
    await session.refresh(ticket)
    return ticket


async def delete_ticket(session: AsyncSession, ticket_id: uuid.UUID) -> None:
    ticket = await get_ticket(session, ticket_id)
    await session.delete(ticket)
    await session.commit()
