# The Tech Plane — Buy-Side Ontology

This document is served three ways: at `GET /api/ontology/model`, by the `/ontology`
route, and as the `metis://ontology/model` MCP resource. It is one file — not a copy and
not a summary. If it forks, agents start inventing private words for `SATISFIES` and the
transcripts stop being comparable. It lives inside `backend/app/` rather than `docs/`
because the image ships only `app/`, and a document that cannot deploy cannot be the
source of truth.

Status: **implemented** — data model, HTTP API, MCP server and the six routes. Extends
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

## One answer, three surfaces

The desktop, the HTTP API and the MCP server are three renderings of one answer, not
three products. A surface may change the presentation — a table, a JSON body, a line an
agent reads aloud. It may not change the vocabulary, the row set, or what counts as an
answer.

Every question endpoint returns the same six keys:

```json
{ "question": "capability_supply",
  "subject": { "kind": "capability", "slug": "semantic-search" },
  "answer": [], "unresolved": [],
  "as_of": "2026-07-27T09:14:03Z",
  "href": "/capabilities/semantic-search" }
```

A question may *add* a key — `realizations` on supply, `alternatives` on blast radius,
`pruned` on recommend — but never replace one. Enum values are verbatim everywhere:
`standard`, `workaround`, `in_progress`, `off_stack`, exactly as they sit in the
database, so a screenshot, a log line and a chat transcript stay greppable against each
other. Nothing title-cases a status.

`href` is not a convenience. Nothing outside the desktop writes, so the last useful thing
a read surface does is hand a human the screen that can act — and it is how an agent
cites its reasoning.

| Question | Endpoint |
|---|---|
| `capability_supply` | `GET /api/capabilities/{slug}/supply` |
| `tech_blast_radius` | `GET /api/tech/{slug}/blast-radius` |
| `tech_exposure` | `GET /api/exposure?window_days=180&product=` |
| `stack_redundancy` | `GET /api/stacks/{product}/redundancy` |
| `tech_encounters` | `GET /api/tech/{slug}/encounters` |
| `stack_recommend` | `POST /api/stacks/{product}/recommend` |

`stack_recommend` is a POST because its input is a body, not because it writes. Nothing
is persisted; the response is an argument.

### A gap is an answer

The rule most likely to be eroded by a well-meaning refactor. An empty `answer` with a
populated `unresolved` is the most useful response the system gives — a capability
nothing satisfies, a required slot no offer survives for. It ships in the payload. It
does not become a log line, a 404, or an omission.

- `404` means the subject does not exist. "Exists but has no rows" is a `200`.
- The currently-bound technology is never filtered out of a supply answer. It is marked
  in `bound_in` and left in place — you cannot re-evaluate a decision you cannot see.
- `workaround`-fit offers are graded, never hidden.
- `required: true` and `required: false` blast-radius rows are never collapsed into a
  count or a score.

### The write boundary

**Read-only everywhere except the desktop.** A write from any other surface is:

```
403 { "error": "human_action_required",
      "message": "Binding a slot is a human action.",
      "href": "/stacks?slot=api::Auth" }
```

Not `401` — the caller is who they say. Not `405` — the route exists. The refusal names
the reason and hands over the screen that can act.

Surface comes from the token's signed `azp`, so a service or MCP token cannot present
itself as the desktop. An unrecognised client gets `api`, the surface with the fewest
rights; a token naming no client never gains write access by omission.

An agent that can bind a slot can silence a gap, and the gaps are the product. The estate
is still explainable a year later only because every binding carries a person and a
reason — an automated writer strips both while looking like progress.

### The MCP surface

Read-only, over the same HTTP API a browser uses — not over the services in-process.
That is what makes the claim true rather than aspirational: there is an API log line to
compare a chat transcript against, and the write boundary is inherited rather than
re-implemented. The server's token is issued to `metis-mcp`, the backend derives
`Surface.mcp` from the signed `azp`, and any write comes back 403.

Eight tools — the six `question` keys, plus `tech_search` (navigation: everything else
takes a slug it returns) and `propose_binding` (a hand-off that persists nothing).
Four resources: `metis://ontology/model` and `metis://policy/adoptions` serve the same
files as `GET /api/ontology/model` and `/api/ontology/adoptions`; `metis://tech/{slug}`
and `metis://stacks/{product}` are templated. Three prompts.

Tools return **text, not JSON**. An agent quotes text back to a user; it paraphrases
JSON, and paraphrase is where `workaround` becomes "partial support" and the transcripts
stop being comparable. Numbers lead, enums stay verbatim, the row order is the
envelope's, and `Open: <href>` is always the last line.

