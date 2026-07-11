from datetime import datetime

from pydantic import BaseModel

from app.schemas.common import ORMModel


class AgentConfigRead(ORMModel):
    agent_name: str
    provider: str
    model: str
    updated_at: datetime


class AgentConfigUpdate(BaseModel):
    provider: str
    model: str


class ProviderStatus(BaseModel):
    name: str
    label: str
    available: bool
    detail: str | None = None
    models: list[str] = []
