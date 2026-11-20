---
name: metis-unseed
description: Remove a previously seeded project from the running metis instance via the REST API — deletes the goals, capability map, features, dependency edges, motivations, and products named in a metis-seed JSON file, matching by the same name-identity the loader uses. Use whenever the user wants to unseed, remove, delete, or clean a seeded project out of their metis instance — e.g. to undo what a metis-seed.json created, or to clear the way before re-seeding a re-cut seed file.
---

# Unseed the metis instance

The inverse of `metis-seed-instance`: given a `metis-seed/v1` file, remove
what it created from the running instance. Matching uses the loader's
identity rules (goals by type+title; capabilities by slug; products by name;
features by product+name; technologies by slug; edges by src+dst+kind;
motivations and satisfactions by pair), so the file doesn't need
to be byte-identical to the one that was loaded. Names are identity: whatever
in the instance bears a seed entity's name is what gets deleted. For a
capability, a name differing only in case or punctuation counts as the same
name. A capability metis gave a `-2` slug is targeted correctly only by a file
that carries its slug, as files exported from metis now do; an older export
targets the row without the `-2` instead, so re-export first.

Paths below such as `scripts/` are relative to this skill's own directory, the
one holding this SKILL.md.

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
python3 <this skill's directory>/scripts/unseed_instance.py <seed-file> --dry-run
python3 <this skill's directory>/scripts/unseed_instance.py <seed-file>
```

The script is stdlib-only and defaults to `--base-url http://localhost:8000`.
It deletes in dependency-safe order (motivations, edges, features, products,
technologies, capabilities leaf-first, goals children-first) and protects
anything the seed shares with the rest of the instance:

- a **product is kept** if features outside the seed belong to it —
  deleting it would delete those features with it
- a **technology is kept** if a product outside the seed uses it, if it has an
  adoption stance, if it satisfies (or is guessed to satisfy) a capability
  the seed does not link it to, or if people recorded something about it that
  no seed file carries: who used it, a version, a link to another technology,
  or a slot of a stack that stays. On a kept technology, the seed's own
  satisfactions of a capability being deleted are removed first
- a **capability is kept** (not deleted) if features outside the
  seed realize it (any of a feature's capabilities counts — capabilities are
  shared across products), if a technology satisfies it or a guess points at it
  and the seed did not declare that link, or if any child capability is outside
  the seed or kept. A link the seed did not declare was recorded by someone
  else: deleting it would drop data the seed never created, and would strand
  any stack slot bound through it. So is one another product's epic is about,
  or a slot of a stack that stays answers
- a **goal is kept** if it has child goals outside the seed, or a product
  outside the seed (or a kept one) points at it
- a **goal link the seed does not declare keeps both its ends**: a goal the
  seed names is kept if it links to a capability by a link the file doesn't
  have, and a capability is kept if any goal links to it that way (the reason
  names the goal, so the owner can unlink it in the app). A capability another
  product added by hand is kept too. Deleting either end would take the link
  with it, and the seed never made it
- every **edge of a deleted feature** is deleted and listed one by one,
  including edges the seed doesn't declare and edges a foreign feature had to
  it; a feature's guesses and the capability links the file doesn't have are
  named on its line, and so is another product's story or a journey step that
  stays but loses its link to it
- deleting a **technology cascades its satisfactions and guesses**, each
  named on its line by capability
- deleting a **capability** takes any guess that a kept technology satisfies
  it, named on its line
- deleting a **product cascades its PRD, epics, stories, tickets (including
  ones created after seeding), delivery strategies, technology usage, hand-added
  capabilities and its own stacks**, each counted on its line. What only
  pointed at it stays and the line says so: a constraint stops applying to it,
  another product's stack based on its stack, a person's recorded use of a
  technology on it
- display numbers are not kept: importing the file again adds the rows back
  under new numbers (`OG-39` comes back as a new number), and the run says so
  first

Every kept row is listed with its reason (`note: kept ...`). Keeping shared
rows is the expected outcome of a normal unseed, not a problem: every real seed
reuses capabilities other products have.

Seed entities that don't exist in the instance are counted `absent`, so
re-running after a partial failure is safe.

### With auth on

An instance with `AUTH_ENABLED=false` needs no token. With auth on, only a
person's browser session on the desktop may delete, and no script can get
such a token (see the `metis-seed-instance` skill, "With auth on", for why and
for how to get a read-only one). Any valid token runs `--dry-run`: pass
`--token` or set `METIS_TOKEN` (`METIS_API_TOKEN` also works). A read-only
token cannot read guesses (editors and admins only), and a guess can keep a
capability or technology, so that dry run opens with a note and says
`can't tell whether capability ... goes` instead of `would delete` wherever a
guess could change the answer. Tell the user which rows are undecided; the
app's preview, run as an editor, settles them. For the real
removal, send the user to Settings → Seed files → "Remove a seeded product" in
the app: "Preview removal", then "Remove". The script stops with that advice on
a 401 or 403.

## Verify

```sh
curl -s http://localhost:8000/api/features | python3 -c 'import json,sys; print(len(json.load(sys.stdin)), "features")'
curl -s http://localhost:8000/api/capabilities/map   # remaining capability forest
```

If the point was to replace the data, re-seed now with the
`metis-seed-instance` skill.

## Sharp edges

- **Exit 0** means it finished. Kept rows are listed as notes with their
  reasons; that is the designed outcome, so report them to the user as
  information. Never re-point or delete another product's features, goal links
  or hand-added capabilities to make a shared row go away.
- **Exit 2** means some deletes failed (`warning:` lines, each with the API's
  answer). Read them, fix the cause, and re-run; rows already gone count as
  `absent`.
- **Exit 1** is a file or connection error, or a refusal: with auth on and a
  read-only token, a real run stops before deleting anything.
- **Never unseed a `metis-seed-gaps.json`.** It re-states a product's real
  features so new links attach to them; unseeding it deletes those features.
  Refuse, and point the owner to the desktop to remove a single link.
- **Name collisions cut both ways.** An unrelated entity that happens to
  bear the same name as a seed entity WILL be targeted — the dry-run listing
  is the safety net; read it.
