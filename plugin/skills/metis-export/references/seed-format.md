# metis-seed format (v1)

A single JSON document describing a connected slice of the metis ontology, portable
between repositories. Produced by the `metis-export` skill (or authored by hand) and
loaded by the `metis-seed-instance` skill in the metis repo.

This is the canonical copy, at `backend/app/ontology/seed-format.md` in the
metis repo, so the backend can serve it (`GET /api/ontology/seed-format`) and
embed it in the prompt metis gives coding agents. The skills in the metis
Claude Code plugin carry byte-identical plain copies, so they still work when
the plugin is installed outside this repo:
`plugin/skills/metis-export/references/seed-format.md` and
`plugin/skills/metis-seed-instance/references/seed-format.md`. Edit this file,
then copy it over both.

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
  "products": [],
  "technologies": []
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
  A link you can only infer goes in `capability_guesses` (see "Guesses" below),
  never in `capability_refs`.
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
- **Guesses are the one exception to "only real data".** A link is a guess when
  nothing confirms it: no access to the feature itself, no confirmation from the
  user, no access to the codebase, nothing on the product's marketing site or
  docs that states it. A guess says only "this is most likely built from (or
  satisfies) this capability", with a `confidence` of `low`, `medium` or `high`.
  Metis shows guesses to editors and admins only, never counts them in any
  score, coverage or reuse number, and keeps them as guesses until a person
  confirms them on the desktop. A guess still names one exact capability `ref`
  in the file: metis never fuzzy-matches names. Entities themselves (features,
  capabilities, technologies, products) are never guessed; only links are.
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
  "capability_guesses": [          // optional: inferred links, never counted until confirmed
    {
      "capability_ref": "cap-notify",   // required; a capabilities[] ref, not also in capability_refs
      "confidence": "medium",           // required: "low" | "medium" | "high"
      "basis": "The help centre describes email alerts but shows no screen for them."
    }
  ],
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

### Guesses

`capability_guesses` on a feature (and `satisfies` entries with a `confidence`
on a technology, below) are links metis stores as marked guesses:

- Each `capability_ref` must be a capability declared in this file, may appear
  once per feature, and must not also be in that feature's `capability_refs`
  (a link is either confirmed or guessed, not both).
- A feature with no `capability_refs` and only guesses must set
  `"unknown_capabilities": true`.
- `confidence` is how strong the outside evidence is:
  - `high`: strong public evidence, such as a docs or help page that names the
    behaviour the capability provides.
  - `medium`: the behaviour is described (marketing copy, a changelog, a talk)
    but not shown.
  - `low`: plausible from the product's category alone.
- `basis` is optional: one sentence saying why, so the person confirming the
  guess can check it.
- In a repository you can read, trace the code instead: a link you can see is
  confirmed and goes in `capability_refs`.

For an **external** product: no evidence anchors (there is no code to point at),
leave capability `maturity` unset — it describes *our* implementation, and an
external-only capability's maturity is ignored anyway. Put only the links you
can confirm in `capability_refs`; anything inferred goes in
`capability_guesses`, with `unknown_capabilities: true`.

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

### technologies

The technologies a product is built with, and which capabilities each one
satisfies. A technology is shared across products, like a capability.

```json
{
  "ref": "tech-postgres",
  "name": "PostgreSQL",            // required
  "slug": "postgresql",            // optional; default: the name lowercased, each run of
                                   // characters outside a-z and 0-9 turned into one "-", ends trimmed
  "kind": "service",               // required: "language" | "framework" | "library" | "runtime"
                                   //   | "service" | "model" | "protocol"
  "layer": "data",                 // optional: "data" | "api" | "web" | "agent" | "infra" | "ops"
  "products": ["prod-export"],     // optional: products[] refs that use it
  "satisfies": [                   // optional
    { "capability_ref": "cap-store", "fit": "native" },
    { "capability_ref": "cap-search", "fit": "partial",
      "confidence": "medium", "basis": "Imported by the search module, next to a second index." }
  ]
}
```

- `products` is real data, never a guess: list a product only when its
  lockfile, package manifest, Dockerfile or compose file names the technology.
- A `satisfies` entry **without** `confidence` is a confirmed link. Omit
  `confidence` only when you observed the link in code (the capability's own
  code is built on this technology), never when you inferred it. An inferred
  link always carries a `confidence` (the scale under "Guesses") and is stored
  as a guess.
- `fit` is `"native"`, `"partial"` or `"workaround"`. It is required on a
  confirmed entry and optional on a guess. `basis` is optional, one sentence.
- Each `capability_ref` is a capabilities[] ref and appears once per technology.
- Slugs are identity: the loader reuses an existing technology with the same
  slug. Each technology's slug (given or derived) must be non-empty and unique
  within the file; give one explicitly when the name has no letters or digits.
- Adoption stances and stack slots are human decisions and are never in a seed file.

## Loader behavior (what you can rely on)

- **Idempotent, add-only.** The loader matches existing entities (goals by
  (goal_type, title); capabilities and products by name; features by
  (product, name); technologies by slug; edges by (src, dst, kind); motivations,
  product technologies and satisfactions by pair) and reuses them instead of
  duplicating. It never deletes anything and updates only two things: an
  existing feature gains the file's confirmed links it lacks (below), and a
  guess that already exists for the same (capability, feature) or (capability,
  technology) pair takes the file's `confidence` and `basis`. Re-running the
  same file is safe.
- After a load that writes (not a dry run), the loader records that every product
  in the file was just seeded; metis shows that time as how fresh the product's
  map is. This is bookkeeping, not a change to the product.
- Names are therefore identity: reuse the exact same name across runs to mean the
  same entity. For capabilities, also reuse the exact name another product already
  uses for the same ability (read `GET /api/capabilities/inventory` first) — that
  shared name is what links projects. Only features and products need names that
  stay distinct across projects.
- An existing feature (matched by (product, name)) is reused, and its confirmed
  links only grow: every `capability_refs` entry it does not realize yet is
  added, and a link the file leaves out is never removed. When the file states
  `unknown_capabilities`, the feature takes that value (a repo's own export is
  the authority on its own features); when the file leaves it out, the feature
  keeps its own. Its name, description, status and everything else stay as they
  are. Its `capability_guesses` are still loaded, so a product's next export can
  add guesses to features metis already has.
- Confirming a link retires its guess: when a feature gains a confirmed link,
  metis deletes any guess about that same (feature, capability) pair.
- An existing capability is reused as-is: its description, maturity, facets and
  `evidence_anchors` are not updated.
- A guess is skipped when the instance already has that link confirmed (the
  feature already realizes the capability, or the technology already satisfies
  it). An existing technology keeps its name, kind and layer.
- Products load before features, so `product_ref` always resolves.
- A product that already has any PRD is left untouched (the loader won't stack a
  second decomposition version).
