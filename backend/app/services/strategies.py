import uuid

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import DeliveryStrategy
from app.schemas.strategy import StrategyCreate


async def list_strategies(
    session: AsyncSession, product_id: uuid.UUID
) -> list[DeliveryStrategy]:
    stmt = (
        select(DeliveryStrategy)
        .where(DeliveryStrategy.product_id == product_id)
        .order_by(DeliveryStrategy.version.desc())
    )
    return list((await session.scalars(stmt)).all())


async def create_strategy(
    session: AsyncSession, product_id: uuid.UUID, data: StrategyCreate
) -> DeliveryStrategy:
    max_version = await session.scalar(
        select(func.max(DeliveryStrategy.version)).where(
            DeliveryStrategy.product_id == product_id
        )
    )
    strategy = DeliveryStrategy(
        product_id=product_id, version=(max_version or 0) + 1, **data.model_dump()
    )
    session.add(strategy)
    await session.commit()
    await session.refresh(strategy)
    return strategy
