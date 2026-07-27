import uuid
from typing import Any

from sqlalchemy import CheckConstraint, Enum, ForeignKey, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base
from app.models.base import PKMixin, TimestampMixin
from app.models.enums import ConstraintKind, ConstraintSeverity


class Constraint(PKMixin, TimestampMixin, Base):
    """A hard rule that prunes candidates BEFORE fit is scored: "no AGPL",
    "identity data stays in-VPC". The expression is evaluated against a
    technology's facets. Keep it to one shape — {"field": ..., "not_in": [...]}
    — and add operators only when a real rule needs one; a general expression
    language is a trap."""

    __tablename__ = "constraints"

    name: Mapped[str] = mapped_column(Text)
    kind: Mapped[ConstraintKind] = mapped_column(Enum(ConstraintKind, native_enum=False))
    expression: Mapped[dict[str, Any]] = mapped_column(JSONB)
    severity: Mapped[ConstraintSeverity] = mapped_column(
        Enum(ConstraintSeverity, native_enum=False), default=ConstraintSeverity.block
    )


class ConstraintScope(PKMixin, Base):
    """Where a constraint applies: a product, a stack, or (both null) globally."""

    __tablename__ = "constraint_scopes"
    __table_args__ = (
        UniqueConstraint("constraint_id", "product_id", "stack_id"),
        CheckConstraint("num_nonnulls(product_id, stack_id) <= 1"),
    )

    constraint_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("constraints.id", ondelete="CASCADE")
    )
    product_id: Mapped[uuid.UUID | None] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("products.id", ondelete="CASCADE")
    )
    stack_id: Mapped[uuid.UUID | None] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("tech_stacks.id", ondelete="CASCADE")
    )


class Concern(PKMixin, TimestampMixin, Base):
    """A cross-cutting non-functional axis: auth, observability, cost, data
    residency. The difference from a capability is obligation — an unmet
    capability is a roadmap item, an unanswered concern is a review blocker."""

    __tablename__ = "concerns"

    name: Mapped[str] = mapped_column(Text)
    description: Mapped[str | None] = mapped_column(Text)


class StackConcernAnswer(PKMixin, Base):
    """Which slot answers a concern for a stack. Every stack must answer every
    concern with some slot."""

    __tablename__ = "stack_concern_answers"
    __table_args__ = (UniqueConstraint("stack_id", "concern_id"),)

    stack_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("tech_stacks.id", ondelete="CASCADE")
    )
    concern_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("concerns.id", ondelete="CASCADE")
    )
    slot_id: Mapped[uuid.UUID | None] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("stack_slots.id", ondelete="SET NULL")
    )
