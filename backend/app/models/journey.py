import uuid

from sqlalchemy import ForeignKey, Integer, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base
from app.models.base import PKMixin, TimestampMixin


class Journey(PKMixin, TimestampMixin, Base):
    """A customer journey: an ordered path of features a person moves through.

    It may stay inside one product or cross several (ours and external) — a
    journey across features that exist elsewhere is a product idea. Which
    products it touches is derived from its steps, never stored."""

    __tablename__ = "journeys"

    name: Mapped[str] = mapped_column(Text)
    #: Who walks it and what they're after ("a commuter planning a hilly ride").
    persona: Mapped[str | None] = mapped_column(Text)
    description: Mapped[str | None] = mapped_column(Text)

    steps: Mapped[list["JourneyStep"]] = relationship(
        back_populates="journey",
        lazy="selectin",
        cascade="all, delete-orphan",
        order_by="JourneyStep.position",
    )


class JourneyStep(PKMixin, Base):
    """One step. Either it points at a feature that exists — whose capability
    links are the truth about what it needs — or it is a step nobody has built,
    named with the capabilities it would need (`needs`, possibly none known).

    `label` is always kept, so a deleted feature leaves a visible gap rather
    than a silently shorter journey."""

    __tablename__ = "journey_steps"

    journey_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("journeys.id", ondelete="CASCADE")
    )
    position: Mapped[int] = mapped_column(Integer)
    feature_id: Mapped[uuid.UUID | None] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("features.id", ondelete="SET NULL")
    )
    label: Mapped[str] = mapped_column(Text)
    #: Capability names an unbuilt step would need. Ignored while a feature is set.
    needs: Mapped[list[str]] = mapped_column(JSONB, default=list)
    note: Mapped[str | None] = mapped_column(Text)

    journey: Mapped[Journey] = relationship(back_populates="steps")
