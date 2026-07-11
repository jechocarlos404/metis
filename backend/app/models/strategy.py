import uuid
from typing import Any

from sqlalchemy import ForeignKey, Integer, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base
from app.models.base import PKMixin, TimestampMixin


class DeliveryStrategy(PKMixin, TimestampMixin, Base):
    """Versioned phased delivery plan; version history doubles as delivery_history."""

    __tablename__ = "delivery_strategies"
    __table_args__ = (UniqueConstraint("product_id", "version"),)

    product_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("products.id", ondelete="CASCADE")
    )
    version: Mapped[int] = mapped_column(Integer)
    phases: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, default=list)
    rationale: Mapped[str | None] = mapped_column(Text)
    created_by: Mapped[str] = mapped_column(Text, default="user")
