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


class ProposalRead(ORMModel):
    id: uuid.UUID
    message_id: uuid.UUID
    tool_name: str
    arguments: dict[str, Any]
    status: str
    result: str | None
    decided_at: datetime | None
    created_at: datetime


class MessageRead(ORMModel):
    id: uuid.UUID
    thread_id: uuid.UUID
    role: str
    agent_name: str | None
    content: str
    viz: list[dict[str, Any]]
    tool_calls: list[dict[str, Any]] | None = None
    status: str = "done"
    parent_id: uuid.UUID | None = None
    task: str | None = None
    proposals: list[ProposalRead] = []
    created_at: datetime


class MessageSend(BaseModel):
    content: str
