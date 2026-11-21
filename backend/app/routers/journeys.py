import uuid

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.models import Journey
from app.schemas.capability import MAX_NAME
from app.schemas.journey import JourneyAnalysis, JourneyCreate, JourneyRead, JourneyUpdate
from app.services import capabilities as capability_service
from app.services import journeys as journey_service

router = APIRouter(prefix="/api", tags=["journeys"])


@router.get("/journeys", response_model=list[JourneyRead])
async def list_journeys(
    feature_id: uuid.UUID | None = None,
    near: str | None = Query(None, max_length=MAX_NAME),
    session: AsyncSession = Depends(get_db),
):
    """All journeys, or those passing through one feature. With `near`, only
    those whose name is near it (three at most, nearest first): candidates
    after an exact miss, never a match."""
    if near is not None:
        return (await capability_service.near_names(session, Journey, [near]))[near]
    return await journey_service.list_journeys(session, feature_id)


@router.post("/journeys", response_model=JourneyRead, status_code=201)
async def create_journey(data: JourneyCreate, session: AsyncSession = Depends(get_db)):
    return await journey_service.create_journey(session, data)


@router.get("/journeys/{journey_id}", response_model=JourneyRead)
async def get_journey(journey_id: uuid.UUID, session: AsyncSession = Depends(get_db)):
    return await journey_service.get_journey(session, journey_id)


@router.patch("/journeys/{journey_id}", response_model=JourneyRead)
async def update_journey(
    journey_id: uuid.UUID, data: JourneyUpdate, session: AsyncSession = Depends(get_db)
):
    return await journey_service.update_journey(session, journey_id, data)


@router.delete("/journeys/{journey_id}", status_code=204)
async def delete_journey(journey_id: uuid.UUID, session: AsyncSession = Depends(get_db)):
    await journey_service.delete_journey(session, journey_id)


@router.get("/journeys/{journey_id}/analysis", response_model=JourneyAnalysis)
async def journey_analysis(journey_id: uuid.UUID, session: AsyncSession = Depends(get_db)):
    """Each step against the inventory: live today, buildable, or missing what."""
    return await journey_service.analyze(session, journey_id)
