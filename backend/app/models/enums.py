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


class CapabilityMaturity(StrEnum):
    """Where a capability stands. Stored, not derived — in-flight progress is
    the rollup over realizing features (see docs/ontology-graph-spec.md)."""

    planned = "planned"
    alpha = "alpha"
    beta = "beta"
    ga = "ga"
    deprecated = "deprecated"
    retired = "retired"


class EdgeKind(StrEnum):
    """Feature-plane edges. DEPENDS_ON and BLOCKS form the precedence graph
    (jointly acyclic); RELATES_TO is annotation only. Containment (PART_OF)
    lives on the capability map as parent_id, not here."""

    DEPENDS_ON = "DEPENDS_ON"
    BLOCKS = "BLOCKS"
    RELATES_TO = "RELATES_TO"


class ContextBudget(StrEnum):
    S = "S"
    M = "M"
    L = "L"
