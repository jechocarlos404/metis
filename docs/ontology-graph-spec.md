# The Metis Graph Spec — Node Types, Edge Types, Traversal Semantics

Status: **implemented** (see Implementation status at the bottom for deviations),
elaborating `ontology-mental-model.md` into a formal spec.
Direction conventions follow the existing graph service (`A DEPENDS_ON B` = *A depends
on B*), extended to the new edge kinds.

## Node types

Four node types exist in the graph. Documents and tickets deliberately do **not**.

| Node | Plane | Identity | Key attributes | Status semantics |
|---|---|---|---|---|
| **Goal** | why | durable | title, success_criteria, priority, `goal_type: org\|product`, parent goal | own lifecycle (as today) |
| **Product** | slow | durable | name, packaging metadata | versioned, never "done" |
| **Capability** | slow | durable — *this is what snapshots pin* | noun-phrase name, description, facets, maturity, evidence anchors | **stored `maturity`** (where it stands); progress always derived (see `rollup`) |
| **Feature** | fast | ephemeral-ish (archived, not deleted) | verb-phrase name, description, facets, priority | own `WorkStatus` — the only node type where "done" means anything |

**Not node types, on purpose:**

- **Ticket, Story, Epic** — these exist only *inside* PRD snapshot documents (settled
  ground rule). An epic entry pins a Capability ID; a story entry pins a Feature ID;
  tickets hang off story entries in the document. They are photographs of nodes, not nodes.
- **Spec, PRD** — documents that project the graph; they reference node IDs, the graph
  never references them.
- **Facets** (`layer:ui`, `persona:pm`, …) — attribute tags on nodes, not vertices.
  They filter traversals; they never participate in them.

## Edge types

Reading convention given per edge. One bridge crosses the planes; nothing else does.

| Edge | Domain → Range | Read as | Cardinality | Invariant |
|---|---|---|---|---|
| `PART_OF` | Capability → Capability | "A is a component of B" | ≤ 1 parent | **forest** — single parent, acyclic |
| `BUNDLES` | Product → Capability | "P offers C" | many-to-many | none beyond typing |
| `MOTIVATES` | Goal → Capability | "G is why C should move" | many-to-many | none beyond typing |
| `REALIZES` | Feature → Capability | "F advances C" | **exactly 1** per feature | mandatory; a feature realizing two capabilities must split |
| `DEPENDS_ON` | Feature → Feature | "A needs B first" | many-to-many | acyclic (jointly with BLOCKS) |
| `BLOCKS` | Feature → Feature | "A vetoes B until A lands" | many-to-many | acyclic (jointly with DEPENDS_ON) |
| `RELATES_TO` | Feature ↔ Feature, Capability ↔ Capability | "see also" | any | none — excluded from every algorithm |

Notes:

- **`DEPENDS_ON` vs `BLOCKS`:** structurally, `A BLOCKS B` ≡ `B DEPENDS_ON A` — but they
  express different knowledge. `DEPENDS_ON` is *architectural need* (B's output is A's
  input), authored when a feature is defined. `BLOCKS` is *discovered veto* (a migration,
  a conflict), authored when scheduling reality intrudes. Keep both for provenance;
  algorithms consume them merged (below).
- **`PART_OF` moves planes.** Today it sits on features in the shared edge table; in the
  spec it exists only on the capability map. Its forest invariant means the natural
  storage is a `parent_capability_id` FK column, not edge rows — the invariant picks the
  storage.
- **`REALIZES` cardinality is the atomicity enforcer.** Exactly-one is deliberate: it's
  the graph-level twin of the ticket-sizing rule. "This feature touches search *and*
  export" is not an edge-modeling problem; it's two features.

## Derived graphs (computed, never stored)

1. **Precedence graph** — `DEPENDS_ON ∪ reverse(BLOCKS)` over features. The only graph
   execution algorithms run on. Must be acyclic; a cycle is rejected at write time
   (extends the existing cycle check, which today covers `DEPENDS_ON` alone).
2. **Capability coupling graph** — project precedence onto the slow plane:
   `C₁ → C₂` iff some feature realizing C₁ (or its `PART_OF` descendants) depends on a
   feature realizing C₂. Computed, never authored.

## Traversals and what they mean

Semantics stated as questions; existing implementations noted.

### Fast plane (execution — exists today, extended)

