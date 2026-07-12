import uuid

from pydantic import BaseModel, Field

from app.models.enums import EdgeKind, WorkStatus
from app.schemas.common import Stamped


class FeatureCreate(BaseModel):
    capability_id: uuid.UUID
    name: str
    description: str | None = None
    facets: dict[str, str] = Field(default_factory=dict)
    status: WorkStatus = WorkStatus.pending
    priority: int | None = Field(default=None, ge=1, le=5)
    priority_rationale: str | None = None


class FeatureUpdate(BaseModel):
    capability_id: uuid.UUID | None = None
    name: str | None = None
    description: str | None = None
    facets: dict[str, str] | None = None
    status: WorkStatus | None = None
    priority: int | None = Field(default=None, ge=1, le=5)
    priority_rationale: str | None = None


class FeatureRead(Stamped):
    capability_id: uuid.UUID
    name: str
    description: str | None
    facets: dict[str, str]
    status: WorkStatus
    priority: int | None
    priority_rationale: str | None


class EdgeCreate(BaseModel):
    src_id: uuid.UUID
    dst_id: uuid.UUID
    kind: EdgeKind = EdgeKind.DEPENDS_ON


class EdgeRead(BaseModel):
    model_config = {"from_attributes": True}

    id: uuid.UUID
    src_id: uuid.UUID
    dst_id: uuid.UUID
    kind: EdgeKind


class FeatureDetail(FeatureRead):
    """Feature plus its relationships, resolved from the in-memory graph."""

    outgoing: list[dict] = []
    incoming: list[dict] = []


class WhyStep(BaseModel):
    """One hop of the provenance chain: feature -> capability path -> goals."""

    kind: str  # "feature" | "capability" | "goal"
    id: uuid.UUID
    display_id: str | None = None  # goals only; features/capabilities go by name
    name: str
    relation: str  # relation that led here: "REALIZES" | "PART_OF" | "MOTIVATES" | "parent"


class WhyChain(BaseModel):
    feature_id: uuid.UUID
    chain: list[WhyStep]
