# The Tech Plane — Buy-Side Ontology

Status: **implemented, backend only.** The two routes (`/tech`, `/stacks`) described in
the design handoff are not built; the API contract they need is. Extends
`ontology-graph-spec.md` with a fourth plane.

## The organising idea

Metis modelled three things: Product (a Spec), Capability (the slow plane — a durable
noun that matures and never ships), Feature (the fast plane — a change that `REALIZES`
exactly one Capability). This adds a fourth: **Tech** — a world-scope catalog of
technologies, the group's **adoption** stance on them, and the **stacks** that bind them
to Products.

> **Capability is the exchange currency.** A Feature `REALIZES` a Capability — the *build*
> side. A Tech `SATISFIES` a Capability — the *buy* side. Same node, same currency.

That asymmetry is deliberate: a Feature realizes exactly one Capability
(`features.capability_id NOT NULL`), a Tech serves many. A change belongs to one durable
noun; a technology serves several.

Everything else exists to make that one edge trustworthy — a world catalog to point at,
an adoption stance to record where the group stands, versions and vendors so deprecation
is computable, and slots to record which offer a Product actually accepted.

## The four planes

| Plane | Node | Grammar | Lifecycle |
|---|---|---|---|
| **Why** | Goal | intent | own lifecycle |
| **What** (slow) | Capability | noun phrase — *semantic search* | matures, never ships |
| **Build** (fast) | Feature | verb phrase — *add vector index* | pending → in_progress → done |
| **Buy** (new) | Technology | proper noun — *qdrant* | exists in the world independently of us |

## Entities

| Table | Holds | Deliberately does not hold |
|---|---|---|
| `technologies` | identity (`slug`, `name`), classification (`kind`, `layer`), `vendor_id`, filter-only `facets` | **any opinion.** The moment an adoption field lands here the catalog becomes a wishlist and stops being shareable |
| `vendors` | stewardship, `bus_factor` | — |
| `tech_versions` | a release line and its `eol_on` | — |
| `adoptions` | the group's stance, one row per Tech | a default. **Absence of a row is meaningful: no stance taken** |
| `tech_satisfactions` | the hinge — Tech → Capability with a `fit` | a score. `cost` stays `{}` until a written rubric exists |
| `tech_edges` | `REQUIRES`, `RUNS_ON`, `ALTERNATIVE_TO`, `SUPERSEDES`, `WRAPS` | — |
| `tech_stacks` + `stack_slots` | layered composition *and* archetype, in one table | — |
| `product_technologies` | observed usage; `via_slot_id` null is drift | timestamps (join row, follows `product_bundles`) |
| `constraints` + `concerns` | the filters over the market | — |
| `encounters` | who has touched what, how deep, how recently | proficiency scales, endorsements, a prerequisite graph. Metis dropped `members` and `skill_prerequisites` for good reasons; this does not reopen that |

### `slug` is canonical

Kebab-case, lowercase, unversioned: `apache-age`, `oauth-2.1`. Versions live in
`tech_versions`. A rename is a human decision because `slug` is what every hand-written
join references.

### `kind` and `layer` are orthogonal facets, not a hierarchy

`layer` is nullable — a language spans layers, and forcing TypeScript into `web` is a lie
that will be queried against. All seven kinds (language, framework, library, runtime,
service, model, protocol) are Technology rows: they differ in `kind`, not in shape, and
every question ranges over all of them at once.

### `fit` is a three-value judgement, not a score

| `fit` | Meaning | Test |
|---|---|---|
| `native` | the Capability is what this Tech is for | you would put it in the first sentence of the README |
| `partial` | it does most of it, with a named limitation | you can state the limitation in one clause |
| `workaround` | it can be made to do it | someone will be surprised |

### The adoption ramp is ordered, not categorical

```
promotion:  candidate → trial → adopted → standard
demotion:   contained → deprecated → banned
```

Ordering it means "how much of the estate is below `adopted`" is a comparison, not a
`CASE`. Single-group assumption: if a second org unit ever needs its own stance, the
only change is widening the unique key to `(tech_id, org_unit_id)` — the catalog above
never forks.

### A stack and an archetype are the same object at two levels of binding

An **archetype** is `is_archetype = true`, belongs to no Product, and has slots with a
`capability_id` and no `tech_id` — a shape to fill. Instantiating copies the slots
*unbound*; `parent_id` keeps the lineage so "which products still follow the archetype"
stays answerable.

### Three predicates, not three features

Gaps, drift and redundancy are not features to build. They are predicates over one row:

| Predicate | Means |
|---|---|
| `required AND tech_id IS NULL` | **gap** |
| two slots in one stack sharing `capability_id` | **redundancy** |
| `product_technologies.via_slot_id IS NULL` | **drift** — used but never declared |
| bound tech's `fit = 'workaround'` | **workaround binding**, a known ceiling |

