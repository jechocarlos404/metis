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

## Owner answers (2026-11-20)

- **What counts as a guess.** A link is inferred when nothing confirms it: no
  access to the feature itself, no confirmation from the user that it exists,
  no access to the codebase, nothing on the marketing site. Metis then says
  only "this feature is most likely built from these capabilities, confidence
  low / medium / high". So the rule covers feature-to-capability links
  (`feature_capabilities`) as well as technology-to-capability links
  (`tech_satisfactions`), not only the technology plane.
- **Who sees guesses.** Editors and admins. Viewers see confirmed links only.
- **When.** Gradually, as each product is next exported and re-seeded. No bulk
  re-export.
- **Postgres 19 graph features.** Asked 2026-11-20. Postgres 19 shipped on
  2026-11-19, but its release notes do not include SQL/PGQ (`GRAPH_TABLE`),
  so there are no built-in graph queries to adopt. The repo runs
  `postgres:16-alpine` and keeps graph walks in Python.
