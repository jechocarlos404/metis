import uuid

from fastapi import APIRouter, Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.schemas.guess import GuessCreate, GuessRead
from app.services import guesses as guess_service

router = APIRouter(prefix="/api/guesses", tags=["guesses"])


@router.get("", response_model=list[GuessRead])
async def list_guesses(
    feature_id: uuid.UUID | None = None,
    tech_id: uuid.UUID | None = None,
    capability_id: uuid.UUID | None = None,
    product_id: uuid.UUID | None = None,
    session: AsyncSession = Depends(get_db),
):
    return await guess_service.list_guesses(
        session, feature_id=feature_id, tech_id=tech_id, capability_id=capability_id, product_id=product_id
    )


@router.post("", response_model=GuessRead, status_code=201)
async def record_guess(data: GuessCreate, session: AsyncSession = Depends(get_db)):
    return await guess_service.record_guess(session, data)


@router.post("/{guess_id}/confirm", status_code=204)
async def confirm_guess(guess_id: uuid.UUID, request: Request, session: AsyncSession = Depends(get_db)):
    await guess_service.confirm_guess(session, guess_id, getattr(request.app.state, "graph", None))


@router.delete("/{guess_id}", status_code=204)
async def reject_guess(guess_id: uuid.UUID, session: AsyncSession = Depends(get_db)):
    await guess_service.reject_guess(session, guess_id)
