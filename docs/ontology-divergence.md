# Product / Feature / Capability Ontology — Divergence Pass

Status: **divergent exploration** — candidates only, nothing settled.
Next step: converge against the criteria at the bottom.

## Why this needs settling

Metis currently carries **four latent taxonomies that don't agree with each other**:

1. **The Goal tree** — `Goal(goal_type: org|product, parent_goal_id)`. A real hierarchy,
   but it stops at goals.
2. **The feature graph** — `Feature` + `FeatureEdge(PART_OF, ...)`. `PART_OF` gives an
   implicit containment hierarchy, but nothing constrains what may be part of what.
3. **The PRD document** — `ProductDecomposition.document` JSONB holding
   epics → stories → tickets. A *second* containment hierarchy, invisible to the graph.
4. **The `FeatureType` enum** — `capability | integration | ui | infra`. Here
   "capability" is a *sibling of "ui"* — an abstraction **level** masquerading as a
   technical **category**. This is the clearest smell: one enum conflating two axes.

Also: the `Product` model is, per its own docstring, "A Spec" — a document, not a
container. So today nothing in the system actually *is* a product in the taxonomic sense.

"Settling the ontology" means choosing: which of these hierarchies is canonical, what the
node kinds are, what the relations mean, and where invariants are enforced.

## Already settled (ground rules for every candidate)

**Epics / stories / tickets are snapshots, not taxonomy.** The global product/feature
taxonomy is the single canonical structure. A PRD decomposition is a **versioned,
point-in-time projection** of a subgraph of it — epics and stories don't exist as
freestanding things; they reference taxonomy nodes and freeze a copy of their state
(name, description, scope) at snapshot time. The existing
`ProductDecomposition.document` JSONB with a `version` column is already the right
mechanism; what changes is that its entries must carry taxonomy node IDs instead of
being an independent tree. Consequences:

- Taxonomy #3 above stops being a rival hierarchy by definition — it's a view.
- Every candidate below is evaluated as the *source* structure that PRD snapshots
  project from.
- Approving a PRD pins node IDs + frozen copies; the live taxonomy can keep moving
  underneath without rewriting approved documents (and drift between a snapshot and the
  live graph becomes a detectable, reportable condition).

---

## The candidates

Each candidate gives: the thesis, entities & relations, what it buys, where it hurts,
and how far it is from what Metis has today.

### 1. The Ladder — strict layered tree

**Thesis:** fixed abstraction levels, each a first-class entity.

```
Product ─contains→ Capability ─contains→ Feature ─decomposes→ Ticket
```

- Distinct tables per level; single-parent containment; a feature belongs to exactly one
  capability, a capability to exactly one product.
