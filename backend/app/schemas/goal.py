import uuid

from pydantic import BaseModel, Field, computed_field

from app.models.enums import GoalType, WorkStatus
from app.schemas.common import Stamped, display


class GoalCreate(BaseModel):
    goal_type: GoalType
    parent_goal_id: uuid.UUID | None = None
    title: str
    description: str | None = None
    success_criteria: str | None = None
    priority: int | None = Field(default=None, ge=1, le=5)
    status: WorkStatus = WorkStatus.pending


class GoalUpdate(BaseModel):
    parent_goal_id: uuid.UUID | None = None
    title: str | None = None
    description: str | None = None
    success_criteria: str | None = None
    priority: int | None = Field(default=None, ge=1, le=5)
    status: WorkStatus | None = None


class GoalRead(Stamped):
    goal_type: GoalType
    parent_goal_id: uuid.UUID | None
    title: str
    description: str | None
    success_criteria: str | None
    priority: int | None
    status: WorkStatus

    @computed_field
    @property
    def display_id(self) -> str:
        prefix = "OG" if self.goal_type == GoalType.org else "PG"
        return display(prefix, self.seq, 2)
