import uuid

from pydantic import BaseModel, Field, computed_field

from app.models.enums import AdoptionStatus, TechFit, TechLayer
from app.schemas.common import ORMModel, Stamped, display


class StackCreate(BaseModel):
    name: str
    description: str | None = None
    is_archetype: bool = False
    parent_id: uuid.UUID | None = None
    product_id: uuid.UUID | None = None


class StackUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    parent_id: uuid.UUID | None = None
    product_id: uuid.UUID | None = None


class StackRead(Stamped):
    name: str
    description: str | None
    is_archetype: bool
    parent_id: uuid.UUID | None
    product_id: uuid.UUID | None

    @computed_field
    @property
    def display_id(self) -> str:
        return display("STK", self.seq, 4)


class StackSummary(StackRead):
    slots: int
    required_slots: int
    instances: int


class SlotCreate(BaseModel):
    layer: TechLayer
    role: str
    capability_id: uuid.UUID | None = None
    tech_id: uuid.UUID | None = None
    required: bool = True
    position: int = 0


class SlotUpdate(BaseModel):
    layer: TechLayer | None = None
    role: str | None = None
    capability_id: uuid.UUID | None = None
    required: bool | None = None
    position: int | None = None


class SlotBind(BaseModel):
    """A human action, never automatic. tech_id None unbinds — which reopens
    the gap rather than hiding it."""

    tech_id: uuid.UUID | None


class SlotRead(Stamped):
    stack_id: uuid.UUID
    layer: TechLayer
    role: str
    capability_id: uuid.UUID | None
    tech_id: uuid.UUID | None
    required: bool
    position: int


class SlotView(SlotRead):
    """A slot with everything the stack view needs resolved, plus the flags —
    which are three predicates over this row, not three features."""

    capability: str | None
    tech: str | None
    fit: TechFit | None
    stance: AdoptionStatus | None
    flags: list[str] = Field(default_factory=list)


class Drift(BaseModel):
    """Used by the product, declared by no slot."""

    tech_id: uuid.UUID
    slug: str


class StackView(BaseModel):
    stack: StackRead
    slots: list[SlotView]
    drift: list[Drift]
    unanswered_concerns: list[str]


class Redundancy(BaseModel):
    """Question 4: one capability answered more than once for a product.
    Surfaced, never resolved — two bindings on one capability is a real
    architectural decision with history behind it."""

    product_id: uuid.UUID
    product: str
    capability_id: uuid.UUID
    capability: str
    competing: list[str]


class ProductTechnologyWrite(BaseModel):
    tech_id: uuid.UUID
    via_slot_id: uuid.UUID | None = None


class ProductTechnologyRead(ORMModel):
    """No timestamps — a join row, following ProductBundleRead."""

    id: uuid.UUID
    product_id: uuid.UUID
    tech_id: uuid.UUID
    via_slot_id: uuid.UUID | None