- This is the classic PM-tool model (Aha!, ProductBoard, Jira's project→epic→story).

**Buys:** trivially explainable; rollups (status, priority, progress) are a `GROUP BY`;
every artifact has one home; LLM agents get an unambiguous slot to file things into.
**Hurts:** shared capabilities across products need duplication or hacks; real systems
are never trees (search touches everything); reorganizing means moving subtrees, which
rewrites history. The tree ossifies exactly when the product pivots.
**Distance from today:** high — new tables, `FeatureType.capability` removed,
`PART_OF` demoted or deleted.

### 2. One Node to Rule Them All — unified node + level attribute

**Thesis:** there is only one entity, `Node`; "product / capability / feature" are values
of a `level` (or `kind`) column. Taxonomy is the projection of `PART_OF` edges.

- Generalizes the existing feature graph. `Feature` becomes `Node`; products and
  capabilities become nodes too; the Goal tree could fold in as well.
- Invariants (e.g. "features sit under capabilities") are **edge rules**, not schema:
  `PART_OF` allowed only from lower to adjacent-or-equal level.

**Buys:** cheapest migration (it's what the graph already half-is); the networkx mirror
needs no changes; agents traverse one namespace; new levels are an enum value, not a
migration.
**Hurts:** the type system stops helping — every query filters on `kind`; nothing stops a
product from becoming `PART_OF` a ticket except runtime validation; Pydantic schemas get
unioned and conditional.
**Distance from today:** low.

### 3. Facets, not trees — classification without containment

**Thesis:** stop building a hierarchy. Features are the only work entity; everything else
is an orthogonal **facet** you filter by.

- Facet dimensions (each flat or shallow): *capability area*, *technical layer*
  (the current ui/infra/integration), *persona*, *value stream*, *maturity*.
- A "product" is a **saved query** over facets, not a container.
- Library-science lineage (Ranganathan's faceted classification): things have many
  independent classifications; forcing one tree loses the rest.

**Buys:** no fights about "where does this live" — a feature is simultaneously
`capability:search`, `layer:infra`, `persona:pm`; reorgs are re-tagging, not tree
surgery; the `FeatureType` smell dissolves (level and category become separate facets).
**Hurts:** no rollups without picking a primary facet; humans genuinely like trees for
orientation; "what is a capability" becomes "a tag value," which may feel too weak for
a system whose pipeline promises structure.
**Distance from today:** medium — keep `Feature` + dependency edges, replace
`FeatureType` and `product_id` with a facet-tag table.

### 4. Two-plane model — durable capability map / fast delivery stream

**Thesis:** capabilities and features are **different kinds of thing moving at different
speeds**, so give them separate planes connected by a realization edge.

```
Slow plane:  Product ─offers→ Capability (stable map; capabilities mature, never "ship")
Fast plane:  Feature ─REALIZES→ Capability   (features are changes; they ship and are done)
                Feature ─DEPENDS_ON→ Feature  (execution graph stays here)
```

- Enterprise-architecture lineage (BIZBOK capability maps, ArchiMate's
  capability/realization). Capabilities are **nouns** ("ticket export"); features are
  **verbs** ("add Linear backend to ticket export").
- Capability map changes rarely and survives pivots; the feature stream churns freely
  underneath it.

**Buys:** cleanly answers "what does the product do" (map) vs "what are we building"
(stream) — which are exactly the Spec vs PRD halves of the Metis pipeline; roadmaps
become "which capabilities move this quarter"; impact analysis gets two resolutions.
**Hurts:** two entities to keep honest; agents must decide "is this a capability or a
feature" at creation time (though the noun/verb test is mechanical enough for a prompt);
small products find the map ceremonial.
**Distance from today:** medium — promote `FeatureType.capability` rows to a new
`Capability` table, add `REALIZES`, keep everything else.

### 5. Outcome-rooted — Opportunity Solution Tree

**Thesis:** the taxonomy's spine is *why*, not *what*. Root at outcomes; features are
solution hypotheses.

```
Goal ─→ Opportunity (user need / pain) ─→ Solution (feature) ─→ Experiment / Ticket
```

- Teresa Torres's continuous-discovery model. "Capability" is emergent: the residue of
  solutions that stuck around.
- Metis already has the Goal tree as root — this extends the existing
  `OrgGoal → ProductGoal` chain downward instead of building a parallel structure.

**Buys:** every feature is born justified (traceable to an opportunity); kills
zombie-feature accumulation; fits Metis's "org intent → executable work" pitch almost
word for word.
**Hurts:** engineering-driven work (infra, refactors, integrations — half the current
seed data) has no natural opportunity parent and gets fake ones; "where is the list of
what the product does" has no answer; discovery-oriented, weaker for execution.
**Distance from today:** medium-high.

### 6. Product as lens — capabilities as shared substrate

**Thesis:** invert ownership. Nothing "belongs to" a product; capabilities form one
shared substrate, and a **product is a bundle** — a named selection of capabilities.

```
Capability graph (shared, one namespace)
Product ─BUNDLES→ Capability        (many-to-many)
Feature ─attaches to→ Capability    (features never reference products at all)
```

- Platform-org thinking: auth, search, export are built once and bundled into many
  products/SKUs/tiers.

**Buys:** multi-product and platform sharing is native, not a workaround; "products" can
proliferate cheaply (a tier, a bundle, a white-label) since they're just views;
matches how the one-product-today/many-tomorrow story actually unfolds.
**Hurts:** overkill while Metis manages one product; someone must own capabilities when
no product does; pricing/packaging concerns leak into the taxonomy early.
**Distance from today:** medium — mostly re-pointing `Feature.product_id` at
capabilities and adding a bundle join table.

### 7. Metamodel — ontology as data

**Thesis:** don't pick a taxonomy; ship a taxonomy **engine**. Node types, edge types,
and composition rules are rows, not schema.

```
node_types(name, ...)                          e.g. "product", "capability", "feature"
edge_types(name, src_type, dst_type, acyclic)  e.g. PART_OF: feature→capability
nodes(type_id, ...)   edges(type_id, ...)
```

**Buys:** each org shapes its own ontology; Metis never fights its users about
terminology; every other candidate in this document becomes a *configuration preset*.
**Hurts:** maximum rope — agents, UI, and graph algorithms must all go generic;
"settle the ontology" is deferred to every user, forever; validation moves entirely to
runtime; considerable build cost for a system that today has one tenant.
**Distance from today:** highest.

### 8. Relation-family separation — settle the *edges*, not the nodes

**Thesis:** taxonomy pain comes from conflating three relation families. The ontology is
the discipline of keeping them apart; node kinds matter less.

| Family | Question | Relations | Invariant |
|---|---|---|---|
| **Classification** | what *kind* of thing is it? | `IS_A`, facet tags | lattice, no cycles |
| **Partonomy** | what is it a *piece* of? | `PART_OF` | forest or DAG, no cycles |
| **Dependency** | what must exist *first*? | `DEPENDS_ON`, `BLOCKS` | acyclic (already enforced) |

- Today `PART_OF` lives in the same edge table as `DEPENDS_ON` with identical treatment —
  composition and execution are one mechanism. This candidate splits them: different
  invariants, different queries, different UI (tree view vs graph view).
- Compatible with almost every other candidate; it's a cross-cutting principle more than
  a complete model.

**Buys:** each family gets the right algorithm (rollups on partonomy, topo-sort on
dependency, filtering on classification); prevents the classic corruption where someone
uses `PART_OF` to mean "related" and breaks rollups.
**Hurts:** doesn't by itself answer "what is a capability"; needs pairing with a node
story (2, 4, or 6).
**Distance from today:** low.

### 9. Temporal ontology — features as state transitions

**Thesis:** a capability isn't done or not-done; it has a **maturity state**. A feature
is a *transition* that moves a capability from one state to another.

```
Capability.maturity: absent → planned → alpha → beta → GA → deprecated → retired
Feature = (capability, from_state → to_state, the work to get there)
```

- The roadmap becomes a state-machine timeline over the capability map; "what does the
  product do *today*" and "in Q3" are the same query with a time parameter.

**Buys:** roadmapping and status fall out of the model instead of being annotations;
deprecation is first-class (taxonomies usually only grow); pairs beautifully with
candidate 4.
**Hurts:** features that don't move a maturity state (bug fixes, polish) need a
"strengthens current state" escape hatch; more machinery than early-stage products need.
**Distance from today:** medium, and additive to 4.

### 10. Grammar ontology — capabilities as testable sentences

**Thesis:** for an LLM-native tool, make the taxonomy *linguistic*. Every capability is a
sentence in a controlled grammar; the taxonomy is the parse structure.

```
Capability := <persona> can <verb> <object> [<qualifier>]
  "A PM can export approved tickets to Jira"
Feature    := an increment to exactly one capability sentence
Product    := the set of sentences it promises
```

- Sentences are machine-checkable: agents can verify naming discipline, detect duplicate
  capabilities semantically ("export tickets" vs "ticket exporting"), and — further out —
  test a sentence against the codebase as an acceptance assertion.

**Buys:** atomicity is forced by the grammar (compound sentences must split); dedup
becomes semantic instead of trigram (upgrading the existing `gin_trgm_ops` search);
uniquely plays to Metis's agent architecture — the grammar is a prompt-enforceable rule.
**Hurts:** unusual — needs user buy-in; infra work ("connection pooling") makes for
tortured sentences; grammar drift needs policing.
**Distance from today:** medium; it's mostly a *naming and validation* layer over 4 or 2.

### 11. Emergent taxonomy — compute it, don't author it

**Thesis:** the most radical option: **no authored taxonomy at all**. Keep only features
and dependency edges; derive "capabilities" by clustering the graph (community
detection on the networkx mirror) and let an LLM name the clusters.

**Buys:** zero taxonomy maintenance; the structure always reflects reality (the actual
coupling), never an org chart from two pivots ago; regenerates after every change.
**Hurts:** unstable identities (clusters shift → names shift → links break); intent is
absent — the taxonomy describes what *is* coupled, not what *should* be; humans can't
hang plans on ground that moves. Likely wrong as the canonical model, but strong as a
**drift detector** against whichever authored taxonomy wins ("your capability map says X,
the dependency structure says Y").

---

## The axes underneath (what we're actually choosing)

The candidates are points; these are the dimensions. Converging = picking a position on
each axis:

| Axis | Options | Candidates at each pole |
|---|---|---|
| **A. Node kinds** | one unified kind … fixed layers … user-defined | 2 · 1/4 · 7 |
| **B. Hierarchy shape** | tree … DAG … facets … derived | 1 · 6 · 3 · 11 |
| **C. Nature of a capability** | shippable work (verb) … durable state (noun) | today's enum · 4/9 |
| **D. Product's role** | container that owns … lens that bundles … just a document | 1 · 6 · today |
| **E. Where invariants live** | schema … edge rules … convention/prompt | 1 · 8 · 2 |
| **F. Taxonomy authorship** | humans/agents author … system computes | 1–10 · 11 |

Axis **C** is the load-bearing one: it decides whether "capability" stays a flavor of
feature (cheap, status quo) or becomes a different species (the two-plane split). Most
other choices follow from it.

## Proposed convergence criteria (for the next pass)

Score each surviving candidate against Metis's actual constraints:

1. **Pipeline fit** — does it slot into `OrgGoal → ProductGoal → Spec → FeatureGraph →
   PRD → Tickets` without inventing a parallel structure? Per the settled ground rule,
   PRD epics/stories/tickets are snapshots of taxonomy nodes — so the candidate must
   offer natural projection targets (e.g. epic ↔ capability-level node,
   story ↔ feature-level node) and stable node identities for snapshots to pin.
2. **Agent legibility** — can `spec_decomposer` and `feature_manager` file things into it
   with a mechanical rule (noun/verb test, grammar check), or does it need judgment calls?
3. **One write path** — does it survive the "Postgres first, write-through to networkx,
   one uvicorn worker" architecture unchanged?
4. **Ticket-sizing chain** — do its leaves still decompose into S/M tickets?
5. **Migration cost** — distance from today's schema, and whether it's reachable
   incrementally.
6. **Pivot resilience** — when the product changes direction, is the fix re-tagging,
   re-parenting, or rebuilding?

Note that the snapshot ground rule itself discriminates: it rewards candidates whose
nodes have **durable identities** for snapshots to pin (4, 6, 9) and penalizes ones
whose structure shifts under you (11 as canon; 3 needs a designated primary facet to
project epics from).

Early signal (held loosely, since this is the divergent pass): **4 (two-plane) + 8
(relation-family separation)** compose naturally and fix both named smells — the
`FeatureType` level/category conflation and the overloaded edge table — while **3's
facets** can replace the *category* half of `FeatureType`, and **11** works as a drift
check on whatever is settled. But that's a hypothesis to test against the criteria, not
a decision.
