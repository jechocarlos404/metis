"""PRD (product decomposition) lifecycle.

A PRD version is a JSONB snapshot that also materializes real epic/story/ticket
rows. Re-versioning is only allowed while every ticket is still pending; once
work starts, tickets are edited directly. Approving a PRD enforces the spec's
sizing rule: no ticket may be context_budget=L.
"""

import uuid

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    ContextBudget,
    DocStatus,
    Epic,
    Product,
    ProductDecomposition,
    Story,
    Ticket,
    WorkStatus,
)
from app.schemas.prd import PRDDocument


async def get_product(session: AsyncSession, product_id: uuid.UUID) -> Product:
    product = await session.get(Product, product_id)
    if product is None:
        raise HTTPException(404, "Product not found")
    return product


async def list_decompositions(
    session: AsyncSession, product_id: uuid.UUID
) -> list[ProductDecomposition]:
    stmt = (
        select(ProductDecomposition)
        .where(ProductDecomposition.product_id == product_id)
        .order_by(ProductDecomposition.version.desc())
    )
    return list((await session.scalars(stmt)).all())


async def create_prd_draft(
    session: AsyncSession,
    product_id: uuid.UUID,
    document: PRDDocument,
    created_by: str = "user",
) -> ProductDecomposition:
    await get_product(session, product_id)

    started = await session.scalar(
        select(func.count())
        .select_from(Ticket)
        .where(Ticket.product_id == product_id, Ticket.status != WorkStatus.pending)
    )
    if started:
        raise HTTPException(
            409,
            "Tickets are already in progress for this product — edit tickets "
            "directly instead of re-versioning the PRD.",
        )

    max_version = await session.scalar(
        select(func.max(ProductDecomposition.version)).where(
            ProductDecomposition.product_id == product_id
        )
    )
    decomposition = ProductDecomposition(
        product_id=product_id,
        version=(max_version or 0) + 1,
        document=document.model_dump(mode="json"),
        created_by=created_by,
    )
    session.add(decomposition)

    # Replace the previous materialization (all tickets are pending, so nothing is lost).
    for epic in await session.scalars(select(Epic).where(Epic.product_id == product_id)):
        await session.delete(epic)
    await session.flush()

    for epos, prd_epic in enumerate(document.epics):
        epic = Epic(
            product_id=product_id,
            decomposition_id=decomposition.id,
            title=prd_epic.title,
            acceptance_criteria=prd_epic.acceptance_criteria,
            position=epos,
        )
        session.add(epic)
        await session.flush()
        for spos, prd_story in enumerate(prd_epic.stories):
            story = Story(
                epic_id=epic.id,
                title=prd_story.title,
                description=prd_story.description,
                position=spos,
            )
            session.add(story)
            await session.flush()
            for tpos, prd_ticket in enumerate(prd_story.tickets):
                session.add(
                    Ticket(
                        product_id=product_id,
                        epic_id=epic.id,
                        story_id=story.id,
                        position=tpos,
                        **prd_ticket.model_dump(),
                    )
                )

    await session.commit()
    await session.refresh(decomposition)
    return decomposition


async def approve_decomposition(
    session: AsyncSession, decomposition_id: uuid.UUID
) -> ProductDecomposition:
    decomposition = await session.get(ProductDecomposition, decomposition_id)
    if decomposition is None:
        raise HTTPException(404, "Decomposition not found")

    l_tickets = list(
        await session.scalars(
            select(Ticket).where(
                Ticket.product_id == decomposition.product_id,
                Ticket.context_budget == ContextBudget.L,
            )
        )
    )
    if l_tickets:
        titles = ", ".join(t.title for t in l_tickets[:5])
        raise HTTPException(
            422,
            f"{len(l_tickets)} L-sized ticket(s) must be split before this PRD "
            f"is ready (one ticket = one Claude session): {titles}",
        )

    decomposition.status = DocStatus.approved
    await session.commit()
    await session.refresh(decomposition)
    return decomposition


async def approve_product(session: AsyncSession, product_id: uuid.UUID) -> Product:
    product = await get_product(session, product_id)
    product.status = DocStatus.approved
    await session.commit()
    await session.refresh(product)
    return product
