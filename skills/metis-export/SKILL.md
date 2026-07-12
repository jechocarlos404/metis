---
name: metis-export
description: Analyze the current repository (or product docs, or conversation context) and export a metis-seed.json — goals, capability map, features with dependency edges, and optionally a spec + PRD — for loading into the user's metis instance. Use whenever the user wants to export a project into metis, add this repo to metis, generate metis seed data, or produce a metis-seed file. Metis is the user's product-management app that turns org intent into scoped tickets via a capability map and feature graph.
---

# Export this project as metis seed data

Metis (at `~/dev/jechocarlos404/metis`) models product work as a pipeline:
`OrgGoal → ProductGoal → Spec → Capability map + Feature graph → PRD → Tickets`.
This skill turns the repository you're standing in into a `metis-seed/v1` JSON
file that the `metis-seed-instance` skill (in the metis repo) loads into the running
instance.

Read `references/seed-format.md` before writing the file — it is the canonical
format and ontology spec. The rules that shape everything you extract:

- **Capabilities are durable nouns** — the areas of the system that mature and
  never ship ("Payment Processing", "Ingestion Pipeline"). Single-parent forest.
- **Features are verb phrases** — shippable units that each REALIZE exactly one
  capability ("Retry failed webhook deliveries"). If you can't name the one
  capability a feature realizes, your capability map is wrong — fix the map.
- **Goals motivate capabilities, never features.** One org goal is usually
  enough; product goals hang under it.
- **`A DEPENDS_ON B` means A needs B.** The dependency graph must be acyclic.
  Use `RELATES_TO` for mere association; it doesn't constrain build order.

## Process

1. **Survey the repo.** README, docs/, package manifests, top-level structure,
   and recent git log — enough to know what the product does, what's built, and
   what's in flight. For product docs or conversation notes instead of code,
   extract from those.
2. **Derive goals.** One org goal capturing why the project exists; 1–4 product
   goals for its current thrusts (roadmap items, milestone themes). Convert
   relative dates to absolute. Priority 1 = highest.
3. **Draw the capability map.** 3–8 top-level capabilities; nest only where a
   parent genuinely contains children. Set `maturity` from observed reality:
   shipped and stable → `ga`, usable but rough → `beta`/`alpha`, aspirational →
   `planned`. Ground each in `evidence_anchors` (real file paths from the repo).
4. **Extract features.** The shippable verbs: what has been built (status
   `done`), what's underway (`in_progress`), what's clearly next (`pending`).
   Aim for units one person could ship; typically 2–6 features per capability.
   Give priorities (1–5) with a one-line `priority_rationale` where it isn't
   obvious.
5. **Wire the edges.** Only real technical dependencies — "the API client must
   exist before the sync job" — not thematic similarity. Sparse and true beats
   dense and speculative.
6. **Optionally add a product.** If there's a concrete spec-worthy initiative,
   add one product with a `decomposition` (PRD): epics pin capabilities, stories
   pin features, tickets are sized for one Claude session with `context_budget`
   `S` or `M` — metis rejects `L` tickets at PRD approval, so split them.
7. **Write and validate.** Write `metis-seed.json` at the repo root (or where
   the user asks), then:

   ```sh
   python3 ~/.claude/skills/metis-export/scripts/validate_seed.py metis-seed.json
   ```

   Fix every error; the loader runs the same checks and will refuse the file.
8. **Hand off.** Show the user a compact summary (counts per collection, the
   capability map as a bullet tree) and tell them: load it from the metis repo
   with the `metis-seed-instance` skill —
   `python3 .claude/skills/metis-seed-instance/scripts/seed_instance.py <path> --dry-run`
   then without `--dry-run`.

## Judgment calls

- **Names are identity in metis** — the loader matches existing entities by name
  and reuses them. Prefix ambiguity away when a name could collide with another
  project's entities (e.g. "Auth" → "Acme Auth"), and keep names stable across
  re-exports so re-loading updates nothing and duplicates nothing.
- **Don't inventory the code.** A capability map is the product's anatomy, not
  its directory listing; utilities, configs, and test scaffolding are not
  capabilities.
- **When the repo is thin** (early project, sparse docs), export a small honest
  graph — a handful of `planned` capabilities and pending features beats an
  invented backlog.