Get the slot right and the reports write themselves.

### Constraint vs Concern

A **Constraint** is a hard rule that prunes candidates *before* fit is scored ("no AGPL",
"identity data stays in-VPC"). `severity: block` prunes; `warn` annotates. The expression
has exactly one shape — `{"field": <facet key>, "not_in": [...]}` — and operators get
added when a real rule needs one. A general expression language is a trap.

A **Concern** is a cross-cutting non-functional axis: auth, observability, cost, data
residency. The difference from a Capability is obligation:

> An unmet Capability is a roadmap item. An unanswered Concern is a review blocker.

## Derived — never stored

| Computed | Definition | Endpoint |
|---|---|---|
| exposure | EOL within 180 days, **or** stance is `deprecated`/`banned`, **or** `bus_factor = 1` — three independent modes, each sufficient alone | `GET /api/tech/exposure` |
| redundancy | per Product: Capabilities with ≥2 used tech at `fit IN (native, partial)` | `GET /api/stacks/redundancy` |
| offer ranking | fit → adoption → experience → ops burden → slug | `GET /api/tech/offers` |

Risk and duplication are consequences of the graph, not facts about it. Storing them
guarantees they go stale — the same trap the PG↔Neo4j dual-write already sprang.

The ranking is entirely computed, with no model in the loop. If the ordering came out of
a prompt nobody could audit it, and the same question would answer differently on Tuesday.

## Invariants

1. `features.capability_id` stays `NOT NULL`. The build plane's one-to-one is what makes
   the buy plane's many-to-many meaningful by contrast.
2. `technologies` has no column whose value depends on who is asking.
3. `REQUIRES ∪ RUNS_ON` is jointly acyclic, rejected at write time. `ALTERNATIVE_TO`
   is symmetric — write both rows, or read with the detail endpoint's `OR`.
4. `tech_satisfactions.capability_id` is `RESTRICT`, mirroring the Feature FK: a
   Capability with supply cannot be deleted out from under a stack.
5. A `required` slot with `tech_id IS NULL` is valid and **never auto-filled**. A gap is
   information the PRD has to answer before tickets are cut; a plausible wrong binding
   is not. Nothing in this codebase binds a slot — `POST /api/stacks/slots/{id}/bind`
   is a human action.
6. Every non-null `stack_slots.capability_id` on a *product* stack points at a Capability
   the Product actually bundles. Enforced in the service layer; no cross-table FK
   expresses it. Archetypes are exempt — they have no Product to check against, which is
   what makes them a shape.
7. No stored score anywhere. If a number can be recomputed, recompute it.

## Where this diverges from the design handoff

| Handoff said | Reality | Why |
|---|---|---|
| Six Alembic revisions | No Alembic in this repo — `Base.metadata.create_all` on startup | Tables appear by being imported in `app/models/__init__.py` |
| `product_technologies` is a composite-PK join "following `product_bundles`" | `ProductBundle` is `PKMixin` + `UniqueConstraint`; the new join tables match that | Follow the codebase, not the description of it |
| `v_exposure` / `v_redundancy` as SQL views; `adoption_rank()` as a SQL function | Service functions in Python | `create_all` makes no views or functions, and this matches how `capabilities.health()` and `graph_service` already compute derived data |
| `tech_edges` "reuses the `feature_edges` acyclicity code unchanged" | A local check that builds a `DiGraph` from SQL per call | `FeatureGraph` is a stateful `app.state` singleton keyed on `DEPENDS_ON`/`BLOCKS` with dirty-flag write-through. The buy plane runs no topo order, ready set or cut, so there is nothing to keep warm and nothing to go stale |
| A `stack_recommender` agent | Its deterministic steps 3–5 (supply, prune, rank) shipped as `GET /api/stacks/slots/{id}/offers`; step 2 (shape) is `POST /api/stacks/instantiate` | Those steps need no model. Step 1's archetype auto-selection and step 6's generated rationale are not built, nor is the chat routing |
| Frontend is "Next.js App Router" | Astro | — |

`v_exposure` as written in the handoff inner-joins `tech_versions`, so a `deprecated`
stance or a `bus_factor` of 1 with no version rows would never surface — contradicting
its own three-independent-modes claim. The implementation treats the modes as
independent.

## Not built

- `/tech` and `/stacks` routes (UI decisions pending).
- The `stack_recommender` agent and its chat routing.
- The `catalog_sync` job that refreshes `technologies` and `eol_on` from upstream
  registries. Until it exists, the catalog is populated by hand or by import script.
- Lockfile/Dockerfile/Terraform import into `product_technologies`. The endpoint
  (`PUT /api/stacks/usage`) is there for it.
