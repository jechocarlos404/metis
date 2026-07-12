import uuid

from sqlalchemy import Enum, ForeignKey, Integer, Text
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base
from app.models.base import PKMixin, TimestampMixin
from app.models.enums import ContextBudget, WorkStatus


class Epic(PKMixin, TimestampMixin, Base):
    __tablename__ = "epics"

    product_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("products.id", ondelete="CASCADE")
    )
    decomposition_id: Mapped[uuid.UUID | None] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("product_decompositions.id", ondelete="CASCADE")
    )
    capability_id: Mapped[uuid.UUID | None] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("capabilities.id", ondelete="SET NULL")
    )
    title: Mapped[str] = mapped_column(Text)
    acceptance_criteria: Mapped[str | None] = mapped_column(Text)
    position: Mapped[int] = mapped_column(Integer, default=0)

    stories: Mapped[list["Story"]] = relationship(
        back_populates="epic", cascade="all, delete-orphan", order_by="Story.position"
    )
    tickets: Mapped[list["Ticket"]] = relationship(
        back_populates="epic", cascade="all, delete-orphan", order_by="Ticket.position"
    )


class Story(PKMixin, TimestampMixin, Base):
    __tablename__ = "stories"

    epic_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("epics.id", ondelete="CASCADE")
    )
    feature_id: Mapped[uuid.UUID | None] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("features.id", ondelete="SET NULL")
    )
    title: Mapped[str] = mapped_column(Text)
    description: Mapped[str | None] = mapped_column(Text)
    position: Mapped[int] = mapped_column(Integer, default=0)

    epic: Mapped[Epic] = relationship(back_populates="stories")


class Ticket(PKMixin, TimestampMixin, Base):
    """Atomic unit of work — sized to fit one Claude session (context_budget)."""

    __tablename__ = "tickets"

    product_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("products.id", ondelete="CASCADE")
    )
    epic_id: Mapped[uuid.UUID | None] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("epics.id", ondelete="CASCADE")
    )
    story_id: Mapped[uuid.UUID | None] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("stories.id", ondelete="SET NULL")
    )
    title: Mapped[str] = mapped_column(Text)
    description: Mapped[str | None] = mapped_column(Text)
    technical_approach: Mapped[str | None] = mapped_column(Text)
    acceptance_criteria: Mapped[str | None] = mapped_column(Text)
    affected_files: Mapped[list[str]] = mapped_column(ARRAY(Text), default=list)
    context_budget: Mapped[ContextBudget] = mapped_column(
        Enum(ContextBudget, native_enum=False), default=ContextBudget.M
    )
    status: Mapped[WorkStatus] = mapped_column(
        Enum(WorkStatus, native_enum=False), default=WorkStatus.pending
    )
    position: Mapped[int] = mapped_column(Integer, default=0)

    epic: Mapped[Epic | None] = relationship(back_populates="tickets")
