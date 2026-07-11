import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel

from app.schemas.common import ORMModel


class ThreadCreate(BaseModel):
    title: str = "New thread"


class ThreadRead(ORMModel):
    id: uuid.UUID
    title: str
    created_at: datetime
    updated_at: datetime


class MessageRead(ORMModel):
    id: uuid.UUID
    thread_id: uuid.UUID
    role: str
    agent_name: str | None
    content: str
    viz: list[dict[str, Any]]
    created_at: datetime


class MessageSend(BaseModel):
    content: str
