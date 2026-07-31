"""Admin data-browser schemas: the join rows nothing else exposes, and cascade.

The cascade shapes are deliberately count-oriented rather than row-oriented: the
preview exists to answer "how much disappears if I confirm", and a list of every
affected uuid answers a question nobody asked.
"""

import uuid
from typing import Literal

from pydantic import BaseModel, Field

from app.schemas.common import ORMModel

#: Tab identity in the browser and the addressable unit of a cascade request.
#: These are the descriptor keys verbatim (underscored), not URL segments.
EntityKey = Literal[
    "goals",
    "capabilities",
    "features",
    "feature_edges",
    "motivations",
    "products",
    "product_bundles",
    "tickets",
]

#: Which plane collateral lands on. `buy` is the loud one — it means supply is
#: disappearing from under a stack, not just intent being tidied up.
Plane = Literal["ontology", "delivery", "buy"]


# ---- join rows -------------------------------------------------------------
# GET /api/capabilities/{id}/motivations returns list[GoalRead] and
# GET /api/products/{id}/bundles returns list[CapabilityRead] — both return the
# *linked* entity, so the join row's own id has no representation anywhere. It
# is the selection key here, which is why these exist.


class MotivationRow(ORMModel):
    id: uuid.UUID
    seq: int
    goal_id: uuid.UUID
    goal_title: str
    capability_id: uuid.UUID
    capability_name: str


class ProductBundleRow(ORMModel):
    id: uuid.UUID
    seq: int
    product_id: uuid.UUID
    product_name: str
    capability_id: uuid.UUID
    capability_name: str


# ---- cascade ---------------------------------------------------------------


class RowRef(BaseModel):
    entity: EntityKey
    id: uuid.UUID


class CascadeRequest(BaseModel):
    rows: list[RowRef] = Field(min_length=1, max_length=500)


class TableCount(BaseModel):
    table: str  # "features"
    label: str  # "Features"
    plane: Plane
    count: int


class RowImpact(BaseModel):
    """What THIS row contributes: the closure of this row alone, minus itself.

    Per-row counts do NOT sum to the totals below. Two selected rows can share
    collateral — a selected feature that is also a child of a selected
    capability is reached once, and shows up under whichever row got there
    first. Render these to explain a blast radius; render the totals to decide.
    """

    entity: EntityKey
    id: uuid.UUID
    label: str
    missing: bool = False
    deletes: list[TableCount] = []
    detaches: list[TableCount] = []


class CascadePreview(BaseModel):
    rows: list[RowImpact]
    #: Deduplicated union closure, selected rows included. The only honest number.
    total_deletes: list[TableCount]
    total_detaches: list[TableCount]
    total_rows: int
    warnings: list[str] = []


class CascadeResult(BaseModel):
    deleted: list[TableCount]
    detached: list[TableCount]
    total: int
