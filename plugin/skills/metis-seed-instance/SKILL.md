---
name: metis-seed-instance
description: Load a metis-seed JSON file into the running metis instance via the REST API: goals, capability map, features, dependency edges, motivations, technologies, guessed links, and spec/PRD documents. Use whenever the user wants to seed, load, import, or ingest data into their metis instance, mentions a metis-seed.json or a seed file exported from another repository, or describes goals/capabilities/features in conversation and wants them inserted into metis (author a seed file first, then load it).
---

# Seed the metis instance

Load a portable `metis-seed/v1` JSON file into the running instance. The file
usually comes from the companion `metis-export` skill run in another repository,
but any file matching the format works — including one you author on the spot
from conversation context.

Paths below such as `scripts/` and `references/` are relative to this skill's
own directory, the one holding this SKILL.md.

## Prerequisites

The instance must be up. Check, and start it if needed:

```sh
curl -s http://localhost:8000/api/health   # expect {"status":"ok",...}
docker compose up -d --build               # from the repo root, if it's down
```

If the schema changed since the volume was created, `create_all` won't migrate.
Ask the owner how to apply the change; never reset the volume, the instance holds
real data.

## Get a seed file

- If the user hands you a path (often `metis-seed.json` from another repo), use it.
- If the user describes the data in conversation (goals, capabilities, features,
  work items), read `references/seed-format.md` and author a seed file yourself —
  write it to a temp location, show the user a short summary of what it contains,
  then load it. Follow the ontology rules in the reference strictly: capabilities
  are durable nouns shared across products by name (check
  `GET /api/capabilities/inventory` and reuse existing names), features are
  user-facing verb phrases listing every capability they realize in
  `capability_refs` and naming their product in `product_ref`, goals motivate
  capabilities only, and the precedence graph must stay acyclic. Anything the user
  only supposes ("it probably uses search") is a guess: put it in
  `capability_guesses` with a `confidence`, never in `capability_refs`.

## Load it

Always dry-run first — it validates the file, diffs it against what's already in
the instance, and writes nothing:

```sh
python3 <this skill's directory>/scripts/seed_instance.py <seed-file> --dry-run
python3 <this skill's directory>/scripts/seed_instance.py <seed-file>
```

The script is stdlib-only (no venv needed) and defaults to
`--base-url http://localhost:8000`.

Loading is **idempotent and never deletes**: existing entities are matched
(goals by type+title; capabilities by slug; products by name; features by
product+name; technologies by slug; edges by src+dst+kind; motivations, product
technologies and satisfactions by pair) and reused, never duplicated or
deleted. Two updates: a reused feature gains the file's confirmed links it
lacks and takes the `status`, `description` and `unknown_capabilities` the file
states, and a guess that already exists for the same pair takes the file's
confidence and basis. Because names are identity, a seed entity whose name
matches an existing one is reused instead of created. For capabilities that is
intended — a shared name is how two products show they use the same ability,
and a name differing only in case or punctuation is the same capability
("note: capability "Keyword search" is the existing "Keyword Search" …") — but
a feature or product name that matches an unrelated entity is reused too, so
check the dry-run counts ("reused" vs "would create") against your expectations
before the real run. Every capability the file would create is listed by name
("note: new capability "Vector search"; nearest existing: "Keyword Search"");
check each for a near-duplicate. A reused feature keeps every link it has and
gains each `capability_refs` entry it lacks ("linked", or "would link" in a dry
run); adding a link deletes any guess about that same pair. When the file's
`status`, `description` or `unknown_capabilities` differs from the feature's,
the file wins, since a product's own seed is the authority on its features.
That can overwrite a hand edit, so each overwrite is listed per feature
("note: feature "Export a PRD": status in_progress → done; description
changed"): show those lines to the user before the real run. Fields the file
leaves out, and the feature's priority, are left alone, and its
`capability_guesses` are still loaded (skipped when the link is already
confirmed). Technologies load after features: the technology, its use by each
listed product, confirmed satisfactions, then guesses (`POST /api/guesses`,
editor or admin on the desktop). Legacy files with a single `capability_ref`
per feature still load.

### With auth on

An instance with `AUTH_ENABLED=false` needs no token. With auth on, the API
checks a token's role and also which client it was issued to, and **only a
person signed in to the web app as an editor or admin may write**. Keycloak
issues that token to the web app's login (`metis-web`) once the person enters
their password, and the app keeps it in an encrypted cookie. These scripts
sign no one in. So:

- **Dry run**: works with any valid token. Pass `--token`, or set
  `METIS_TOKEN` (`METIS_API_TOKEN`, the plugin hooks' variable, also works).
  The simplest is the read-only `metis-mcp` service account, whose secret is
  `METIS_MCP_CLIENT_SECRET` in metis's `.env` (`dev-mcp-secret` by default):

  ```sh
  export METIS_TOKEN=$(curl -s -d grant_type=client_credentials -d client_id=metis-mcp \
    -d client_secret=dev-mcp-secret \
    http://localhost:8080/realms/metis/protocol/openid-connect/token \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])')
  ```

  Tokens last 5 minutes. That account cannot read guesses (editors only), so
  guess counts assume none exist yet, and the dry run says so.
- **The real load**: not from a script. Tell the user to import the file in
  the app, at Settings → Seed files → "Add a product from its repo": "Check
  file" shows the same counts and notes as the dry run, then "Import". The
  script stops with that advice on a 401 or 403. A viewer can't import in the
  app either; the script says so, and that an editor or admin can.

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
- **Guess rejected**: the instance has no `/api/guesses` yet. Everything else
  loaded; re-run once it has.
- **401 or 403**: the instance has auth on. The script stops and says why; see
  "With auth on" above.
- **Edge rejected (422)** — the edge would close a precedence cycle *against edges
  already in the instance* (the file itself is checked before loading). The script
  skips it, reports a warning, and exits 2. Resolve the conflict in the seed file
  or in the instance, then re-run — everything already loaded is safely reused.
- **"product already has a PRD" note** — the loader never stacks a second
  decomposition version onto a product (normal on re-runs); create new PRD
  versions through the app.
- **Undo** — the companion `metis-unseed` skill removes everything a seed file
  created (dry-run first; it deletes by the same name-identity). Individual
  entities can be removed via
  `DELETE /api/{goals,capabilities,features,products}/{id}` (features cascade
  their edges; deleting a capability requires it to have no features).
