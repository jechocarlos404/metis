import uuid
from typing import Any

from pydantic import BaseModel

from app.models.enums import ConstraintKind, ConstraintSeverity
from app.schemas.common import ORMModel, Stamped


class ConstraintCreate(BaseModel):
    name: str
    kind: ConstraintKind
    #: one shape only: {"field": <facet key>, "not_in": [...]}
    expression: dict[str, Any]
    severity: ConstraintSeverity = ConstraintSeverity.block


class ConstraintUpdate(BaseModel):
    name: str | None = None
    kind: ConstraintKind | None = None
    expression: dict[str, Any] | None = None
    severity: ConstraintSeverity | None = None


class ConstraintRead(Stamped):
    name: str
    kind: ConstraintKind
    expression: dict[str, Any]
    severity: ConstraintSeverity


class ScopeWrite(BaseModel):
    """Both null scopes the constraint globally."""

    product_id: uuid.UUID | None = None
    stack_id: uuid.UUID | None = None


class ScopeRead(ORMModel):
    """No timestamps — a join row, following ProductBundleRead."""

    id: uuid.UUID
    constraint_id: uuid.UUID
    product_id: uuid.UUID | None
    stack_id: uuid.UUID | None


class ConcernCreate(BaseModel):
    name: str
    description: str | None = None


class ConcernUpdate(BaseModel):
    name: str | None = None
    description: str | None = None


class ConcernRead(Stamped):
    name: str
    description: str | None


class ConcernAnswerWrite(BaseModel):
    concern_id: uuid.UUID
    slot_id: uuid.UUID | None = None


class ConcernAnswerRead(ORMModel):
    """No timestamps — a join row, following ProductBundleRead."""

    id: uuid.UUID
    stack_id: uuid.UUID
    concern_id: uuid.UUID
    slot_id: uuid.UUID | None
