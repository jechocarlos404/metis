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


class Surface(StrEnum):
    """Where a request came from. Not a role — a role says what someone is
    allowed to do, a surface says which door they came through, and the write
    boundary is drawn on the door."""

    desktop = "desktop"
    api = "api"
    mcp = "mcp"


class TechKind(StrEnum):
    """Granularity of the world catalog. These differ in kind, not in shape —
    every tech question ranges over all of them at once."""

    language = "language"
    framework = "framework"
    library = "library"
    runtime = "runtime"
    service = "service"
    model = "model"
    protocol = "protocol"


class TechLayer(StrEnum):
    """Orthogonal to TechKind, not a hierarchy. Nullable on technologies —
    a language spans layers, and forcing one is a lie that gets queried."""

    data = "data"
    api = "api"
    web = "web"
    agent = "agent"
    infra = "infra"
    ops = "ops"


class TechFit(StrEnum):
    """A three-value judgement, not a score.

    native      the capability is what this tech is for
    partial     does most of it, with a nameable limitation
    workaround  can be made to do it; someone will be surprised"""

    native = "native"
    partial = "partial"
    workaround = "workaround"


class AdoptionStatus(StrEnum):
    """The group's stance, an ordered ramp rather than a category.
    Promotion: candidate -> trial -> adopted -> standard.
    Demotion: contained -> deprecated -> banned."""

    candidate = "candidate"
    trial = "trial"
    adopted = "adopted"
    standard = "standard"
    contained = "contained"
    deprecated = "deprecated"
    banned = "banned"


class TechEdgeKind(StrEnum):
    """Buy-plane edges. REQUIRES and RUNS_ON are jointly acyclic;
    ALTERNATIVE_TO is symmetric (write both rows) and never traversed for
    cycles; SUPERSEDES is the deprecation trail."""

    REQUIRES = "REQUIRES"
    RUNS_ON = "RUNS_ON"
    ALTERNATIVE_TO = "ALTERNATIVE_TO"
    SUPERSEDES = "SUPERSEDES"
    WRAPS = "WRAPS"


class VendorKind(StrEnum):
    company = "company"
    foundation = "foundation"
    individual = "individual"
    community = "community"


class ConstraintKind(StrEnum):
    license = "license"
    residency = "residency"
    compliance = "compliance"
    runtime = "runtime"
    cost = "cost"


class ConstraintSeverity(StrEnum):
    """block prunes candidates before fit is scored; warn only annotates."""

    block = "block"
    warn = "warn"


class EncounterDepth(StrEnum):
    shipped = "shipped"
    touched = "touched"
    evaluated = "evaluated"
