import uuid

from sqlalchemy import Enum, ForeignKey, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base
from app.models.base import PKMixin, TimestampMixin
from app.models.enums import CapabilityMaturity


class Capability(PKMixin, TimestampMixin, Base):
    """Slow-plane node: a durable noun ("ticket export") that matures and never
    ships. Containment (PART_OF) is the parent_id forest — single parent,
    acyclic. Progress is never stored here; it is the rollup over realizing
    features."""

    __tablename__ = "capabilities"

    parent_id: Mapped[uuid.UUID | None] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("capabilities.id", ondelete="SET NULL")
    )
    name: Mapped[str] = mapped_column(Text)
    description: Mapped[str | None] = mapped_column(Text)
    maturity: Mapped[CapabilityMaturity] = mapped_column(
        Enum(CapabilityMaturity, native_enum=False), default=CapabilityMaturity.planned
    )
    facets: Mapped[dict[str, str]] = mapped_column(JSONB, default=dict)
    evidence_anchors: Mapped[list[str]] = mapped_column(ARRAY(Text), default=list)

    children: Mapped[list["Capability"]] = relationship(
        remote_side="Capability.parent_id",
        primaryjoin="Capability.id == foreign(Capability.parent_id)",
        viewonly=True,
    )


class Motivation(PKMixin, Base):
    """Why-layer bridge: Goal MOTIVATES Capability."""

    __tablename__ = "motivations"
    __table_args__ = (UniqueConstraint("goal_id", "capability_id"),)

    goal_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("goals.id", ondelete="CASCADE")
    )
    capability_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("capabilities.id", ondelete="CASCADE")
    )
