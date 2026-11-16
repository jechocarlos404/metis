import uuid
from typing import Any

from pydantic import BaseModel, computed_field

from app.models.enums import DocStatus
from app.schemas.common import ORMModel, Stamped, display
from app.schemas.prd import PRDDocument


class ProductCreate(BaseModel):
    goal_id: uuid.UUID | None = None
    name: str
    #: Derived from the name when omitted. Set it explicitly to pin the address.
    slug: str | None = None
    summary: str | None = None
    body: str | None = None
    #: Someone else's product, known only from the outside.
    external: bool = False


class ProductUpdate(BaseModel):
    goal_id: uuid.UUID | None = None
    name: str | None = None
    summary: str | None = None
    body: str | None = None
    external: bool | None = None


class ProductRead(Stamped):
    goal_id: uuid.UUID | None
    slug: str
    name: str
    summary: str | None
    body: str | None
    status: DocStatus
    version: int
    external: bool

    @computed_field
    @property
    def display_id(self) -> str:
        return display("SPEC", self.seq, 3)


class ProductBundleCreate(BaseModel):
    capability_id: uuid.UUID


class ProductBundleRead(ORMModel):
    product_id: uuid.UUID
    capability_id: uuid.UUID


class DecompositionCreate(BaseModel):
    document: PRDDocument
    created_by: str = "user"


class DecompositionRead(Stamped):
    product_id: uuid.UUID
    version: int
    document: dict[str, Any]
    status: DocStatus
    created_by: str

    @computed_field
    @property
    def display_id(self) -> str:
        return display("PRD", self.seq, 3)
