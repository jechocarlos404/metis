"""Keyword + trigram feature search (replaces the predecessor's Qdrant vectors)."""

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Feature


async def search_features(session: AsyncSession, q: str, limit: int = 20) -> list[Feature]:
    q = q.strip()
    if not q:
        return []
    similarity = func.similarity(Feature.name, q)
    stmt = (
        select(Feature)
        .where(
            or_(
                Feature.name.ilike(f"%{q}%"),
                Feature.description.ilike(f"%{q}%"),
                similarity > 0.15,
            )
        )
        .order_by(similarity.desc(), Feature.seq)
        .limit(limit)
    )
    return list((await session.scalars(stmt)).all())
