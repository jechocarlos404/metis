---
name: metis-fill-gaps
description: In one of the owner's own repos that metis already knows, find the product's features whose capabilities metis marks unknown, read the code to see what each one is built on, and write a seed file of guesses plus a list of the links the code confirms, for the owner to review and load. Use when the owner asks to fill gaps, fix unknown capabilities, finish the capability links for this product, or when metis says a feature's capabilities are not named yet. Never writes to metis itself.
---

# Fill unknown capability links from code

Metis keeps a feature with `unknown_capabilities: true` when nobody has said
which capabilities it is built on. In the owner's own repo the code can answer
that. This skill reads the code for each such feature and hands the owner a
file to load, plus a list of links to add by hand.

The format is in `../metis-export/references/seed-format.md` (relative to this
skill's directory). Read its "Guesses" section before writing.

**Why two outputs.** A link you can see in code is real data, not a guess. But
the seed loader reuses a feature metis already has as it is: it adds guesses
to it, and ignores the file's `capability_refs` and `unknown_capabilities` for
it (`load_features` in `../metis-seed-instance/scripts/seed_instance.py`; the
desktop importer does the same). So:
- links the code confirms go in `source.confirmed_links` in the file and in
  your summary, for the owner to add on the desktop;
- links the code leaves ambiguous go in `capability_guesses`, which the loader
  does add.

`$API` below means `${METIS_API_URL:-http://localhost:8000}`. If the API has
auth on, set `METIS_API_TOKEN` (and add `-H "Authorization: Bearer
$METIS_API_TOKEN"` to each `curl`).

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
   curl -s "$API/api/capabilities/inventory" | python3 -c 'import json,sys; [print(c["name"], "|", (c["description"] or "")[:140]) for c in json.load(sys.stdin)]'
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
   - `features`: each feature that has at least one guess, re-stated with its
     exact metis name and `product_ref`, `capability_refs: []`,
     `unknown_capabilities: true`, and its `capability_guesses`.
   - `source`:

     ```json
     {
       "name": "<repo directory>",
       "generated_by": "metis-fill-gaps",
       "confirmed_links": [
         {"feature": "<exact feature name>", "capability": "<exact capability name>",
          "evidence": ["src/path/one.py", "src/path/two.py"]}
       ],
       "still_unknown": ["<exact feature name>"]
     }
     ```

     The loader ignores `source`, so this list travels with the file
     without changing what loads.

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
     paths. To add them: on the desktop's Features page open the feature,
     Edit, add the capabilities, and untick the unknown box once nothing is
     left unknown. The loader cannot add these.
   - that loading the guesses is their call: the `metis-seed-instance` skill
     (dry run first), or on the desktop, Settings, Seed files: check, then
     import. Each guess then waits on the feature for an editor to confirm.

## Never

- Write to metis. This skill reads the API and the repo and writes one file.
- Put a link you saw in code into `capability_guesses`: it is confirmed, and
  belongs in `source.confirmed_links`.
- Guess without a `basis` that cites the file you read.
- Invent a capability name when an exact inventory name fits, or create a
  near-duplicate of one.
- Rename a feature. The exact metis name is how the loader finds it; a new
  name makes a duplicate feature.
- Mark a stub, plan or README-only behaviour as built on anything.
