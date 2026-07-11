import uuid

from sqlalchemy import CheckConstraint, Enum, ForeignKey, Index, Integer, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base
from app.models.base import PKMixin, TimestampMixin
from app.models.enums import EdgeKind, FeatureType, WorkStatus


class Feature(PKMixin, TimestampMixin, Base):
    __tablename__ = "features"
    __table_args__ = (
        CheckConstraint("priority IS NULL OR (priority BETWEEN 1 AND 5)"),
        Index(
            "ix_features_name_trgm",
            "name",
            postgresql_using="gin",
            postgresql_ops={"name": "gin_trgm_ops"},
        ),
    )

    product_id: Mapped[uuid.UUID | None] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("products.id", ondelete="SET NULL")
    )
    name: Mapped[str] = mapped_column(Text)
    description: Mapped[str | None] = mapped_column(Text)
    type: Mapped[FeatureType] = mapped_column(
        Enum(FeatureType, native_enum=False), default=FeatureType.capability
    )
    status: Mapped[WorkStatus] = mapped_column(
        Enum(WorkStatus, native_enum=False), default=WorkStatus.pending
    )
    priority: Mapped[int | None] = mapped_column(Integer)
    priority_rationale: Mapped[str | None] = mapped_column(Text)


class FeatureEdge(PKMixin, Base):
    """Directed edge: src --kind--> dst. `A DEPENDS_ON B` means A depends on B."""

    __tablename__ = "feature_edges"
    __table_args__ = (
        UniqueConstraint("src_id", "dst_id", "kind"),
        CheckConstraint("src_id != dst_id"),
    )

    src_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("features.id", ondelete="CASCADE")
    )
    dst_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("features.id", ondelete="CASCADE")
    )
    kind: Mapped[EdgeKind] = mapped_column(Enum(EdgeKind, native_enum=False))