| Traversal | Question | Definition |
|---|---|---|
| `dependencies(f)` | what does f need? | descendants of f in the precedence graph *(today: DEPENDS_ON only)* |
| `impact(f)` | who breaks if f changes? | ancestors of f in the precedence graph |
| `build_order(S)` | in what order do we build S? | reverse topological sort of precedence subgraph *(exists)* |
| `ready_set()` | what can start right now? | pending features whose precedence-descendants are all done — the agent-facing work frontier |
| `required_set(T)` | what must be built to deliver targets T? | T ∪ precedence-descendants of T, dependencies-first |
| `deferrable(T)` | what can be cut without breaking T? | all features − `required_set(T)`, ranked by priority |

### Delivery cuts (MVP scoping)

`required_set`/`deferrable` are the schedule-free prioritization primitives: they answer
"which features are essential vs nice-to-have" from graph structure alone, with no
timeline anywhere. Decisions baked in:

- **Necessity lives on the feature plane.** There is no authored capability-level
  `REQUIRES` edge; capability ordering is always the derived coupling projection.
  Consequence: capability-level ordering cannot be expressed before decomposition —
  decompose coarsely early rather than invent a new edge kind.
- **A cut is a query, not an entity.** No Release/Milestone node — a milestone without
  a date is just a computed cut. Named, persistent cuts ("MVP", "v1") are the deferred
  `Product` + `BUNDLES` entity's job: an MVP is literally a product, a promise made
  from a subset of the map.
- **Targets are features.** Capability targets are accepted as a convenience and expand
  to `scope(c)`; thin-slice MVPs (capability needed, but only partially) should target
  features directly or the required set overshoots.
- **Capability projection.** `required_set` grouped by `REALIZES` gives the
  capability-level answer: which capabilities must move, and how many of their features
  are required vs total (a partial-rollup target, not full maturity).
- **Discipline (load-bearing):** `deferrable()` is only as truthful as the edges.
  `DEPENDS_ON`/`BLOCKS` encode *necessity* — B's output is A's input; "should come
  first" is a `priority` opinion, and encoding it as an edge shrinks the deferrable set
  with lies. Agent prompts state this rule.

### Slow plane and bridge (new)

| Traversal | Question | Definition |
|---|---|---|
| `submap(c)` | what is capability c made of? | `PART_OF`-descendants of c (a subtree, since forest) |
| `scope(c)` | what work belongs to c? | all features `REALIZES`-ing any node of `submap(c)` — **this is exactly what a PRD epic snapshot freezes** |
| `rollup(c)` | how done is c? | aggregate of `WorkStatus` over `scope(c)`; capabilities have no stored status, this *is* their status |
| `surface(p)` | what does product p do? | `BUNDLES` targets of p plus their submaps — the answer a Spec narrates |
| `impact_capability(c)` | what breaks at product resolution if c changes? | ancestors of c in the capability coupling graph |
| `why(f)` | why does f exist? | f `—REALIZES→` c `—PART_OF*→` root capability `←MOTIVATES—` product goal `←parent—` org goal; every ticket can print this provenance chain — this traversal *is* the Metis pitch |

### Health and drift (new — these are findings generators)

