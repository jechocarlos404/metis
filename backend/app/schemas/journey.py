import uuid
from typing import Literal

from pydantic import BaseModel, Field, model_validator

from app.models.enums import WorkStatus
from app.schemas.capability import CoverageReport, FeatureCoverage, ProductRef
from app.schemas.common import ORMModel, Stamped


class JourneyStepIn(BaseModel):
    #: An existing feature; its capability links say what the step needs.
    feature_id: uuid.UUID | None = None
    #: Required for an unbuilt step; defaults to the feature's name otherwise.
    label: str | None = None
    #: Capability names an unbuilt step would need (ignored when feature_id is set).
    needs: list[str] = []
    note: str | None = None

    @model_validator(mode="after")
    def _named(self):
        if self.feature_id is None and not (self.label or "").strip():
            raise ValueError("an unbuilt step needs a label")
        return self


class JourneyCreate(BaseModel):
    name: str = Field(min_length=1)
    persona: str | None = None
    description: str | None = None
    steps: list[JourneyStepIn] = []


class JourneyUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1)
    persona: str | None = None
    description: str | None = None
    #: The whole new path, in order; omit to leave the steps alone.
    steps: list[JourneyStepIn] | None = None


class JourneyStepRead(ORMModel):
    id: uuid.UUID
    position: int
    feature_id: uuid.UUID | None
    label: str
    needs: list[str]
    note: str | None


class JourneyRead(Stamped):
    name: str
    persona: str | None
    description: str | None
    steps: list[JourneyStepRead]


class StepFeature(BaseModel):
    id: uuid.UUID
    name: str
    status: WorkStatus
    unknown_capabilities: bool
    external: bool
    product: ProductRef | None


#: The product score's vocabulary, per step:
#: buildable — every capability it needs is ours (and the list is complete);
#: known_covered — every capability anyone named is ours, but the list is
#:   declared incomplete, so this is weaker;
#: missing — at least one named capability isn't ours;
#: unknown — nobody named any capability for it.
Verdict = Literal["buildable", "known_covered", "missing", "unknown"]


class StepAnalysis(BaseModel):
    position: int
    label: str
    note: str | None
    #: None for a step nobody built, or whose feature was deleted.
    feature: StepFeature | None
    #: A user can do this today in one of our products (done, ours).
    live: bool
    verdict: Verdict
    coverage: FeatureCoverage | None


class JourneyAnalysis(BaseModel):
    journey: JourneyRead
    steps: list[StepAnalysis]
    #: Products the path passes through, in order of first appearance.
    products: list[ProductRef]
    external_products: list[ProductRef]
    counts: dict[Verdict, int]
    live: int
    report: CoverageReport | None
