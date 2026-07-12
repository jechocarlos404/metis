# metis-seed format (v1)

A single JSON document describing a connected slice of the metis ontology, portable
between repositories. Produced by the `metis-export` skill (or authored by hand) and
loaded by the `metis-seed-instance` skill in the metis repo.

This is the canonical copy, at `skills/metis-export/references/seed-format.md`
in the metis repo. The `metis-seed-instance` skill reads it through a relative
symlink, and the global install (`scripts/install-skills.sh`) symlinks the
whole export skill into `~/.claude/skills/metis-export` — so there is exactly
one file to edit.

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
- **Features** are *verb phrases* — shippable units of work (e.g. "Compute the MVP
  cut"). Each feature REALIZES **exactly one** capability: `capability_ref` is
  required.
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
  "capability_ref": "cap-graph",   // required: the one capability this REALIZES
  "name": "Traverse blast radius from a changed feature",  // required; verb phrase
  "description": "…",
  "facets": { "layer": "service" },
  "status": "pending",             // "pending" | "in_progress" | "done"
  "priority": 2,                   // 1 (highest) – 5
  "priority_rationale": "…"
}
```

### edges

```json
{ "src_ref": "feat-impact", "dst_ref": "feat-store-edges", "kind": "DEPENDS_ON" }
```

`kind` defaults to `DEPENDS_ON`. Kinds: `DEPENDS_ON`, `BLOCKS`, `RELATES_TO`.
No self-loops, no duplicate (src, dst, kind) triples.

### products

A product is a Spec; its optional `decomposition` is a PRD that metis materializes
into real epic/story/ticket rows. Epics pin a capability, stories pin a feature —
snapshots of the taxonomy, never a second hierarchy.

```json
{
  "ref": "prod-export",
  "goal_ref": "g-p1",
  "name": "PM Export",             // required
  "summary": "…",
  "body": "Markdown spec body…",
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
  same entity, and avoid names that collide with unrelated entities already in the
  instance.
- A product that already has any PRD is left untouched (the loader won't stack a
  second decomposition version).
