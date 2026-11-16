import uuid

from sqlalchemy import CheckConstraint, Enum, ForeignKey, Index, Integer, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base
from app.models.base import PKMixin, TimestampMixin
from app.models.enums import EdgeKind, WorkStatus


class Feature(PKMixin, TimestampMixin, Base):
    """Fast-plane node: a user-facing change that REALIZES one or more
    capabilities (feature_capabilities). "At least one" is enforced in the
    service — no column can express it — and violations surface as a health
    finding. product_id says whose feature this is; it is direct, never derived
    from capabilities, because capabilities are shared across products. Facets
    carry classification (layer, persona); they never participate in traversals."""

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
    facets: Mapped[dict[str, str]] = mapped_column(JSONB, default=dict)
    status: Mapped[WorkStatus] = mapped_column(
        Enum(WorkStatus, native_enum=False), default=WorkStatus.pending
    )
    priority: Mapped[int | None] = mapped_column(Integer)
    priority_rationale: Mapped[str | None] = mapped_column(Text)

    #: selectin, so every query that loads a Feature has its links in hand —
    #: async sessions cannot lazy-load on attribute access.
    capability_links: Mapped[list["FeatureCapability"]] = relationship(
        lazy="selectin",
        cascade="all, delete-orphan",
        order_by="FeatureCapability.seq",
    )

    @property
    def capability_ids(self) -> list[uuid.UUID]:
        return [link.capability_id for link in self.capability_links]


class FeatureCapability(PKMixin, Base):
    """Feature REALIZES Capability — the bridge between planes, many-to-many.
    capability_id is RESTRICT: a capability a feature relies on cannot be
    deleted out from under it (the admin cascade removes the links first)."""

    __tablename__ = "feature_capabilities"
    __table_args__ = (
        UniqueConstraint("feature_id", "capability_id"),
        Index("ix_feature_capabilities_cap", "capability_id"),
    )

    feature_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("features.id", ondelete="CASCADE")
    )
    capability_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("capabilities.id", ondelete="RESTRICT")
    )


class FeatureEdge(PKMixin, Base):
    """Directed edge: src --kind--> dst. `A DEPENDS_ON B` means A depends on B;
    `A BLOCKS B` means B cannot proceed until A lands. Both feed the precedence
    graph and are jointly acyclic; RELATES_TO is annotation only."""

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
