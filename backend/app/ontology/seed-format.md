# metis-seed format (v1)

A single JSON document describing a connected slice of the metis ontology, portable
between repositories. Produced by the `metis-export` skill (or authored by hand) and
loaded by the `metis-seed-instance` skill in the metis repo.

This is the canonical copy, at `backend/app/ontology/seed-format.md` in the
metis repo, so the backend can serve it (`GET /api/ontology/seed-format`) and
embed it in the prompt metis gives coding agents. `skills/metis-export/references/`
and the `metis-seed-instance` skill read it through relative symlinks, and the
global install (`scripts/install-skills.sh`) symlinks the whole export skill into
`~/.claude/skills/metis-export`, so there is exactly one file to edit.

## Top-level shape

```json
{
  "format": "metis-seed/v1",
  "source": { "name": "my-repo", "generated_by": "metis-export" },
  "goals": [],
  "capabilities": [],
  "motivations": [],
  "features": [],
  "edges": [],
  "products": []
}
```

- `format` is required and must be exactly `"metis-seed/v1"`.
- `source` is free-form provenance metadata; the loader ignores it.
- Every collection is optional; omit or leave empty what you don't have.
- Entities reference each other by `ref` — a short local string handle, unique within
  its own collection. Refs never reach the instance; the loader resolves them to real
  UUIDs at load time. Declaration order does not matter (the loader orders parents
  before children itself).

## Ontology rules (enforced by metis, so get them right here)

- **Capabilities** are durable *nouns* — areas of the system that mature and never
  ship (e.g. "Ticket Decomposition"). They form a single-parent forest via
  `parent_ref` (PART_OF).
- **Features** are *user-facing* verb phrases — what a changelog for end users would
  list (e.g. "Estimate climb power"). If only a developer could observe it, it is a
  (sub-)capability, not a feature. Each feature REALIZES **every** capability built
  to implement it: `capability_refs` is required and lists at least one. List them
  all — a missing link understates reuse, an invented one overstates it. When you
  genuinely cannot tell (typical for an external product), set
  `"unknown_capabilities": true` and list only the ones you can name — possibly none.
- **Products** are the unit of a project: one product per exported project. Each
  feature names its product with `product_ref`. A product can be someone else's
  (`"external": true`) — known only from the outside, as a user. Its features say
  what it does; they never count as our work, and capabilities only external
  features realize never count as ours.
- **Capabilities are shared across products.** Identity is the exact name, on
  purpose: when two projects both have "Authentication", they must use that exact
  name so metis can see the reuse. Never prefix names to keep projects apart, and
  never create a near-duplicate ("Auth" next to "Authentication").
- **Goals** motivate capabilities (via `motivations`), never features directly.
- Edge semantics: `A DEPENDS_ON B` means *A needs B*. `A BLOCKS B` means *A stands in
  B's way* (≈ B depends on A). The precedence graph — `DEPENDS_ON` plus reversed
  `BLOCKS` — must be **acyclic**; metis rejects cycle-closing edges at write time.
  `RELATES_TO` is annotation only and never constrains ordering.
- Tickets are sized to fit one Claude session. `context_budget` is `S`, `M`, or `L`;
  PRD approval in metis rejects any `L` ticket, so split those instead of exporting
  them.

## Collections

### goals

```json
{
  "ref": "g-org",
  "goal_type": "org",              // required: "org" | "product"
  "parent_ref": null,              // another goal ref; org goals parent product goals
  "title": "Ship intent as executable work",   // required
  "description": "…",
  "success_criteria": "…",
  "priority": 1,                   // 1 (highest) – 5
  "status": "pending"              // "pending" | "in_progress" | "done"
}
```

### capabilities

