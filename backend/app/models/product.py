import uuid
from typing import Any

from sqlalchemy import Boolean, Enum, ForeignKey, Integer, Text, UniqueConstraint, false
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base
from app.models.base import PKMixin, TimestampMixin
from app.models.enums import DocStatus


class Product(PKMixin, TimestampMixin, Base):
    """A Spec — what the product or feature set does. 'What it does, not how.'"""

    __tablename__ = "products"

    goal_id: Mapped[uuid.UUID | None] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("goals.id", ondelete="SET NULL")
    )
    #: Canonical address, stable across renames. See Capability.slug.
    slug: Mapped[str] = mapped_column(Text, unique=True)
    name: Mapped[str] = mapped_column(Text)
    summary: Mapped[str | None] = mapped_column(Text)
    body: Mapped[str | None] = mapped_column(Text)
    status: Mapped[DocStatus] = mapped_column(
        Enum(DocStatus, native_enum=False), default=DocStatus.draft
    )
    version: Mapped[int] = mapped_column(Integer, default=1)
    #: Someone else's product, known only from the outside — its features are
    #: what a user sees, never our work. Never counted as what we can do.
    external: Mapped[bool] = mapped_column(Boolean, default=False, server_default=false())

    decompositions: Mapped[list["ProductDecomposition"]] = relationship(
        back_populates="product", cascade="all, delete-orphan"
    )
    bundles: Mapped[list["ProductBundle"]] = relationship(
        back_populates="product", cascade="all, delete-orphan"
    )


class ProductDecomposition(PKMixin, TimestampMixin, Base):
    """A PRD version — JSONB snapshot of epics/stories/tickets, draft until approved."""

    __tablename__ = "product_decompositions"
    __table_args__ = (UniqueConstraint("product_id", "version"),)

    product_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("products.id", ondelete="CASCADE")
    )
    version: Mapped[int] = mapped_column(Integer)
    document: Mapped[dict[str, Any]] = mapped_column(JSONB)
    status: Mapped[DocStatus] = mapped_column(
        Enum(DocStatus, native_enum=False), default=DocStatus.draft
    )
    created_by: Mapped[str] = mapped_column(Text, default="user")

    product: Mapped[Product] = relationship(back_populates="decompositions")


class ProductBundle(PKMixin, Base):
    """Product BUNDLES Capability: explicit product surface / packaging edge."""

    __tablename__ = "product_bundles"
    __table_args__ = (UniqueConstraint("product_id", "capability_id"),)

    product_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("products.id", ondelete="CASCADE")
    )
    capability_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("capabilities.id", ondelete="CASCADE")
    )

    product: Mapped[Product] = relationship(back_populates="bundles")
