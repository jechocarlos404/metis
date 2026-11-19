# Proposal: filling the technology plane, with guesses marked unverified

Status: **proposal, not built.** Raised by the owner on 2026-11-19 ("possibly
too, we can take guesses for the adjacent parts of it but mark as unverified").
This conflicts with the only-real-data rule, so it needs a yes on scope first.

## Today

The tech plane is empty on this instance: 0 technologies, 0 stacks. The seed
format (`backend/app/ontology/seed-format.md`) has no technology section, so
the only way data gets in is the HTTP API. The UI now hides Technology and
Stacks until data exists.

## What a repo can tell us, by confidence

| Fact | Source | Confidence | Proposed treatment |
|---|---|---|---|
| Product *uses* technology X | lockfiles, manifests, Dockerfiles | observed | real data: `product_technologies` (the model already says "the one table a script can populate") |
| X's kind / layer | package registry, well-known list | high | real data on `technologies` |
| X *satisfies* capability Y | inferred from where X is imported vs which capability that code realizes | **guess** | `tech_satisfactions` row marked **unverified** |
| A stack slot `layer::role` binds X | — | human decision | never guessed (binding a slot is a human action; see the write boundary) |
| Adoption stance | — | opinion | never guessed |

## What it would take

1. **Seed format v1 → add an optional `technologies` collection**: `{name,
   kind, layer, products: [...], satisfies: [{capability, fit, verified:
   false}]}`. Change the global `metis-export` skill and the project
   `metis-seed-instance` / `metis-unseed` skills together (they share the spec).
2. **Schema:** a `verified boolean not null default false` on
   `tech_satisfactions`. The repo uses `create_all` with no migrations, so on
   the existing database this is one hand-applied
   `ALTER TABLE tech_satisfactions ADD COLUMN verified boolean NOT NULL DEFAULT false;`
   (no volume reset, no data loss). That is a separate gate from merging.
3. **Counting rule:** an unverified satisfaction is shown (dashed, labelled
   "unverified, from {repo}") and never counted in supply answers, coverage or
   exposure until a person confirms it on the capability page.
4. **UI:** a "Confirm" / "Not right" pair on each unverified row of the
   capability page's Build or buy section. Confirming is a desktop write.

## Questions for the owner

- Is "observed usage is real, inferred satisfaction is unverified" the line you
  meant by "adjacent parts"?
- Should unverified rows appear for viewers, or only editors?
- Run exports for all 17 products once this exists, or only on the next re-seed?
