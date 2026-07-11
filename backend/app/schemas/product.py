import uuid
from typing import Any

from pydantic import BaseModel, computed_field

from app.models.enums import DocStatus
from app.schemas.common import Stamped, display
from app.schemas.prd import PRDDocument


class ProductCreate(BaseModel):
    goal_id: uuid.UUID | None = None
    name: str
    summary: str | None = None
    body: str | None = None


class ProductUpdate(BaseModel):
    goal_id: uuid.UUID | None = None
    name: str | None = None
    summary: str | None = None
    body: str | None = None


class ProductRead(Stamped):
    goal_id: uuid.UUID | None
    name: str
    summary: str | None
    body: str | None
    status: DocStatus
    version: int

    @computed_field
    @property
    def display_id(self) -> str:
        return display("SPEC", self.seq, 3)


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
