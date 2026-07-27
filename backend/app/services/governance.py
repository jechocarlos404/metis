"""Governance — the filters over the market.

A Constraint is a hard rule that prunes candidates *before* fit is scored.
A Concern is a cross-cutting non-functional axis. The difference from a
capability is obligation: an unmet capability is a roadmap item, an unanswered
concern is a review blocker.
"""

import uuid

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Concern, Constraint, ConstraintScope, Product, TechStack
from app.schemas.governance import (
    ConcernCreate,
    ConcernUpdate,
    ConstraintCreate,
    ConstraintUpdate,
    ScopeWrite,
)


async def list_constraints(session: AsyncSession) -> list[Constraint]:
    return list((await session.scalars(select(Constraint).order_by(Constraint.seq))).all())


async def get_constraint(session: AsyncSession, constraint_id: uuid.UUID) -> Constraint:
    constraint = await session.get(Constraint, constraint_id)
    if constraint is None:
        raise HTTPException(404, "Constraint not found")
    return constraint


def _check_expression(expression: dict) -> None:
    """One shape, on purpose: {"field": <facet key>, "not_in": [...]}. Operators
    get added when a real rule needs one, never in advance."""
    if not isinstance(expression.get("field"), str) or not isinstance(
        expression.get("not_in"), list
    ):
        raise HTTPException(
            422,
            'Expression must be {"field": <facet key>, "not_in": [...]} — the '
            "only shape the pruner evaluates.",
        )


async def create_constraint(session: AsyncSession, data: ConstraintCreate) -> Constraint:
    _check_expression(data.expression)
    constraint = Constraint(**data.model_dump())
    session.add(constraint)
    await session.commit()
    await session.refresh(constraint)
    return constraint


async def update_constraint(
    session: AsyncSession, constraint_id: uuid.UUID, data: ConstraintUpdate
) -> Constraint:
    constraint = await get_constraint(session, constraint_id)
    fields = data.model_dump(exclude_unset=True)
    if "expression" in fields:
        _check_expression(fields["expression"])
    for key, value in fields.items():
        setattr(constraint, key, value)
    await session.commit()
    await session.refresh(constraint)
    return constraint


async def delete_constraint(session: AsyncSession, constraint_id: uuid.UUID) -> None:
    await session.delete(await get_constraint(session, constraint_id))
    await session.commit()


async def list_scopes(
    session: AsyncSession, constraint_id: uuid.UUID
) -> list[ConstraintScope]:
    await get_constraint(session, constraint_id)
    stmt = (
        select(ConstraintScope)
        .where(ConstraintScope.constraint_id == constraint_id)
        .order_by(ConstraintScope.seq)
    )
    return list((await session.scalars(stmt)).all())


async def add_scope(
    session: AsyncSession, constraint_id: uuid.UUID, data: ScopeWrite
) -> ConstraintScope:
    await get_constraint(session, constraint_id)
    if data.product_id is not None and data.stack_id is not None:
        raise HTTPException(422, "Scope a constraint to a product or a stack, not both")
    if data.product_id is not None and await session.get(Product, data.product_id) is None:
        raise HTTPException(404, "Product not found")
    if data.stack_id is not None and await session.get(TechStack, data.stack_id) is None:
        raise HTTPException(404, "Stack not found")
    existing = await session.scalar(
        select(ConstraintScope).where(
            ConstraintScope.constraint_id == constraint_id,
            ConstraintScope.product_id.is_(data.product_id)
            if data.product_id is None
            else ConstraintScope.product_id == data.product_id,
            ConstraintScope.stack_id.is_(data.stack_id)
            if data.stack_id is None
            else ConstraintScope.stack_id == data.stack_id,
        )
    )
    if existing is not None:
        return existing
    scope = ConstraintScope(constraint_id=constraint_id, **data.model_dump())
    session.add(scope)
    await session.commit()
    await session.refresh(scope)
    return scope


async def remove_scope(session: AsyncSession, scope_id: uuid.UUID) -> None:
    scope = await session.get(ConstraintScope, scope_id)
    if scope is None:
        raise HTTPException(404, "Scope not found")
    await session.delete(scope)
    await session.commit()


async def list_concerns(session: AsyncSession) -> list[Concern]:
    return list((await session.scalars(select(Concern).order_by(Concern.seq))).all())


async def get_concern(session: AsyncSession, concern_id: uuid.UUID) -> Concern:
    concern = await session.get(Concern, concern_id)
    if concern is None:
        raise HTTPException(404, "Concern not found")
    return concern


async def create_concern(session: AsyncSession, data: ConcernCreate) -> Concern:
    concern = Concern(**data.model_dump())
    session.add(concern)
    await session.commit()
    await session.refresh(concern)
    return concern


async def update_concern(
    session: AsyncSession, concern_id: uuid.UUID, data: ConcernUpdate
) -> Concern:
    concern = await get_concern(session, concern_id)
    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(concern, key, value)
    await session.commit()
    await session.refresh(concern)
    return concern


async def delete_concern(session: AsyncSession, concern_id: uuid.UUID) -> None:
    await session.delete(await get_concern(session, concern_id))
    await session.commit()