```json
{
  "ref": "cap-graph",
  "parent_ref": null,              // another capability ref (PART_OF, single parent)
  "name": "Feature Graph",         // required; durable noun
  "description": "…",
  "maturity": "planned",           // "planned" | "alpha" | "beta" | "ga" | "deprecated" | "retired"
  "facets": { "layer": "service" },        // string -> string only
  "evidence_anchors": ["src/graph/impact.py"]  // file paths or URLs grounding this capability
}
```

### motivations

Goal MOTIVATES capability. One object per pair:

```json
{ "goal_ref": "g-org", "capability_ref": "cap-graph" }
```

### features

```json
{
  "ref": "feat-impact",
  "capability_refs": ["cap-graph", "cap-search"],  // required, ≥1: every capability this REALIZES
  "unknown_capabilities": false,   // optional: true = the list is incomplete (may then be empty)
  "product_ref": "prod-export",    // optional: whose feature this is (a products[] ref)
  "name": "Traverse blast radius from a changed feature",  // required; user-facing verb phrase
  "description": "…",
  "facets": { "layer": "service" },
  "status": "pending",             // "pending" | "in_progress" | "done"
  "priority": 2,                   // 1 (highest) – 5
  "priority_rationale": "…"
}
```

A legacy single `"capability_ref": "cap-graph"` is still accepted and read as
`["cap-graph"]`; new files should use `capability_refs`.

For an **external** product: no evidence anchors (there is no code to point at),
leave capability `maturity` unset — it describes *our* implementation, and an
external-only capability's maturity is ignored anyway — and declare
`unknown_capabilities` rather than guessing a link.

### edges

```json
{ "src_ref": "feat-impact", "dst_ref": "feat-store-edges", "kind": "DEPENDS_ON" }
```

`kind` defaults to `DEPENDS_ON`. Kinds: `DEPENDS_ON`, `BLOCKS`, `RELATES_TO`.
No self-loops, no duplicate (src, dst, kind) triples.

### products

A product is one project (an app, a service, a tool) — features belong to it through
their `product_ref`, and the capabilities it uses are derived from those features.
It doubles as a Spec: its optional `decomposition` is a PRD that metis materializes
into real epic/story/ticket rows. Epics pin a capability, stories pin a feature —
snapshots of the taxonomy, never a second hierarchy.

```json
{
  "ref": "prod-export",
  "goal_ref": "g-p1",
  "name": "PM Export",             // required
  "summary": "…",
  "body": "Markdown spec body…",
  "external": false,               // optional: true = someone else's product, known from outside
  "bundle_refs": ["cap-graph"],    // optional: capability refs this product explicitly offers
  "decomposition": {
    "summary": "…",
    "epics": [
      {
        "title": "…",              // required
        "acceptance_criteria": "…",
        "capability_ref": "cap-graph",
        "stories": [
          {
            "title": "…",          // required
            "description": "…",
            "feature_ref": "feat-impact",
            "tickets": [
              {
                "title": "…",      // required
                "description": "…",
                "technical_approach": "…",
                "acceptance_criteria": "…",
                "affected_files": ["src/graph/impact.py"],
                "context_budget": "M"   // "S" | "M" | "L" — avoid L
              }
            ]
          }
        ]
      }
    ]
  }
}
```

## Loader behavior (what you can rely on)

- **Idempotent, add-only.** The loader matches existing entities — goals by
  (goal_type, title); capabilities, features, and products by name; edges by
  (src, dst, kind); motivations by pair — and reuses them instead of duplicating.
  It never deletes or updates anything. Re-running the same file is safe.
- Names are therefore identity: reuse the exact same name across runs to mean the
  same entity. For capabilities, also reuse the exact name another product already
  uses for the same ability (read `GET /api/capabilities/inventory` first) — that
  shared name is what links projects. Only features and products need names that
  stay distinct across projects.
- An existing feature (matched by name) is reused as-is: its capability links and
  product are not rewritten.
- Products load before features, so `product_ref` always resolves.
- A product that already has any PRD is left untouched (the loader won't stack a
  second decomposition version).
