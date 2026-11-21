import uuid
from typing import Annotated

from pydantic import BaseModel, Field, model_validator

from app.models.enums import CapabilityMaturity
from app.schemas.common import Stamped


class CapabilityCreate(BaseModel):
    parent_id: uuid.UUID | None = None
    name: str
    #: Derived from the name when omitted. Set it explicitly to pin the address.
    slug: str | None = None
    description: str | None = None
    maturity: CapabilityMaturity = CapabilityMaturity.planned
    facets: dict[str, str] = Field(default_factory=dict)
    evidence_anchors: list[str] = Field(default_factory=list)


class CapabilityUpdate(BaseModel):
    parent_id: uuid.UUID | None = None
    name: str | None = None
    description: str | None = None
    maturity: CapabilityMaturity | None = None
    facets: dict[str, str] | None = None
    evidence_anchors: list[str] | None = None


class CapabilityRead(Stamped):
    parent_id: uuid.UUID | None
    slug: str
    name: str
    description: str | None
    maturity: CapabilityMaturity
    facets: dict[str, str]
    evidence_anchors: list[str]


class Rollup(BaseModel):
    """Derived in-flight progress over scope(c). Distinct from maturity."""

    total: int
    pending: int
    in_progress: int
    done: int


class CapabilityNode(CapabilityRead):
    """Capability map tree node: subtree + rollup over its scope."""

    rollup: Rollup
    children: list["CapabilityNode"] = []


class MotivationCreate(BaseModel):
    goal_id: uuid.UUID


class HealthFinding(BaseModel):
    kind: str
    subject_id: uuid.UUID
    subject_display_id: str | None = None  # goals only; capabilities go by name
    subject_name: str
    detail: str


# ---- inventory & coverage: what exists, and how much of an idea it covers ----


class ProductRef(BaseModel):
    model_config = {"from_attributes": True}

    id: uuid.UUID
    slug: str
    name: str


class InventoryEntry(CapabilityRead):
    """A capability and who uses it, over its submap — derived from the
    features realizing it, never stored, never from bundles. `products` and
    `features` are ours, whatever their status; `external_products` are
    someone else's that have it. `ours` is true only when a finished (done)
    feature of ours realizes it: false while ours are planned or in progress,
    when every realizing feature is external, and when nothing realizes it."""

    ours: bool
    products: list[ProductRef]
    external_products: list[ProductRef]
    features: int
    #: Of `features`, those linked to this capability itself; the rest reach
    #: it only through a sub-capability.
    direct_features: int


class IdeaFeature(BaseModel):
    name: str
    #: Capability names as the idea's author wrote them. Matched by slug, so
    #: case and punctuation don't matter; anything else must match exactly.
    capabilities: list[str] = Field(min_length=1)


class CoverageRequest(BaseModel):
    features: list[IdeaFeature] = Field(min_length=1)


#: The coverage read's body is open to viewers and the MCP token, and its
#: near-name search costs time for every unmatched name and every character of
#: it (2 to 4 ms a name over 232 capabilities). So the body is bounded, well
#: above real use. Real use, 2026-11: the biggest product has 52 features
#: naming 110 capabilities, and a seed file's dry run sends every capability
#: it adds as one feature (a whole instance has 232). The longest capability
#: name is 33 characters, the longest feature name 111. At these limits the
#: worst body costs about 1 s, where a 62 KB one cost 5 s. Stored rows scored
#: in-process (product_coverage, journeys) go through CoverageRequest, unbounded.
MAX_IDEA_FEATURES = 100
MAX_IDEA_NAMES = 300  # capability names across the whole request
MAX_CAPABILITY_NAME = 100
MAX_NAME = 300  # a feature's name, and any other name a read looks up


class IdeaFeatureBody(IdeaFeature):
    name: str = Field(max_length=MAX_NAME)
    capabilities: list[Annotated[str, Field(max_length=MAX_CAPABILITY_NAME)]] = Field(
        min_length=1, max_length=MAX_IDEA_NAMES
    )


