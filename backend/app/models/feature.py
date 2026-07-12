import uuid

from sqlalchemy import CheckConstraint, Enum, ForeignKey, Index, Integer, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base
from app.models.base import PKMixin, TimestampMixin
from app.models.enums import EdgeKind, WorkStatus


class Feature(PKMixin, TimestampMixin, Base):
    """Fast-plane node: a change (verb phrase) that REALIZES exactly one
    capability. capability_id is NOT NULL by design — the schema refuses what
    the prompt failed to prevent. Facets carry classification (layer, persona);
    they filter queries and never participate in traversals."""

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

    capability_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("capabilities.id", ondelete="RESTRICT")
    )
    name: Mapped[str] = mapped_column(Text)
    description: Mapped[str | None] = mapped_column(Text)
    facets: Mapped[dict[str, str]] = mapped_column(JSONB, default=dict)
    status: Mapped[WorkStatus] = mapped_column(
        Enum(WorkStatus, native_enum=False), default=WorkStatus.pending
    )
    priority: Mapped[int | None] = mapped_column(Integer)
    priority_rationale: Mapped[str | None] = mapped_column(Text)


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
