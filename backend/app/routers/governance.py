import uuid

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.schemas.governance import (
    ConcernCreate,
    ConcernRead,
    ConcernUpdate,
    ConstraintCreate,
    ConstraintRead,
    ConstraintUpdate,
    ScopeRead,
    ScopeWrite,
)
from app.services import governance as governance_service

constraints_router = APIRouter(prefix="/api/constraints", tags=["governance"])
concerns_router = APIRouter(prefix="/api/concerns", tags=["governance"])


@constraints_router.get("", response_model=list[ConstraintRead])
async def list_constraints(session: AsyncSession = Depends(get_db)):
    return await governance_service.list_constraints(session)


@constraints_router.post("", response_model=ConstraintRead, status_code=201)
async def create_constraint(data: ConstraintCreate, session: AsyncSession = Depends(get_db)):
    return await governance_service.create_constraint(session, data)


@constraints_router.patch("/{constraint_id}", response_model=ConstraintRead)
async def update_constraint(
    constraint_id: uuid.UUID,
    data: ConstraintUpdate,
    session: AsyncSession = Depends(get_db),
):
    return await governance_service.update_constraint(session, constraint_id, data)


@constraints_router.delete("/{constraint_id}", status_code=204)
async def delete_constraint(
    constraint_id: uuid.UUID, session: AsyncSession = Depends(get_db)
):
    await governance_service.delete_constraint(session, constraint_id)


@constraints_router.get("/{constraint_id}/scopes", response_model=list[ScopeRead])
async def list_scopes(constraint_id: uuid.UUID, session: AsyncSession = Depends(get_db)):
    return await governance_service.list_scopes(session, constraint_id)


@constraints_router.post("/{constraint_id}/scopes", response_model=ScopeRead, status_code=201)
async def add_scope(
    constraint_id: uuid.UUID, data: ScopeWrite, session: AsyncSession = Depends(get_db)
):
    """Both ids null scopes the constraint globally."""
    return await governance_service.add_scope(session, constraint_id, data)


@constraints_router.delete("/{constraint_id}/scopes/{scope_id}", status_code=204)
async def remove_scope(
    constraint_id: uuid.UUID, scope_id: uuid.UUID, session: AsyncSession = Depends(get_db)
):
    await governance_service.remove_scope(session, scope_id)


@concerns_router.get("", response_model=list[ConcernRead])
async def list_concerns(session: AsyncSession = Depends(get_db)):
    return await governance_service.list_concerns(session)


@concerns_router.post("", response_model=ConcernRead, status_code=201)
async def create_concern(data: ConcernCreate, session: AsyncSession = Depends(get_db)):
    return await governance_service.create_concern(session, data)


@concerns_router.patch("/{concern_id}", response_model=ConcernRead)
async def update_concern(
    concern_id: uuid.UUID, data: ConcernUpdate, session: AsyncSession = Depends(get_db)
):
    return await governance_service.update_concern(session, concern_id, data)


@concerns_router.delete("/{concern_id}", status_code=204)
async def delete_concern(concern_id: uuid.UUID, session: AsyncSession = Depends(get_db)):
    await governance_service.delete_concern(session, concern_id)
