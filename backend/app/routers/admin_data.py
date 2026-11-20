"""Admin data browser: the three missing global lists, plus cascade delete.

Two routers because they carry different rights. The lists are ordinary reads —
they only fill gaps in existing coverage and expose nothing new. Cascade delete
is the one write in the app that deliberately bypasses an ontology invariant, so
it is mounted admin-only *and* behind the desktop-surface check.
"""

import uuid

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.models import Capability, Goal, Motivation, Product, ProductBundle, Ticket
from app.schemas.admin import (
    CascadeRequest,
    CascadeResult,
    MotivationRow,
    ProductBundleRow,
)
from app.schemas.work import TicketRead
from app.services import admin_cascade

rows_router = APIRouter(prefix="/api", tags=["admin-data"])
cascade_router = APIRouter(prefix="/api/admin/data", tags=["admin-data"])


@rows_router.get("/motivations", response_model=list[MotivationRow])
async def list_motivations(session: AsyncSession = Depends(get_db)):
    """Join rows with their own id — /capabilities/{id}/motivations returns the
    linked goals instead, so the row itself is unaddressable anywhere else."""
    result = await session.execute(
        select(
            Motivation.id,
            Motivation.seq,
            Motivation.goal_id,
            Goal.title.label("goal_title"),
            Motivation.capability_id,
            Capability.name.label("capability_name"),
        )
        .join(Goal, Goal.id == Motivation.goal_id)
        .join(Capability, Capability.id == Motivation.capability_id)
        .order_by(Motivation.seq)
    )
    return list(result.mappings().all())


@rows_router.get("/product-bundles", response_model=list[ProductBundleRow])
async def list_product_bundles(session: AsyncSession = Depends(get_db)):
    result = await session.execute(
        select(
            ProductBundle.id,
            ProductBundle.seq,
            ProductBundle.product_id,
            Product.name.label("product_name"),
            ProductBundle.capability_id,
            Capability.name.label("capability_name"),
        )
        .join(Product, Product.id == ProductBundle.product_id)
        .join(Capability, Capability.id == ProductBundle.capability_id)
        .order_by(ProductBundle.seq)
    )
    return list(result.mappings().all())


@rows_router.get("/tickets", response_model=list[TicketRead])
async def list_all_tickets(
    limit: int = Query(500, le=2000),
    offset: int = 0,
    session: AsyncSession = Depends(get_db),
):
    """Across all products — every other ticket read is product-scoped."""
    stmt = select(Ticket).order_by(Ticket.seq).limit(limit).offset(offset)
    return list((await session.scalars(stmt)).all())


@cascade_router.post("/cascade-preview", response_model=admin_cascade.NamedPreview)
async def cascade_preview(data: CascadeRequest, session: AsyncSession = Depends(get_db)):
    return await admin_cascade.preview(session, data.rows)


@cascade_router.post("/cascade-delete", response_model=CascadeResult)
async def cascade_delete(
    data: CascadeRequest, request: Request, session: AsyncSession = Depends(get_db)
):
    graph = getattr(request.app.state, "graph", None)
    return await admin_cascade.execute(session, data.rows, graph)
