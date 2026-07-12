---
name: metis-seed-instance
description: Load a metis-seed JSON file into the running metis instance via the REST API — goals, capability map, features, dependency edges, motivations, and spec/PRD documents. Use whenever the user wants to seed, load, import, or ingest data into their metis instance, mentions a metis-seed.json or a seed file exported from another repository, or describes goals/capabilities/features in conversation and wants them inserted into metis (author a seed file first, then load it).
---

# Seed the metis instance

Load a portable `metis-seed/v1` JSON file into the running instance. The file
usually comes from the companion `metis-export` skill run in another repository,
but any file matching the format works — including one you author on the spot
from conversation context.

## Prerequisites

The instance must be up. Check, and start it if needed:

```sh
curl -s http://localhost:8000/api/health   # expect {"status":"ok",...}
docker compose up -d --build               # from the repo root, if it's down
```

If the schema changed since the volume was created, `create_all` won't migrate —
reset with `docker compose down -v` first (warn the user: this erases instance data).

## Get a seed file

- If the user hands you a path (often `metis-seed.json` from another repo), use it.
- If the user describes the data in conversation (goals, capabilities, features,
  work items), read `references/seed-format.md` and author a seed file yourself —
  write it to a temp location, show the user a short summary of what it contains,
  then load it. Follow the ontology rules in the reference strictly: capabilities
  are durable nouns, features are verb phrases realizing exactly one capability,
  goals motivate capabilities only, and the precedence graph must stay acyclic.

## Load it

Always dry-run first — it validates the file, diffs it against what's already in
the instance, and writes nothing:

```sh
python3 .claude/skills/metis-seed-instance/scripts/seed_instance.py <seed-file> --dry-run
python3 .claude/skills/metis-seed-instance/scripts/seed_instance.py <seed-file>
```

The script is stdlib-only (no venv needed) and defaults to
`--base-url http://localhost:8000`.

Loading is **idempotent and add-only**: existing entities are matched (goals by
type+title; capabilities, features, products by name; edges by src+dst+kind;
motivations by pair) and reused, never duplicated, updated, or deleted. Because
names are identity, a seed entity whose name collides with an unrelated existing
entity will be silently reused instead of created — check the dry-run counts
("reused" vs "would create") against your expectations before the real run.

## Verify

After loading, confirm the data landed and is connected:

```sh
curl -s http://localhost:8000/api/capabilities/map   # capability forest w/ rollups
curl -s http://localhost:8000/api/graph/ready        # dependency-free work frontier
curl -s http://localhost:8000/api/capabilities/health  # taxonomy findings
```

Then point the user at the UI: http://localhost:4321.

## Troubleshooting

- **Connection refused** — instance is down; `docker compose up -d` from the repo root.
- **Edge rejected (422)** — the edge would close a precedence cycle *against edges
  already in the instance* (the file itself is checked before loading). The script
  skips it, reports a warning, and exits 2. Resolve the conflict in the seed file
  or in the instance, then re-run — everything already loaded is safely reused.
- **"product already has a PRD" note** — the loader never stacks a second
  decomposition version onto a product (normal on re-runs); create new PRD
  versions through the app.
- **Undo** — there is no bulk undo. Individual entities can be removed via
  `DELETE /api/{goals,capabilities,features,products}/{id}` (features cascade
  their edges; deleting a capability requires it to have no features).
