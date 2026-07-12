import uuid

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.schemas.capability import (
    CapabilityCreate,
    CapabilityNode,
    CapabilityRead,
    CapabilityUpdate,
    HealthFinding,
    MotivationCreate,
    Rollup,
)
from app.schemas.feature import FeatureRead
from app.schemas.goal import GoalRead
from app.services import capabilities as capability_service

router = APIRouter(prefix="/api/capabilities", tags=["capabilities"])


def get_graph(request: Request):
    return getattr(request.app.state, "graph", None)


@router.get("", response_model=list[CapabilityRead])
async def list_capabilities(session: AsyncSession = Depends(get_db)):
    return await capability_service.list_capabilities(session)


@router.post("", response_model=CapabilityRead, status_code=201)
async def create_capability(data: CapabilityCreate, session: AsyncSession = Depends(get_db)):
    return await capability_service.create_capability(session, data)


# NB: static routes must be registered before /{capability_id}.
@router.get("/map", response_model=list[CapabilityNode])
async def capability_map(session: AsyncSession = Depends(get_db)):
    return await capability_service.capability_map(session)


@router.get("/health", response_model=list[HealthFinding])
async def health(session: AsyncSession = Depends(get_db)):
    return await capability_service.health(session)


@router.get("/{capability_id}", response_model=CapabilityRead)
async def get_capability(capability_id: uuid.UUID, session: AsyncSession = Depends(get_db)):
    return await capability_service.get_capability(session, capability_id)


@router.patch("/{capability_id}", response_model=CapabilityRead)
async def update_capability(
    capability_id: uuid.UUID, data: CapabilityUpdate, session: AsyncSession = Depends(get_db)
):
    return await capability_service.update_capability(session, capability_id, data)


@router.delete("/{capability_id}", status_code=204)
async def delete_capability(capability_id: uuid.UUID, session: AsyncSession = Depends(get_db)):
    await capability_service.delete_capability(session, capability_id)


@router.get("/{capability_id}/scope", response_model=list[FeatureRead])
async def scope(capability_id: uuid.UUID, session: AsyncSession = Depends(get_db)):
    return await capability_service.scope(session, capability_id)


@router.get("/{capability_id}/rollup", response_model=Rollup)
async def rollup(capability_id: uuid.UUID, session: AsyncSession = Depends(get_db)):
    return await capability_service.rollup(session, capability_id)


@router.get("/{capability_id}/impact")
async def impact(
    capability_id: uuid.UUID, request: Request, session: AsyncSession = Depends(get_db)
):
    """Blast radius at capability resolution, over the coupling projection."""
    graph = get_graph(request)
    if graph is None:
        raise HTTPException(503, "Graph not initialized")
    await graph.ensure_fresh()
    ids = await capability_service.submap_ids(session, capability_id)
    result = graph.capability_impact(ids)
    resolved = {}
    for group in ("dependents", "dependencies"):
        items = []
        for cid in result[group]:
            capability = await capability_service.get_capability(session, cid)
            items.append(CapabilityRead.model_validate(capability))
        resolved[group] = items
    return {"capability_id": str(capability_id), **resolved}


@router.get("/{capability_id}/motivations", response_model=list[GoalRead])
async def motivations(capability_id: uuid.UUID, session: AsyncSession = Depends(get_db)):
    return await capability_service.motivating_goals(session, capability_id)


@router.post("/{capability_id}/motivations", status_code=201)
async def add_motivation(
    capability_id: uuid.UUID, data: MotivationCreate, session: AsyncSession = Depends(get_db)
):
    motivation = await capability_service.add_motivation(session, capability_id, data.goal_id)
    return {"id": str(motivation.id)}


@router.delete("/{capability_id}/motivations/{goal_id}", status_code=204)
async def remove_motivation(
    capability_id: uuid.UUID, goal_id: uuid.UUID, session: AsyncSession = Depends(get_db)
):
    await capability_service.remove_motivation(session, capability_id, goal_id)
