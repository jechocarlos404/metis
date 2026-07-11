import uuid

from pydantic import BaseModel, Field, computed_field

from app.models.enums import EdgeKind, FeatureType, WorkStatus
from app.schemas.common import Stamped, display


class FeatureCreate(BaseModel):
    product_id: uuid.UUID | None = None
    name: str
    description: str | None = None
    type: FeatureType = FeatureType.capability
    status: WorkStatus = WorkStatus.pending
    priority: int | None = Field(default=None, ge=1, le=5)
    priority_rationale: str | None = None


class FeatureUpdate(BaseModel):
    product_id: uuid.UUID | None = None
    name: str | None = None
    description: str | None = None
    type: FeatureType | None = None
    status: WorkStatus | None = None
    priority: int | None = Field(default=None, ge=1, le=5)
    priority_rationale: str | None = None


class FeatureRead(Stamped):
    product_id: uuid.UUID | None
    name: str
    description: str | None
    type: FeatureType
    status: WorkStatus
    priority: int | None
    priority_rationale: str | None

    @computed_field
    @property
    def display_id(self) -> str:
        return display("FTR", self.seq, 3)


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
