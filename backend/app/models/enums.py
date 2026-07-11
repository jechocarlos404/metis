from enum import StrEnum


class GoalType(StrEnum):
    org = "org"
    product = "product"


class WorkStatus(StrEnum):
    pending = "pending"
    in_progress = "in_progress"
    done = "done"


class DocStatus(StrEnum):
    draft = "draft"
    approved = "approved"


class FeatureType(StrEnum):
    capability = "capability"
    integration = "integration"
    ui = "ui"
    infra = "infra"


class EdgeKind(StrEnum):
    DEPENDS_ON = "DEPENDS_ON"
    BLOCKS = "BLOCKS"
    RELATES_TO = "RELATES_TO"
    PART_OF = "PART_OF"


class ContextBudget(StrEnum):
    S = "S"
    M = "M"
    L = "L"