**Two hard stops, everything else an argument.** A `banned` stance and a blocking
constraint both halt and cite an id. `deprecated`, `contained`, `workaround` and "no
offer at all" come back with their rationale, so the agent can lose the argument out
loud rather than quietly declining and leaving nobody to disagree with.

## Slugs

Capabilities, products and technologies are addressed by a unique kebab-case slug.
Derived from the name once, on create, and **never moved by a rename** — otherwise every
`href` and MCP URI ever logged stops resolving. Two subjects may share a name, so a
derived slug that collides gets `-2`; an *explicit* slug that collides is a 409, because
the caller named it on purpose.

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
8. All six question endpoints return the identical envelope shape, with `href` and
   `as_of` present on every response.
9. No write succeeds from the API or MCP surface, and the 403 carries an `href`.

## Where this diverges from the design handoff

| Handoff said | Reality | Why |
|---|---|---|
| Six Alembic revisions | No Alembic in this repo — `Base.metadata.create_all` on startup | Tables appear by being imported in `app/models/__init__.py` |
| `product_technologies` is a composite-PK join "following `product_bundles`" | `ProductBundle` is `PKMixin` + `UniqueConstraint`; the new join tables match that | Follow the codebase, not the description of it |
| `v_exposure` / `v_redundancy` as SQL views; `adoption_rank()` as a SQL function | Service functions in Python | `create_all` makes no views or functions, and this matches how `capabilities.health()` and `graph_service` already compute derived data |
| `tech_edges` "reuses the `feature_edges` acyclicity code unchanged" | A local check that builds a `DiGraph` from SQL per call | `FeatureGraph` is a stateful `app.state` singleton keyed on `DEPENDS_ON`/`BLOCKS` with dirty-flag write-through. The buy plane runs no topo order, ready set or cut, so there is nothing to keep warm and nothing to go stale |
| A `stack_recommender` agent | Steps 2–5 shipped deterministically as `POST /api/stacks/{product}/recommend`, with no model in the loop | The ranking is computed, so the `why` sentence is assembled from the same keys the ranking used — the argument and the order cannot disagree. Step 1's archetype auto-selection and the chat routing are not built |
| `GET /api/stacks?product_id=` (line 203) vs `/api/stacks/{product}/redundancy` (line 137) | Stacks are addressed by stack id; products by slug | The spec contradicts itself here. Picked one convention: `{slug}` under `/api/stacks/` is a **product** slug on the two question endpoints, a stack UUID on the CRUD ones |
| Frontend is "Next.js App Router" | Astro | — |

`v_exposure` as written in the handoff inner-joins `tech_versions`, so a `deprecated`
stance or a `bus_factor` of 1 with no version rows would never surface — contradicting
its own three-independent-modes claim. The implementation treats the modes as
independent.

## The screens

Six routes, three nav items. `/capabilities/[slug]` and `/tech/[slug]` are detail routes
reached by link — nobody wakes up wanting to browse the catalog, they arrive holding a
need — and `?view=exposure` is a view of `/tech`, kept in the URL so a resolved screen is
linkable. Only `/ontology` earns its own entry, in the Help position.

| Route | Is for |
|---|---|
| `/capabilities/[slug]` | build or buy, in one frame. The entry point everything links to |
| `/tech` | finding a technology among many: facets, not a tree |
| `/tech?view=exposure` | what is dying, sorted by required slots |
| `/tech/[slug]` | one technology, its blast radius, and who to ask |
| `/stacks` | slots by layer, their flags, and the resolver |
| `/ontology` | this document |

`/stacks` carries the only mutation in the buy plane: binding a slot. It is a button a
human presses, and nothing else in the system presses it.

## Not built

- The `stack_recommender` agent's step 1 (archetype auto-selection by best capability
  cover) and its chat routing.
- The encounter side effect the MCP spec puts out of scope for v1: an agent that ships a
  package appending an `encounters` row at depth `touched`. Left out on purpose so the
  discussion happens deliberately rather than as a patch.
- The `catalog_sync` job that refreshes `technologies` and `eol_on` from upstream
  registries. Until it exists, the catalog is populated by hand or by import script.
- Lockfile/Dockerfile/Terraform import into `product_technologies`. The endpoint
  (`PUT /api/stacks/usage`) is there for it.
- Rate limiting and per-caller logging on `tech_encounters`. It is the one endpoint that
  returns people; there is deliberately no unfiltered collection route, but the throttle
  the spec asks for needs a limiter this repo does not yet have.
