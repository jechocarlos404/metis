import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.models import Goal, GoalType
from app.schemas.goal import GoalCreate, GoalRead, GoalUpdate

router = APIRouter(prefix="/api/goals", tags=["goals"])


@router.get("", response_model=list[GoalRead])
async def list_goals(
    goal_type: GoalType | None = None, session: AsyncSession = Depends(get_db)
):
    stmt = select(Goal).order_by(Goal.seq)
    if goal_type is not None:
        stmt = stmt.where(Goal.goal_type == goal_type)
    return (await session.scalars(stmt)).all()


@router.post("", response_model=GoalRead, status_code=201)
async def create_goal(data: GoalCreate, session: AsyncSession = Depends(get_db)):
    if data.parent_goal_id is not None and await session.get(Goal, data.parent_goal_id) is None:
        raise HTTPException(404, "Parent goal not found")
    goal = Goal(**data.model_dump())
    session.add(goal)
    await session.commit()
    await session.refresh(goal)
    return goal


@router.get("/{goal_id}", response_model=GoalRead)
async def get_goal(goal_id: uuid.UUID, session: AsyncSession = Depends(get_db)):
    goal = await session.get(Goal, goal_id)
    if goal is None:
        raise HTTPException(404, "Goal not found")
    return goal


@router.patch("/{goal_id}", response_model=GoalRead)
async def update_goal(
    goal_id: uuid.UUID, data: GoalUpdate, session: AsyncSession = Depends(get_db)
):
    goal = await session.get(Goal, goal_id)
    if goal is None:
        raise HTTPException(404, "Goal not found")
    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(goal, key, value)
    await session.commit()
    await session.refresh(goal)
    return goal


@router.delete("/{goal_id}", status_code=204)
async def delete_goal(goal_id: uuid.UUID, session: AsyncSession = Depends(get_db)):
    goal = await session.get(Goal, goal_id)
    if goal is None:
        raise HTTPException(404, "Goal not found")
    await session.delete(goal)
    await session.commit()
