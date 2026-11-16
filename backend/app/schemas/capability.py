import uuid

from pydantic import BaseModel, Field

from app.models.enums import CapabilityMaturity
from app.schemas.common import Stamped


class CapabilityCreate(BaseModel):
    parent_id: uuid.UUID | None = None
    name: str
    #: Derived from the name when omitted. Set it explicitly to pin the address.
    slug: str | None = None
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
    slug: str
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


# ---- inventory & coverage: what exists, and how much of an idea it covers ----


class ProductRef(BaseModel):
    model_config = {"from_attributes": True}

    id: uuid.UUID
    slug: str
    name: str


class InventoryEntry(CapabilityRead):
    """A capability and who uses it, over its submap. products is derived from
    the features realizing it — never stored, never from bundles."""

    products: list[ProductRef]
    features: int


class IdeaFeature(BaseModel):
    name: str
    #: Capability names as the idea's author wrote them. Matched by slug, so
    #: case and punctuation don't matter; anything else must match exactly.
    capabilities: list[str] = Field(min_length=1)


class CoverageRequest(BaseModel):
    features: list[IdeaFeature] = Field(min_length=1)


class CapabilityMatch(BaseModel):
    id: uuid.UUID
    slug: str
    name: str
    maturity: CapabilityMaturity
    products: list[ProductRef]


class CapabilityNeed(BaseModel):
    name: str
    #: The capability this need resolved to, or None. Only an exact slug match
    #: counts — a near name is a candidate for a human to confirm, never a match.
    match: CapabilityMatch | None
    candidates: list[CapabilityMatch] = []


class FeatureCoverage(BaseModel):
    name: str
    capabilities: list[CapabilityNeed]
    existing: int
    total: int


class CoverageReport(BaseModel):
    features: list[FeatureCoverage]
    #: Distinct needs across the idea (a capability two features need counts once).
    needed: int
    existing: int
    #: Existing needs at beta or ga — built and proven, not just named.
    mature: int
    missing: list[str]
