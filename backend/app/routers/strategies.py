import uuid

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.schemas.strategy import StrategyCreate, StrategyRead
from app.services import strategies as strategy_service

router = APIRouter(prefix="/api", tags=["strategies"])


@router.get("/products/{product_id}/strategies", response_model=list[StrategyRead])
async def list_strategies(product_id: uuid.UUID, session: AsyncSession = Depends(get_db)):
    return await strategy_service.list_strategies(session, product_id)


@router.post(
    "/products/{product_id}/strategies", response_model=StrategyRead, status_code=201
)
async def create_strategy(
    product_id: uuid.UUID, data: StrategyCreate, session: AsyncSession = Depends(get_db)
):
    return await strategy_service.create_strategy(session, product_id, data)
