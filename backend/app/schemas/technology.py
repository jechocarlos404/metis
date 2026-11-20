import uuid
from datetime import date
from typing import Any

from pydantic import BaseModel, Field, computed_field

from app.models.enums import (
    AdoptionStatus,
    EncounterDepth,
    TechEdgeKind,
    TechFit,
    TechKind,
    TechLayer,
    VendorKind,
)
from app.schemas.common import ORMModel, Stamped, display


class VendorCreate(BaseModel):
    name: str
    kind: VendorKind
    bus_factor: int | None = Field(default=None, ge=1)
    homepage: str | None = None


class VendorUpdate(BaseModel):
    name: str | None = None
    kind: VendorKind | None = None
    bus_factor: int | None = Field(default=None, ge=1)
    homepage: str | None = None


class VendorRead(Stamped):
    name: str
    kind: VendorKind
    bus_factor: int | None
    homepage: str | None


class TechnologyCreate(BaseModel):
    slug: str
    name: str
    kind: TechKind
    layer: TechLayer | None = None
    vendor_id: uuid.UUID | None = None
    homepage: str | None = None
    facets: dict[str, str] = Field(default_factory=dict)
    evidence_anchors: list[str] = Field(default_factory=list)


class TechnologyUpdate(BaseModel):
    slug: str | None = None
    name: str | None = None
    kind: TechKind | None = None
    layer: TechLayer | None = None
    vendor_id: uuid.UUID | None = None
    homepage: str | None = None
    facets: dict[str, str] | None = None
    evidence_anchors: list[str] | None = None


class TechnologyRead(Stamped):
    slug: str
    name: str
    kind: TechKind
    layer: TechLayer | None
    vendor_id: uuid.UUID | None
    homepage: str | None
    facets: dict[str, str]
    evidence_anchors: list[str]

    @computed_field
    @property
    def display_id(self) -> str:
        return display("TCH", self.seq, 4)


class TechnologyRow(TechnologyRead):
    """One row of the /tech catalog: the world fact, the group's stance, and
    what it is for. adoption is None when no stance has been taken."""

    adoption: AdoptionStatus | None
    satisfies: list[str]
    used_by: int


class Presence(BaseModel):
    technologies: bool
    stacks: bool


class TechnologyPage(BaseModel):
    rows: list[TechnologyRow]
    total: int
    facet_counts: dict[str, dict[str, int]]


class VersionCreate(BaseModel):
    label: str
    released_on: date | None = None
    eol_on: date | None = None


class VersionUpdate(BaseModel):
    label: str | None = None
    released_on: date | None = None
    eol_on: date | None = None


class VersionRead(Stamped):
    tech_id: uuid.UUID
    label: str
    released_on: date | None
    eol_on: date | None


class AdoptionWrite(BaseModel):
    """Upserted, not created — one stance per technology. Deleting the row is
    how a stance is withdrawn; it does not mean `candidate`."""

    status: AdoptionStatus
    since: date | None = None
    owner: str | None = None
    rationale: str | None = None
    evidence_anchors: list[str] = Field(default_factory=list)


class AdoptionRead(Stamped):
    tech_id: uuid.UUID
    status: AdoptionStatus
    since: date | None
    owner: str | None
    rationale: str | None
    evidence_anchors: list[str]


class SatisfactionCreate(BaseModel):
    tech_id: uuid.UUID
    capability_id: uuid.UUID
    fit: TechFit
    cost: dict[str, Any] = Field(default_factory=dict)
    notes: str | None = None


class SatisfactionUpdate(BaseModel):
    fit: TechFit | None = None
    cost: dict[str, Any] | None = None
    notes: str | None = None


class SatisfactionRead(Stamped):
    tech_id: uuid.UUID
    capability_id: uuid.UUID
    fit: TechFit
    cost: dict[str, Any]
    notes: str | None


class TechEdgeCreate(BaseModel):
    src_id: uuid.UUID
    dst_id: uuid.UUID
    kind: TechEdgeKind = TechEdgeKind.REQUIRES


class TechEdgeRead(ORMModel):
    id: uuid.UUID
    src_id: uuid.UUID
    dst_id: uuid.UUID
    kind: TechEdgeKind


class EncounterCreate(BaseModel):
    tech_id: uuid.UUID
    person: str
    product_id: uuid.UUID | None = None
    depth: EncounterDepth
    last_at: date


class EncounterRead(Stamped):
    tech_id: uuid.UUID
    person: str
    product_id: uuid.UUID | None
    depth: EncounterDepth
    last_at: date


class TechnologyDetail(TechnologyRow):
    """Everything hanging off one technology, for the catalog detail view."""

    vendor: VendorRead | None
    versions: list[VersionRead]
    satisfactions: list[SatisfactionRead]
    outgoing: list[TechEdgeRead]
    incoming: list[TechEdgeRead]
    encounters: list[EncounterRead]


class Offer(BaseModel):
    """One ranked candidate against a capability. Nothing here is stored — the
    ordering is recomputed on every request so it can be audited."""

    tech_id: uuid.UUID
    slug: str
    name: str
    kind: TechKind
    fit: TechFit
    stance: AdoptionStatus | None
    cost: dict[str, Any]
    notes: str | None
    experience: EncounterDepth | None
    rank: int
    blocked_by: list[str] = Field(default_factory=list)
    warned_by: list[str] = Field(default_factory=list)


class ProductBreak(BaseModel):
    """Question 2: what breaks if we drop this technology. off_stack means the
    product's stack never declared it; with no stack at all, it is false
    and the row (no slot) only says the product uses it."""

    product_id: uuid.UUID
    product: str
    slot_id: uuid.UUID | None
    layer: TechLayer | None
    role: str | None
    required: bool
    off_stack: bool


class Exposure(BaseModel):
    """Question 3. Three independent death modes, computed never stored:
    the release line expires, the group already gave up, or one person
    maintains it."""

    tech_id: uuid.UUID
    slug: str
    reasons: list[str]
    version: str | None
    eol_on: date | None
    stance: AdoptionStatus | None
    bus_factor: int | None
    products: int
    required_slots: int
