---
name: metis-unseed
description: Remove a previously seeded project from the running metis instance via the REST API — deletes the goals, capability map, features, dependency edges, motivations, and products named in a metis-seed JSON file, matching by the same name-identity the loader uses. Use whenever the user wants to unseed, remove, delete, or clean a seeded project out of their metis instance — e.g. to undo what a metis-seed.json created, or to clear the way before re-seeding a re-cut seed file.
---

# Unseed the metis instance

The inverse of `metis-seed-instance`: given a `metis-seed/v1` file, remove
what it created from the running instance. Matching uses the loader's
identity rules — goals by type+title; capabilities, features, and products by
name; edges by src+dst+kind; motivations by pair — so the file doesn't need
to be byte-identical to the one that was loaded. Names are identity: whatever
in the instance bears a seed entity's name is what gets deleted.

## Prerequisites

The instance must be up. Check, and start it if needed:

```sh
curl -s http://localhost:8000/api/health   # expect {"status":"ok",...}
docker compose up -d --build               # from the repo root, if it's down
```

## Remove it

Deletion is destructive and has no undo. **Always dry-run first, show the
user the full list of what would be deleted, and get their explicit
confirmation before the real run.**

```sh
python3 .claude/skills/metis-unseed/scripts/unseed_instance.py <seed-file> --dry-run
python3 .claude/skills/metis-unseed/scripts/unseed_instance.py <seed-file>
```

The script is stdlib-only and defaults to `--base-url http://localhost:8000`.
It deletes in dependency-safe order (motivations, edges, products, features,
capabilities leaf-first, goals children-first) and protects anything the seed
shares with the rest of the instance:

- a **capability is kept** (warning, not deleted) if features outside the
  seed realize it, or if any child capability is outside the seed or kept
- a **goal is kept** if it has child goals outside the seed, or a product
  outside the seed points at it
- deleting a **feature cascades its edges**, including edges a foreign
  feature had to it — those are reported as notes
- deleting a **product cascades its PRD and all epics/stories/tickets**,
  including tickets created after seeding

Seed entities that don't exist in the instance are counted `absent`, so
re-running after a partial failure is safe.

## Verify

```sh
curl -s http://localhost:8000/api/features | python3 -c 'import json,sys; print(len(json.load(sys.stdin)), "features")'
curl -s http://localhost:8000/api/capabilities/map   # remaining capability forest
```

If the point was to replace the data, re-seed now with the
`metis-seed-instance` skill.

## Sharp edges

- **Exit 2** means it finished but kept or failed some entities — read the
  warnings and resolve them (usually: the shared entity needs its foreign
  features re-pointed or deleted in the app first), then re-run.
- **Name collisions cut both ways.** An unrelated entity that happens to
  bear the same name as a seed entity WILL be targeted — the dry-run listing
  is the safety net; read it.
