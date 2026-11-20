"""The answer envelope — one shape, three surfaces.

The desktop, the HTTP API and the MCP server are three renderings of one
answer, not three products. A surface may change the presentation; it may not
change the vocabulary, the row set, or what counts as an answer. If a human and
an agent ask the same question on the same day and get different lists, the
ontology has stopped being shared infrastructure.

Three mechanics hold that together, and all three live in this file:

1. One envelope. `question` is also the MCP tool name and the desktop view id.
2. Verbatim enums — nothing here title-cases `in_progress` or prettifies
   `workaround`, so a screenshot, a log line and a chat transcript stay
   greppable against each other.
3. A mandatory `href`. Nothing off-desktop writes, so the last useful thing a
   read surface does is hand a human the screen that can act.
"""

import uuid
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class Question(StrEnum):
    """The six questions the ontology exists to answer. Also the MCP tool
    names — one vocabulary, or the transcripts stop lining up."""

    capability_supply = "capability_supply"
    tech_blast_radius = "tech_blast_radius"
    tech_exposure = "tech_exposure"
    stack_redundancy = "stack_redundancy"
    tech_encounters = "tech_encounters"
    stack_recommend = "stack_recommend"


class SubjectKind(StrEnum):
    capability = "capability"
    technology = "technology"
    product = "product"
    slot = "slot"
    estate = "estate"


class Subject(BaseModel):
    kind: SubjectKind
    slug: str


class Unresolved(BaseModel):
    """What could not be answered, and why. Never empty because you dropped it.

    An empty `answer` with a populated `unresolved` is the most useful response
    the system gives: a capability nothing satisfies, a required slot no offer
    survives for. It ships in the payload — it does not become a log line, a
    404, or an omission."""

    subject: str
    reason: str
    blocked_by: list[str] = Field(default_factory=list)


class Answer(BaseModel):
    #: The six keys are the compatibility contract; a question may add one
    #: (`realizations`, `alternatives`, `pruned`) but may never replace one.
    #: Without this the response model would silently strip those additions.
    model_config = ConfigDict(extra="allow")

    question: Question
    subject: Subject
    answer: list[Any]
    unresolved: list[Unresolved] = Field(default_factory=list)
    as_of: datetime
    #: The desktop path showing the same rows. Mandatory, on every response —
    #: it is the escalation path and how an agent cites its reasoning.
    href: str


def envelope(
    question: Question,
    kind: SubjectKind,
    slug: str,
    rows: list[Any],
    href: str,
    unresolved: list[Unresolved] | None = None,
    **extra: Any,
) -> dict:
    """Build a response. `extra` carries the per-question additions the spec
    names — `realizations`, `alternatives`, `pruned` — which add keys to the
    envelope but never replace one."""
    return {
        "question": question,
        "subject": {"kind": kind, "slug": slug},
        "answer": rows,
        "unresolved": unresolved or [],
        "as_of": datetime.now(UTC),
        "href": href,
        **extra,
    }


# ---- row shapes ----

class SupplyRow(BaseModel):
    """One buy-side offer. `bound_in` marks the current binding rather than
    filtering it out — you cannot re-evaluate a decision you cannot see."""

    tech: str
    fit: str
    stance: str | None
    cost: dict[str, Any]
    bound_in: list[str]


class RealizationRow(BaseModel):
    """The build side of the same question, rendered opposite the offers."""

    feature: str
    product: str | None
    status: str
    tickets: int


class BlastRadiusRow(BaseModel):
    """`required: true` is a break, `false` is an inconvenience — never
    collapsed into a count or a score. `off_stack` means the product's stack
    never declared it; a product with no stack (no `layer`) just uses it."""

    product: str
    layer: str | None
    role: str | None
    required: bool
    off_stack: bool


class AlternativeRow(BaseModel):
    tech: str
    fit: str
    stance: str | None


class ExposureRow(BaseModel):
    """`reason` is a machine-readable `key:value`, identical on all surfaces."""

    tech: str
    version: str | None
    reason: str
    products: int
    required_slots: int


class RedundancyRow(BaseModel):
    capability: str
    layer: str | None
    competing: list[str]


class EncounterRow(BaseModel):
    """`person` is a handle, not a foreign key — a surface wanting a face
    resolves it against the directory itself."""

    person: str
    depth: str
    last_at: str
    on_product: str | None


class BindingRow(BaseModel):
    slot: str
    tech: str
    fit: str
    stance: str | None
    why: str


class PrunedRow(BaseModel):
    """The rule that killed an offer. A silent filter is how a constraint gets
    re-litigated in six months."""

    slot: str
    tech: str
    blocked_by: list[str]
    reason: str


class RecommendRequest(BaseModel):
    """POST because the input is a body, not because it writes. Nothing is
    persisted; the response is an argument."""

    slot: uuid.UUID | None = None
    archetype: uuid.UUID | None = None
    stack: uuid.UUID | None = None
