import uuid
from typing import Any

from pydantic import BaseModel, Field, computed_field

from app.schemas.common import Stamped, display


class StrategyCreate(BaseModel):
    phases: list[dict[str, Any]] = Field(default_factory=list)
    rationale: str | None = None
    created_by: str = "user"


class StrategyRead(Stamped):
    product_id: uuid.UUID
    version: int
    phases: list[dict[str, Any]]
    rationale: str | None
    created_by: str

    @computed_field
    @property
    def display_id(self) -> str:
        return display("STR", self.seq, 2)
