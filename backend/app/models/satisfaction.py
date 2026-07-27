import uuid
from typing import Any

from sqlalchemy import Enum, ForeignKey, Index, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base
from app.models.base import PKMixin, TimestampMixin
from app.models.enums import TechFit


class TechSatisfaction(PKMixin, TimestampMixin, Base):
    """The hinge: Technology SATISFIES Capability — the buy-side mirror of
    features.capability_id. The asymmetry is deliberate: a feature realizes
    exactly one capability, a technology serves many. RESTRICT matches the
    feature FK so a capability with supply cannot be deleted under a stack."""

    __tablename__ = "tech_satisfactions"
    __table_args__ = (
        UniqueConstraint("tech_id", "capability_id"),
        Index("ix_tech_satisfactions_cap", "capability_id", "fit"),
    )

    tech_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("technologies.id", ondelete="CASCADE")
    )
    capability_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("capabilities.id", ondelete="RESTRICT")
    )
    fit: Mapped[TechFit] = mapped_column(Enum(TechFit, native_enum=False))
    #: {license, ops_burden, familiarity, lock_in} as 0..3 ints. Left empty
    #: until a written rubric exists — a number nobody can defend is worse than
    #: no number, because it looks defensible.
    cost: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    notes: Mapped[str | None] = mapped_column(Text)