| Traversal | Finding |
|---|---|
| feature with no `REALIZES` | invariant violation (misfiled capability, or unjustified work) — hard-blocked at write time post-migration |
| capability with empty `scope(c)` **and maturity < GA** | aspirational gap: promised but nothing building toward it → roadmap material (empty scope at GA is just a stable shipped capability — no finding) |
| capability unreachable from any Product via `BUNDLES` | dead map territory → prune or bundle |
| goal with no `MOTIVATES` out-edges | empty intent → decompose or drop |
| `drift(snapshot)` | diff pinned frozen copies vs live nodes: renamed / re-parented / deleted / split since approval — reportable, never auto-healed |
| coupling graph ⋈ `PART_OF` forest | authored map says X, dependency reality says Y — the emergent-taxonomy idea (divergence #11) as a lint rule |

### Non-traversals (explicitly meaningless)

- `PART_OF` never contributes to build order or impact — containment is not precedence.
- `RELATES_TO` participates in nothing; it renders in UI and does no other work.
- No traversal crosses the bridge implicitly. `impact(f)` stays on the fast plane;
  seeing capability-level blast radius requires the explicit projection
  (`impact_capability`). Mixing resolutions silently is how graphs lie.

## Brownfield: reverse-engineering an existing product

The ontology is declarative — it defines what the structures are, not the order they are
authored in. Only the *pipeline* is directional. Reverse engineering enters the graph at
a different node type and runs some traversals backwards:

| | Greenfield (forward) | Brownfield (reverse) |
|---|---|---|
| entry point | Goals → capabilities promised | Capabilities observed from the artifact |
| capability map | authored from intent | bootstrapped by clustering the codebase + LLM naming, human-ratified (divergence #11 as ingestion, not lint) |
| maturity at creation | `planned` | observed state, typically `GA` |
| goals | given | inferred from the map (`why` run in reverse) — `MOTIVATES` health check relaxed during ingestion |
| fast plane at T₀ | features from PRD decomposition | **legitimately empty** — features begin with the first planned change |
| coupling graph evidence | feature `DEPENDS_ON` edges | static analysis of the code, checked against the authored map |

Two amendments the brownfield case forces (both already folded into the tables above):

1. **Stored maturity on Capability.** Without it, empty `scope(c)` is ambiguous between
   *shipped-and-stable* and *not-started* — only history could disambiguate, and
   brownfield has no history. Maturity is the stored answer to "where does this stand";
   `rollup(c)` is reinterpreted as *in-flight progress*, not status. (This adopts
   divergence #9 immediately rather than later, and supersedes the earlier
   "no intrinsic status" rule.)
2. **Evidence anchors on Capability.** Ingested capabilities carry pointers to where
   they are implemented (paths, endpoints, routes). Attributes, not nodes. They double
   as the "known context" a ticket needs to fit one Claude session.

Ingestion workflow: observe → cluster & draft noun-phrase map → human ratifies →
stamp maturity + evidence anchors → infer/attach goals → future features attach via
`REALIZES` exactly as in greenfield. The as-built map at ingestion is itself worth
versioning as a snapshot ("observed from codebase X on date Y").

## Implementation notes (non-normative)

- The in-memory mirror keeps its current shape for the fast plane (MultiDiGraph keyed by
  kind, one uvicorn worker, Postgres-first writes). The slow plane is small and
  forest-shaped — it can stay relational (`parent_capability_id`) and be joined in at
  projection time; it does not need to live in networkx.
- Cycle enforcement extends from the `DEPENDS_ON` subgraph to the merged precedence graph.
- `REALIZES` as a mandatory FK column on features (`capability_id`) rather than an edge
  row — exactly-one cardinality picks the storage, same as `PART_OF`.
- Migration order: (1) create capabilities from `FeatureType.capability` rows,
  (2) add `capability_id` to features and backfill from `PART_OF`/`product_id` heuristics
  + agent pass, (3) move remaining `FeatureType` values to facets, (4) retire the enum
  and feature-level `PART_OF`.

## Implementation status (what shipped)

Landed in `backend/app` + `frontend/src`; all invariants above are enforced unless
noted. Deviations and deferrals, with reasons:

- **Maturity has no `absent` state.** A capability that does not exist has no row;
  `planned` is the entry state. (`CapabilityMaturity` in `models/enums.py`.)
- **`PART_OF` is `capabilities.parent_id`** (forest → FK), guarded against re-parenting
  cycles at write time. `REALIZES` is `features.capability_id`, `NOT NULL`, `RESTRICT`
  on capability delete — features cannot be orphaned.
- **Precedence** = `DEPENDS_ON ∪ reverse(BLOCKS)`; cycle-closing edge writes are
  rejected with 422 at `POST /api/features/edges` (not just detected at topo time).
- **Endpoints:** `/api/capabilities` (CRUD, `/map`, `/health`, `/{id}/scope`,
  `/{id}/rollup`, `/{id}/impact`, `/{id}/motivations`), `/api/features/{id}/why`,
  `/api/graph/ready`. Snapshots pin: `PRDEpic.capability_id`, `PRDStory.feature_id`,
  materialized onto `epics`/`stories` rows.
- **Delivery cuts:** `POST /api/graph/mvp-cut` ({features, capabilities} → essential /
  deferrable / per-capability counts), mirrored as the `mvp_cut` tool on `graph_agent`
  and `strategist`. Empty expansion (capability target with no features) is a 422, not
  an empty cut — an all-deferrable answer would be a lie.
- **`unmotivated_capability` refined:** a root is flagged only when *nothing in its
  submap* is motivated — justification is inherited through containment.
- **Deferred:** `BUNDLES` + the Product-as-bundle entity (single-product today; the
  `Product` model remains the Spec document), the `Product → Spec` rename, and the
  `drift(snapshot)` differ (pins are stored, the diff endpoint is not yet built).
- **No migration scripts:** the schema is `create_all` on boot; existing dev volumes
  need a reset (`docker compose down -v`) to pick up the new tables.
