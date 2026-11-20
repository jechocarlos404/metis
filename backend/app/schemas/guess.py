import uuid

from pydantic import BaseModel, model_validator

from app.models.enums import TechFit
from app.models.guess import Confidence
from app.schemas.common import Stamped


class GuessCreate(BaseModel):
    """Exactly one of feature_id / tech_id. Posting the same pair again
    updates its confidence and basis (seed re-imports are idempotent)."""

    capability_id: uuid.UUID
    feature_id: uuid.UUID | None = None
    tech_id: uuid.UUID | None = None
    confidence: Confidence
    basis: str | None = None
    fit: TechFit | None = None

    @model_validator(mode="after")
    def _one_subject(self):
        if (self.feature_id is None) == (self.tech_id is None):
            raise ValueError("Give exactly one of feature_id or tech_id")
        if self.fit is not None and self.tech_id is None:
            raise ValueError("fit applies only to a technology guess")
        return self


class GuessRead(Stamped):
    capability_id: uuid.UUID
    feature_id: uuid.UUID | None
    tech_id: uuid.UUID | None
    confidence: Confidence
    basis: str | None
    fit: TechFit | None
    # Names so a screen can show a guess without a second lookup.
    capability_name: str
    capability_slug: str
    subject_name: str
    product_id: uuid.UUID | None = None
