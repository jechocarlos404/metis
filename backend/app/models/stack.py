import uuid

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Enum,
    ForeignKey,
    Index,
    Integer,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base
from app.models.base import PKMixin, TimestampMixin
from app.models.enums import TechLayer


class TechStack(PKMixin, TimestampMixin, Base):
    """Layered composition and archetype in one table — the same object at two
    levels of binding. An archetype (is_archetype, no product) is a shape to
    fill: slots with a capability and no tech. Instantiating copies the slots
    and binds tech; parent_id keeps the lineage so "which products still follow
    the archetype" stays answerable."""

    __tablename__ = "tech_stacks"
    __table_args__ = (
        CheckConstraint("NOT is_archetype OR product_id IS NULL"),
        Index("ix_tech_stacks_product", "product_id"),
    )

    name: Mapped[str] = mapped_column(Text)
    description: Mapped[str | None] = mapped_column(Text)
    is_archetype: Mapped[bool] = mapped_column(Boolean, default=False)
    parent_id: Mapped[uuid.UUID | None] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("tech_stacks.id", ondelete="SET NULL")
    )
    product_id: Mapped[uuid.UUID | None] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("products.id", ondelete="CASCADE")
    )

    slots: Mapped[list["StackSlot"]] = relationship(
        back_populates="stack",
        cascade="all, delete-orphan",
        order_by="(StackSlot.layer, StackSlot.position)",
    )


class StackSlot(PKMixin, TimestampMixin, Base):
    """layer + role + the capability it must answer. The unit that carries every
    interesting predicate: a required slot with no tech is a gap (never
    auto-filled — a gap is information), and two slots in one stack sharing a
    capability is redundancy."""

    __tablename__ = "stack_slots"
    __table_args__ = (
        UniqueConstraint("stack_id", "layer", "role", "position"),
        Index("ix_stack_slots_cap", "capability_id"),
        Index("ix_stack_slots_tech", "tech_id"),
    )

    stack_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("tech_stacks.id", ondelete="CASCADE")
    )
    layer: Mapped[TechLayer] = mapped_column(Enum(TechLayer, native_enum=False))
    role: Mapped[str] = mapped_column(Text)  # 'primary store', 'vector index'
    capability_id: Mapped[uuid.UUID | None] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("capabilities.id", ondelete="SET NULL")
    )
    tech_id: Mapped[uuid.UUID | None] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("technologies.id", ondelete="SET NULL")
    )
    required: Mapped[bool] = mapped_column(Boolean, default=True)
    position: Mapped[int] = mapped_column(Integer, default=0)

    stack: Mapped[TechStack] = relationship(back_populates="slots")


class ProductTechnology(PKMixin, Base):
    """Observed usage — the one table a script can populate, from lockfiles,
    Dockerfiles and Terraform rather than by hand. Follows ProductBundle: no
    timestamps. via_slot_id NULL means the product uses something its blessed
    stack never declared; that is stack drift, detected for free."""

    __tablename__ = "product_technologies"
    __table_args__ = (
        UniqueConstraint("product_id", "tech_id"),
        Index("ix_product_technologies_tech", "tech_id"),
    )

    product_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("products.id", ondelete="CASCADE")
    )
    tech_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("technologies.id", ondelete="CASCADE")
    )
    via_slot_id: Mapped[uuid.UUID | None] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("stack_slots.id", ondelete="SET NULL")
    )
