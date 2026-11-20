import uuid
from enum import StrEnum

from sqlalchemy import CheckConstraint, Enum, ForeignKey, Index, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base
from app.models.base import PKMixin, TimestampMixin
from app.models.enums import TechFit


class Confidence(StrEnum):
    low = "low"
    medium = "medium"
    high = "high"


class CapabilityGuess(PKMixin, TimestampMixin, Base):
    """A link nothing has confirmed: "this feature (or technology) is most
    likely built on this capability", with a confidence.

    Owner's rule (2026-11-20): when there is no access to the feature, the
    codebase, the user or a public page that shows it, metis may only guess.
    Guesses live in their own table so nothing that reads confirmed links
    (feature_capabilities, tech_satisfactions) counts them by accident.
    Confirming one moves it into the confirmed table; rejecting deletes it.
    Editors and admins see guesses; viewers and agents do not.

    CASCADE everywhere: a guess about a thing that is gone means nothing."""

    __tablename__ = "capability_guesses"
    __table_args__ = (
        CheckConstraint("(feature_id is null) <> (tech_id is null)", name="ck_capability_guesses_one_subject"),
        CheckConstraint("fit is null or tech_id is not null", name="ck_capability_guesses_fit_for_tech"),
        UniqueConstraint("feature_id", "capability_id"),
        UniqueConstraint("tech_id", "capability_id"),
        Index("ix_capability_guesses_cap", "capability_id"),
    )

    capability_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("capabilities.id", ondelete="CASCADE")
    )
    feature_id: Mapped[uuid.UUID | None] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("features.id", ondelete="CASCADE")
    )
    tech_id: Mapped[uuid.UUID | None] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("technologies.id", ondelete="CASCADE")
    )
    confidence: Mapped[Confidence] = mapped_column(Enum(Confidence, native_enum=False))
    #: One sentence: why we think so ("pricing page lists SSO").
    basis: Mapped[str | None] = mapped_column(Text)
    #: Only for a technology guess; becomes the satisfaction's fit on confirm.
    fit: Mapped[TechFit | None] = mapped_column(Enum(TechFit, native_enum=False))
