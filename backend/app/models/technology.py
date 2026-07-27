import uuid
from datetime import date

from sqlalchemy import (
    CheckConstraint,
    Date,
    Enum,
    ForeignKey,
    Index,
    Integer,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base
from app.models.base import PKMixin, TimestampMixin
from app.models.enums import TechEdgeKind, TechKind, TechLayer, VendorKind


class Vendor(PKMixin, TimestampMixin, Base):
    """Who stewards a technology. bus_factor is the governance fact a homepage
    URL never tells you: 1 means one maintainer."""

    __tablename__ = "vendors"
    __table_args__ = (CheckConstraint("bus_factor IS NULL OR bus_factor >= 1"),)

    name: Mapped[str] = mapped_column(Text)
    kind: Mapped[VendorKind] = mapped_column(Enum(VendorKind, native_enum=False))
    bus_factor: Mapped[int | None] = mapped_column(Integer)
    homepage: Mapped[str | None] = mapped_column(Text)

    technologies: Mapped[list["Technology"]] = relationship(back_populates="vendor")


class Technology(PKMixin, TimestampMixin, Base):
    """Buy-plane node: a thing that exists in the world (proper noun) whether or
    not anyone here has heard of it. Carries no field whose value depends on who
    is asking — all internal opinion lives in adoptions. Facets are filters only
    and never participate in traversals."""

    __tablename__ = "technologies"
    __table_args__ = (
        Index(
            "ix_technologies_name_trgm",
            "name",
            postgresql_using="gin",
            postgresql_ops={"name": "gin_trgm_ops"},
        ),
        Index(
            "ix_technologies_slug_trgm",
            "slug",
            postgresql_using="gin",
            postgresql_ops={"slug": "gin_trgm_ops"},
        ),
        Index("ix_technologies_kind_layer", "kind", "layer"),
    )

    #: canonical, kebab-case, unversioned: `apache-age`, `oauth-2.1`
    slug: Mapped[str] = mapped_column(Text, unique=True)
    name: Mapped[str] = mapped_column(Text)
    kind: Mapped[TechKind] = mapped_column(Enum(TechKind, native_enum=False))
    layer: Mapped[TechLayer | None] = mapped_column(Enum(TechLayer, native_enum=False))
    vendor_id: Mapped[uuid.UUID | None] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("vendors.id", ondelete="SET NULL")
    )
    homepage: Mapped[str | None] = mapped_column(Text)
    facets: Mapped[dict[str, str]] = mapped_column(JSONB, default=dict)
    evidence_anchors: Mapped[list[str]] = mapped_column(ARRAY(Text), default=list)

    vendor: Mapped[Vendor | None] = relationship(back_populates="technologies")


class TechVersion(PKMixin, TimestampMixin, Base):
    """EOL is a property of a release line, not of a technology. Without this
    table "what are we exposed to" is a guess; with it, a date comparison."""

    __tablename__ = "tech_versions"
    __table_args__ = (
        UniqueConstraint("tech_id", "label"),
        Index("ix_tech_versions_eol", "eol_on"),
    )

    tech_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("technologies.id", ondelete="CASCADE")
    )
    label: Mapped[str] = mapped_column(Text)  # '16', '3.12', '2024-10'
    released_on: Mapped[date | None] = mapped_column(Date)
    eol_on: Mapped[date | None] = mapped_column(Date)


class TechEdge(PKMixin, Base):
    """Directed edge on the buy plane, same shape as FeatureEdge.
    REQUIRES ∪ RUNS_ON is jointly acyclic and rejected at write time;
    ALTERNATIVE_TO is symmetric (write both rows); SUPERSEDES is what makes
    "what replaces X" one hop instead of a conversation."""

    __tablename__ = "tech_edges"
    __table_args__ = (
        UniqueConstraint("src_id", "dst_id", "kind"),
        CheckConstraint("src_id != dst_id"),
        Index("ix_tech_edges_dst", "dst_id", "kind"),
    )

    src_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("technologies.id", ondelete="CASCADE")
    )
    dst_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("technologies.id", ondelete="CASCADE")
    )
    kind: Mapped[TechEdgeKind] = mapped_column(Enum(TechEdgeKind, native_enum=False))
