import uuid
from datetime import date

from sqlalchemy import Date, Enum, ForeignKey, Index, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base
from app.models.base import PKMixin, TimestampMixin
from app.models.enums import AdoptionStatus, EncounterDepth


class Adoption(PKMixin, TimestampMixin, Base):
    """The group's stance on a world technology. One row per technology, and the
    ABSENCE of a row is meaningful — no stance taken. Never backfill a default
    to make the join inner. Multi-group later widens the unique key to
    (tech_id, org_unit_id); the catalog above never forks."""

    __tablename__ = "adoptions"
    __table_args__ = (
        UniqueConstraint("tech_id"),
        Index("ix_adoptions_status", "status"),
    )

    tech_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("technologies.id", ondelete="CASCADE")
    )
    status: Mapped[AdoptionStatus] = mapped_column(Enum(AdoptionStatus, native_enum=False))
    since: Mapped[date | None] = mapped_column(Date)
    owner: Mapped[str | None] = mapped_column(Text)
    rationale: Mapped[str | None] = mapped_column(Text)
    evidence_anchors: Mapped[list[str]] = mapped_column(ARRAY(Text), default=list)


class Encounter(PKMixin, TimestampMixin, Base):
    """Who here has touched this. Deliberately the weakest table in the ontology:
    a text handle, no FK to people, no proficiency scale, no endorsements, no
    prerequisite graph. It answers "who could I ask", not "who is qualified"."""

    __tablename__ = "encounters"
    __table_args__ = (
        UniqueConstraint("tech_id", "person", "product_id"),
        Index("ix_encounters_tech", "tech_id"),
    )

    tech_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("technologies.id", ondelete="CASCADE")
    )
    person: Mapped[str] = mapped_column(Text)  # a handle. There is no members table.
    product_id: Mapped[uuid.UUID | None] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("products.id", ondelete="SET NULL")
    )
    depth: Mapped[EncounterDepth] = mapped_column(Enum(EncounterDepth, native_enum=False))
    last_at: Mapped[date] = mapped_column(Date)
