import uuid

from pydantic import BaseModel, Field

from app.models.enums import ContextBudget


class PRDTicket(BaseModel):
    title: str
    description: str | None = None
    technical_approach: str | None = None
    acceptance_criteria: str | None = None
    affected_files: list[str] = Field(default_factory=list)
    context_budget: ContextBudget = ContextBudget.M


class PRDStory(BaseModel):
    title: str
    description: str | None = None
    tickets: list[PRDTicket] = Field(default_factory=list)


class PRDEpic(BaseModel):
    title: str
    acceptance_criteria: str | None = None
    feature_ids: list[uuid.UUID] = Field(default_factory=list)
    stories: list[PRDStory] = Field(default_factory=list)


class PRDDocument(BaseModel):
    """The validated shape of product_decompositions.document."""

    summary: str | None = None
    epics: list[PRDEpic] = Field(default_factory=list)
