---
name: metis-fill-gaps
description: In one of the owner's own repos that metis already knows, find the product's features whose capabilities metis marks unknown, read the code to see what each one is built on, and write a seed file of the links the code confirms plus guesses for the rest, for the owner to review and load. Use when the owner asks to fill gaps, fix unknown capabilities, finish the capability links for this product, or when metis says a feature's capabilities are not named yet. Never writes to metis itself.
---

# Fill unknown capability links from code

Metis keeps a feature with `unknown_capabilities: true` when nobody has said
which capabilities it is built on. In the owner's own repo the code can answer
that. This skill reads the code for each such feature and hands the owner a
file to load.

The format is in `../metis-export/references/seed-format.md` (relative to this
skill's directory). Read its "Guesses" section before writing.

**Facts and guesses.** A link you can see in code is real data, not a guess.
When the loader reuses a feature metis already has, it adds every
`capability_refs` entry the feature lacks (never removing one), takes the
file's `unknown_capabilities` (and its `status` and `description`, when the
file states them), and loads its `capability_guesses`; a confirmed link
deletes any guess about the same pair. So:
- links the code confirms go in the feature's `capability_refs`;
- links the code leaves ambiguous go in `capability_guesses`.

The loader does not update a capability metis already has, so the
`evidence_anchors` you would add to an existing capability go in your hand-off
summary instead (step 7).

The commands below read the API at `METIS_API_URL` (default
`http://localhost:8000`). If the API has auth on, set `METIS_API_TOKEN` (or
`METIS_TOKEN`, or pass `--token`); the script sends it, and you add
`-H "Authorization: Bearer $METIS_API_TOKEN"` to each `curl`. Any valid token
reads, including the read-only `metis-mcp` one; the `metis-seed-instance`
skill's "With auth on" shows how to get it.

## Steps

1. **Find the product and its gaps.** From the repo root:

   ```sh
   python3 <this skill's directory>/scripts/find_gaps.py
   ```

   It matches the repo to a product exactly as the plugin's hooks do
   (`metis-seed.json` at the root naming one of our products, else the repo
   directory's slug equal to a product slug), then lists that product's
   features with unknown capabilities and the links each one already has. If
   the owner names the product, pass `--product "<exact name>"`.
   Stop where it says stop:
   - not a known product: suggest `metis-export`;
   - an external product: there is no code of ours, suggest
     `metis-map-outside-product`;
   - no unknown features: tell the owner there is nothing to fill.

2. **Read the capability inventory.**

   ```sh
   curl -s "${METIS_API_URL:-http://localhost:8000}/api/capabilities/inventory" | python3 -c 'import json,sys; [print(c["name"], "|", (c["description"] or "")[:140]) for c in json.load(sys.stdin)]'
   ```

3. **Trace each feature in the code.** Find where a user reaches it (route,
   screen, command) and follow it to what it calls. For each capability it
   relies on, sort the link into one of three:
   - **Confirmed:** you can see the feature's code call the capability's code.
     Note the exact capability name and the file paths that show it.
   - **Guess:** the code points at it but you could not trace it end to end
     (dynamic dispatch, a config-driven call, a service in another repo).
     Confidence: `high` when the code names the behaviour and only the last
     hop is missing; `medium` when related code exists but the link is
     indirect; `low` when it is only plausible from what the feature does.
     The `basis` cites the file path you looked at.
   - **Unknown:** nothing found. Leave it out and say so in the summary.

   Skip links the feature already has (step 1 prints them).

4. **Pick capability names.** Reuse an existing capability by its exact
   inventory name, character for character, whenever it names the same
   ability. Add a new one only when nothing fits: a durable noun, a
   `description`, `maturity` from what the code shows, and `evidence_anchors`
   with real repo paths. Declare in `capabilities` only the ones a guess or a
   confirmed link names: the loader creates every declared capability that
   does not exist yet.

5. **Write `metis-seed-gaps.json`** at the repo root. Never overwrite the
   repo's own `metis-seed.json`: it is the product's export and how the hooks
   recognize the repo.
   - `products`: one entry, the product's exact name, `"external": false`.
   - `features`: each feature with at least one confirmed link or guess,
     re-stated with its exact metis name and `product_ref`:
     - `capability_refs`: the links the code confirms (only new ones are
       needed: the loader never removes a link the file leaves out);
     - `capability_guesses`: the ambiguous ones;
     - `unknown_capabilities`: `false` only when the confirmed links account
       for everything the feature is built on (no guesses, nothing unknown),
       else `true`. The loader takes this value, so `false` clears the gap.
     - no `status` or `description`: the loader would replace metis's values
       with them, and the description `find_gaps.py` prints is cut short.
   - `source`:

     ```json
     {
       "name": "<repo directory>",
       "generated_by": "metis-fill-gaps",
       "still_unknown": ["<exact feature name>"]
     }
     ```

     `still_unknown` lists the features you traced and found nothing for; they
     are not in `features`. The loader ignores `source`.

6. **Validate.**

   ```sh
   python3 <this skill's directory>/../metis-export/scripts/validate_seed.py metis-seed-gaps.json
   ```

   Fix every error and run it again until it passes.

7. **Stop and hand off.** Tell the owner:
   - the file's absolute path,
   - counts: features traced, confirmed links, guesses by confidence,
     features still unknown, new capabilities (list every new name),
   - the confirmed links as a table of feature, capability and evidence
     paths (for an existing capability this is the only record of its
     evidence: the loader does not update its `evidence_anchors`),
   - that loading is their call: the `metis-seed-instance` skill (dry run
     first; confirmed links show as "linked"), or on the desktop, Settings,
     Seed files: check, then import. Each guess then waits on the feature for
     an editor to confirm.

## Never

- Write to metis. This skill reads the API and the repo and writes one file.
- Put a link you saw in code into `capability_guesses`: it is confirmed, and
  belongs in the feature's `capability_refs`.
- Put a link in `capability_refs` that you could not trace end to end: that is
  a guess.
- Guess without a `basis` that cites the file you read.
- Invent a capability name when an exact inventory name fits, or create a
  near-duplicate of one.
- Rename a feature. The exact metis name is how the loader finds it; a new
  name makes a duplicate feature.
- Mark a stub, plan or README-only behaviour as built on anything.
- Suggest undoing a gaps file with metis-unseed. A gaps file re-states the
  product's real features by name, so unseeding it deletes them. To undo a
  link, remove it on the desktop.
