# The Metis Ontology — Proposed Mental Model

Status: **proposed convergence** from `ontology-divergence.md` (candidates 4 + 8, with
3's facets replacing the category half of `FeatureType`). Not yet ratified.

## The model in one sentence

> **Capabilities are the anatomy of the product; features are motion through that
> anatomy; a product is a promise made from it; goals are the reasons for moving;
> and every document is a photograph — never the thing itself.**

## The five kinds of thing

| Entity | Nature | Grammar | Lifecycle |
|---|---|---|---|
| **Capability** | durable state — what the product *can do* | noun phrase ("ticket export") | matures; never "ships," never "done" |
| **Feature** | a change — work that *moves* a capability | verb phrase ("add Linear backend") | born → shipped → archived |
| **Product** | a promise — a named bundle of capabilities offered to someone | proper noun | versioned as packaging changes |
| **Goal** | a reason — why the map should move | outcome statement | unchanged from today |
| **Document** (Spec, PRD, epic, story) | a photograph — versioned snapshot projecting the taxonomy at a moment | prose pinned to node IDs | immutable once approved |

The load-bearing decision is the first row: **a capability is not a big feature.** It is
a different species — a noun where features are verbs. Everything else follows from
this split. Two planes result, with the goal tree as a why-layer above both — goals
justify *capabilities* (not features directly), and features inherit their justification
through `REALIZES`, which is what makes the `why(f)` provenance chain a pure traversal:

```
WHY LAYER (the reasons — sits above both planes, moves at its own speed)
  Goal(org) ◀──parent── Goal(product) ──MOTIVATES──▶ Capability

SLOW PLANE (the map — changes rarely, survives pivots)
  Product ──BUNDLES──▶ Capability ──PART_OF──▶ Capability (sub-capability)

FAST PLANE (the traffic — churns freely)
  Feature ──REALIZES──▶ Capability
  Feature ──DEPENDS_ON / BLOCKS──▶ Feature

PROJECTIONS (photographs of the planes)
  Spec  = prose over a target capability subtree ("what it does, not how")
  PRD   = snapshot of the features scheduled to move that subtree,
          epics ↔ capability nodes, stories ↔ feature nodes, pinned by ID
```

## The three relation families (never mixed)

Each family answers one question, gets its own invariant, and its own algorithm:

| Family | Question | Edges | Lives on | Invariant |
|---|---|---|---|---|
| **Classification** | what kind? | facet tags (`layer:ui`, `layer:infra`, `layer:integration`, persona, …) | both planes | flat facets, no hierarchy |
| **Partonomy** | piece of what? | `PART_OF` | capability map only | forest, acyclic — rollups run here |
| **Dependency** | what first? | `DEPENDS_ON`, `BLOCKS` | feature plane only | acyclic — topo-sort/impact run here |

`REALIZES` is the single bridge between planes. Today's overload — where `PART_OF` and
`DEPENDS_ON` share one edge table and one treatment — is exactly the corruption this
forbids.

## The mechanical test (what agents enforce)

Agents author most nodes, so the noun/verb call must be promptable:

1. **Noun test** — does it name a *state* of the product ("semantic search")?
   → capability.
2. **Verb test** — does it name a *change* ("re-rank results with embeddings")?
   → feature; it must name the capability it `REALIZES`.
3. **Rebuild test** — if the codebase were deleted and rebuilt, would this still appear
   in the description of the product? → capability. Only in the commit log? → feature.
4. A feature that realizes no capability is either misfiled (it's a capability), or
   unjustified work — both are findings, not filing errors to silently absorb.

## Where today's concepts land

| Today | Becomes |
|---|---|
| `FeatureType.capability` | dissolved — capabilities are their own table/plane |
| `FeatureType.ui / infra / integration` | classification facets on features |
| `Feature.product_id` | replaced: features point at capabilities (`REALIZES`); products point at capabilities (`BUNDLES`) |
| `PART_OF` on features | migrates to the capability map |
| `DEPENDS_ON`, `BLOCKS` | unchanged, feature plane |
| `RELATES_TO` | kept as untyped annotation; excluded from every algorithm |
| `Product` model (docstring: "A Spec") | renamed `Spec` — it was always a document; `Product` is freed for the bundle entity (deferable while single-product) |
| PRD JSONB epics/stories | snapshot entries pinned to capability/feature node IDs (ground rule from divergence pass) |
| Goal tree | unchanged — roots the *why*; ProductGoals justify capability movement |

## Why this model (and not the simpler ones)

- **The snapshot ground rule demands durable identity.** PRDs pin node IDs forever;
  capabilities-as-nouns are the only entities stable enough to pin. Feature-only models
  (including today's) make snapshots point at things that churn.
- **Agents need schema guardrails, not conventions.** The unified-node candidate is the
  cheapest migration, but every invariant becomes runtime validation — and LLM-authored
  nodes *will* be misfiled. Two tables + typed edge constraints make the database refuse
  what the prompt failed to prevent.
- **It answers both halves of the pipeline natively.** "What does the product do" (Spec)
  reads the slow plane; "what are we building" (PRD) reads the fast plane. Today both
  questions hit one feature list and get confused answers.
- **Pivot resilience.** Reorienting the roadmap rewrites features (cheap, they're meant
  to churn) but only re-weights the map. The taxonomy survives its own product's pivots.
- **It leaves the doors open.** Capability maturity states (divergence #9) and
  product-as-bundle for multi-product (#6) bolt on without remodeling; the emergent
  clustering idea (#11) becomes a drift detector comparing the dependency structure
  against the authored map.

## Costs, named honestly

- One more entity and one more edge kind to keep honest; the noun/verb discipline is a
  team habit, enforced by agents but adoptable by humans.
- Small maps feel ceremonial early — a single-product Metis might have ~10 capabilities.
  That's fine; the map earns its keep at the first pivot or the second product.
- Migration touches `Feature`, seed data, `feature_manager`/`spec_decomposer` prompts,
  and the graph service (partonomy moves out of the MultiDiGraph or gets its own kind
  handling). Incremental path: promote `FeatureType.capability` rows first, add
  `REALIZES`, then retire the enum.
