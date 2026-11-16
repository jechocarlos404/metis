---
name: metis-export
description: Analyze the current repository (or product docs, or conversation context) and export a metis-seed.json — the project as one product, its user-facing features, and every capability implementing them (reusing capability names already in the metis inventory), plus goals, dependency edges, and optionally a spec + PRD — for loading into the user's metis instance. Use whenever the user wants to export a project into metis, add this repo to metis, generate metis seed data, or produce a metis-seed file. Metis is the user's capability inventory shared across products — it maps what each product does to the capabilities built for it, to show what new products could be made from what already exists.
---

# Export this project as metis seed data

Metis (at `~/dev/jechocarlos404/metis`) is a **capability inventory shared across
products**: every product's user-facing features, mapped to the capabilities built
to implement them. Because capabilities are shared by exact name, the inventory
shows which abilities are reused across projects and how much of a new product idea
already exists. Its ticket pipeline
(`Goal → Spec → Capability map + Feature graph → PRD → Tickets`) is secondary.

This skill turns the repository you're standing in into a `metis-seed/v1` JSON
file that the `metis-seed-instance` skill (in the metis repo) loads into the running
instance.

Read `references/seed-format.md` before writing the file — it is the canonical
format and ontology spec. The rules that shape everything you extract:

- **One product per project.** The export emits exactly one product for this
  repository, and every feature carries its `product_ref`.
- **Features are user-facing** — named the way a changelog for end users would
  read ("Estimate climb power"). If only a developer could observe the behavior,
  it is not a feature: demote it to a (sub-)capability or fold it into the
  capability's description.
- **Capabilities are durable nouns** — the technical machinery that matures and
  never ships ("Payment Processing", "Elevation Data"). Single-parent forest.
- **A feature REALIZES every capability implementing it.** `capability_refs`
  lists all of them — trace the feature through the code and include each
  capability it actually relies on. A missing link understates reuse; an invented
  one overstates it. If you can't name any, your capability map is wrong.
- **Goals motivate capabilities, never features.** One org goal is usually
  enough; product goals hang under it.
- **`A DEPENDS_ON B` means A needs B.** The dependency graph must be acyclic.
  Use `RELATES_TO` for mere association; it doesn't constrain build order.

## Process

1. **Survey the repo.** README, docs/, package manifests, top-level structure,
   and recent git log — enough to know what the product does, what's built, and
   what's in flight. For product docs or conversation notes instead of code,
   extract from those.
2. **Read the existing inventory.** Before naming any capability, fetch what the
   instance already has:

   ```sh
   curl -s http://localhost:8000/api/capabilities/inventory
   ```

   Each entry has a capability's exact `name`, `description`, `maturity`, and the
   `products` already using it. If the instance is unreachable, tell the user —
   exporting blind will split shared capabilities into near-duplicates — and only
   continue if they say to.
3. **Derive goals.** One org goal capturing why the project exists; 1–4 product
   goals for its current thrusts (roadmap items, milestone themes). Convert
   relative dates to absolute. Priority 1 = highest.
4. **Draw the capability map.** 3–8 top-level capabilities; nest only where a
   parent genuinely contains children. **Reuse an existing capability's exact
   name whenever it names the same ability** — copy it character for character,
   including case. Create a new name only when nothing in the inventory fits, and
   never one that near-duplicates an existing name ("Auth" next to
   "Authentication"). Set `maturity` from observed reality in *this* repo:
   shipped and stable → `ga`, usable but rough → `beta`/`alpha`, aspirational →
   `planned`. Ground each in `evidence_anchors` (real file paths from the repo).
5. **Extract features.** The user-facing verbs: what has been built (status
   `done`), what's underway (`in_progress`), what's clearly next (`pending`).
   For each, list every capability implementing it in `capability_refs`, and set
   `product_ref` to this project's product. Give priorities (1–5) with a one-line
   `priority_rationale` where it isn't obvious.
6. **Wire the edges.** Only real technical dependencies — "the API client must
   exist before the sync job" — not thematic similarity. Sparse and true beats
   dense and speculative.
7. **Write the product.** Exactly one product for the project (name, summary).
   Optionally add a `decomposition` (PRD) if there's a concrete spec-worthy
   initiative: epics pin capabilities, stories pin features, tickets are sized for
   one Claude session with `context_budget` `S` or `M` — metis rejects `L`
   tickets at PRD approval, so split them.
8. **Write and validate.** Write `metis-seed.json` at the repo root (or where
   the user asks), then:

   ```sh
   python3 ~/.claude/skills/metis-export/scripts/validate_seed.py metis-seed.json
   ```

   Fix every error; the loader runs the same checks and will refuse the file.
9. **Hand off.** Show the user a compact summary (counts per collection, the
   capability map as a bullet tree marking which capabilities were reused from the
   inventory and which are new) and tell them: load it from the metis repo with the
   `metis-seed-instance` skill —
   `python3 .claude/skills/metis-seed-instance/scripts/seed_instance.py <path> --dry-run`
   then without `--dry-run`.

## Judgment calls

- **Names are identity in metis** — the loader matches existing entities by name
  and reuses them. For capabilities that is the point: a shared name is what links
  projects. Features and products should keep names distinct to their project;
  keep all names stable across re-exports so re-loading updates nothing and
  duplicates nothing.
- **Don't inventory the code.** A capability map is the product's anatomy, not
  its directory listing; utilities, configs, and test scaffolding are not
  capabilities.
- **When the repo is thin** (early project, sparse docs), export a small honest
  graph — a handful of `planned` capabilities and pending features beats an
  invented backlog.
