import uuid

from pydantic import BaseModel, Field, computed_field

from app.models.enums import ContextBudget, WorkStatus
from app.schemas.common import Stamped, display


class TicketCreate(BaseModel):
    product_id: uuid.UUID
    epic_id: uuid.UUID | None = None
    story_id: uuid.UUID | None = None
    title: str
    description: str | None = None
    technical_approach: str | None = None
    acceptance_criteria: str | None = None
    affected_files: list[str] = Field(default_factory=list)
    context_budget: ContextBudget = ContextBudget.M
    status: WorkStatus = WorkStatus.pending


class TicketUpdate(BaseModel):
    epic_id: uuid.UUID | None = None
    story_id: uuid.UUID | None = None
    title: str | None = None
    description: str | None = None
    technical_approach: str | None = None
    acceptance_criteria: str | None = None
    affected_files: list[str] | None = None
    context_budget: ContextBudget | None = None
    status: WorkStatus | None = None


class TicketRead(Stamped):
    product_id: uuid.UUID
    epic_id: uuid.UUID | None
    story_id: uuid.UUID | None
    title: str
    description: str | None
    technical_approach: str | None
    acceptance_criteria: str | None
    affected_files: list[str]
    context_budget: ContextBudget
    status: WorkStatus
    position: int

    @computed_field
    @property
    def display_id(self) -> str:
        return display("TKT", self.seq, 4)


class StoryRead(Stamped):
    epic_id: uuid.UUID
    feature_id: uuid.UUID | None  # taxonomy pin: the feature this story snapshots
    title: str
    description: str | None
    position: int

    @computed_field
    @property
    def display_id(self) -> str:
        return display("STY", self.seq, 3)


class EpicRead(Stamped):
    product_id: uuid.UUID
    decomposition_id: uuid.UUID | None
    capability_id: uuid.UUID | None  # taxonomy pin: the capability this epic snapshots
    title: str
    acceptance_criteria: str | None
    position: int

    @computed_field
    @property
    def display_id(self) -> str:
        return display("EPC", self.seq, 2)


class EpicNested(EpicRead):
    stories: list[StoryRead] = []
    tickets: list[TicketRead] = []
