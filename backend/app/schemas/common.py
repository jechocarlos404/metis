import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict


class ORMModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class Stamped(ORMModel):
    id: uuid.UUID
    seq: int
    created_at: datetime
    updated_at: datetime


def display(prefix: str, seq: int, width: int) -> str:
    return f"{prefix}-{seq:0{width}d}"