class CoverageBody(CoverageRequest):
    """The coverage read as a caller sends it, bounded (see MAX_IDEA_NAMES)."""

    features: list[IdeaFeatureBody] = Field(min_length=1, max_length=MAX_IDEA_FEATURES)

    @model_validator(mode="after")
    def _names_in_all(self):
        named = sum(len(f.capabilities) for f in self.features)
        if named > MAX_IDEA_NAMES:
            raise ValueError(
                f"at most {MAX_IDEA_NAMES} capability names per request across all "
                f"features, got {named}"
            )
        return self


class CapabilityMatch(BaseModel):
    id: uuid.UUID
    slug: str
    name: str
    maturity: CapabilityMaturity
    #: True only when a finished (done) feature of ours realizes it. False when
    #: only external products have it (it exists, we don't have it) or when no
    #: finished feature does — tell the two apart by `external_products`.
    ours: bool
    #: Our products realizing it, whatever their features' status.
    products: list[ProductRef]
    external_products: list[ProductRef]


class CapabilityNeed(BaseModel):
    name: str
    #: The capability this need resolved to, or None. Only an exact slug match
    #: counts — a near name is a candidate for a human to confirm, never a match.
    match: CapabilityMatch | None
    candidates: list[CapabilityMatch] = []


class FeatureCoverage(BaseModel):
    name: str
    capabilities: list[CapabilityNeed]
    existing: int
    total: int


class CoverageReport(BaseModel):
    features: list[FeatureCoverage]
    #: Distinct needs across the idea (a capability two features need counts once).
    needed: int
    existing: int
    #: Distinct needs we have (a match that isn't ours — only elsewhere, or
    #: realized by no finished feature — counts as missing).
    #: `mature`: those of ours at beta or ga — built and proven, not just named.
    mature: int
    missing: list[str]


class MissingCapability(BaseModel):
    """A capability a scored product's features name that isn't ours."""

    name: str
    #: None when the name resolves to no capability: nothing to link to.
    slug: str | None
    #: How many of the product's features name it.
    features: int
    #: Of those, how many lack only this one: adding it covers everything they
    #: name (not necessarily all they need, when their list is incomplete).
    only_gap: int
    #: Products other than the scored one that have it — never ours, or it
    #: wouldn't be missing. Empty: no other product in metis has it.
    elsewhere: list[ProductRef]


class ClosestProduct(BaseModel):
    product: ProductRef
    #: How many of the capabilities the scored product's features name it has
    #: built (a finished feature realizes them).
    capabilities: int


class ProductCoverage(BaseModel):
    """How much of an existing product — typically someone else's — we could
    build from what we already have. A lower bound: features declaring unknown
    capabilities never count as buildable, whatever their known links say.
    `buildable`, `partly`, `missing` and `not_described` are feature names, in
    feature order, and partition the product's features: each is in exactly one."""

    product: ProductRef
    total_features: int
    #: Every capability known, at least one named, and all of them ours.
    buildable: list[str]
    #: Capability list declared incomplete; every capability named so far is
    #: ours — a weaker signal than buildable, since the unnamed rest may be missing.
    partly: list[str]
    #: Names at least one capability that isn't ours, complete list or not.
    missing: list[str]
    #: Of `missing`, those whose capability list is also declared incomplete:
    #: adding what's named may still not be enough.
    missing_incomplete: list[str]
    #: Names no capability at all.
    not_described: list[str]
    #: Coverage of the features' known capabilities; None when none are known.
    report: CoverageReport | None
    #: Every named capability that isn't ours, most useful first: by `only_gap`,
    #: then `features`, then name.
    missing_capabilities: list[MissingCapability]
    #: The three of our products, never this one, that have built the most of
    #: the capabilities its features name (`report.needed` is the whole), plus
    #: any tied with the third — so the list can be longer than three.
    closest_products: list[ClosestProduct]
