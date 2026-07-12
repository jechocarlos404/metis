import uuid

from pydantic import BaseModel, Field

from app.models.enums import CapabilityMaturity
from app.schemas.common import Stamped


class CapabilityCreate(BaseModel):
    parent_id: uuid.UUID | None = None
    name: str
    description: str | None = None
    maturity: CapabilityMaturity = CapabilityMaturity.planned
    facets: dict[str, str] = Field(default_factory=dict)
    evidence_anchors: list[str] = Field(default_factory=list)


class CapabilityUpdate(BaseModel):
    parent_id: uuid.UUID | None = None
    name: str | None = None
    description: str | None = None
    maturity: CapabilityMaturity | None = None
    facets: dict[str, str] | None = None
    evidence_anchors: list[str] | None = None


class CapabilityRead(Stamped):
    parent_id: uuid.UUID | None
    name: str
    description: str | None
    maturity: CapabilityMaturity
    facets: dict[str, str]
    evidence_anchors: list[str]


class Rollup(BaseModel):
    """Derived in-flight progress over scope(c). Distinct from maturity."""

    total: int
    pending: int
    in_progress: int
    done: int


class CapabilityNode(CapabilityRead):
    """Capability map tree node: subtree + rollup over its scope."""

    rollup: Rollup
    children: list["CapabilityNode"] = []


class MotivationCreate(BaseModel):
    goal_id: uuid.UUID


class HealthFinding(BaseModel):
    kind: str
    subject_id: uuid.UUID
    subject_display_id: str | None = None  # goals only; capabilities go by name
    subject_name: str
    detail: str
