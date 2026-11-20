---
name: metis-map-outside-product
description: Describe someone else's product (a competitor or a reference product) from its public pages only, and write a metis seed file for it as an external product. Its features are what the marketing site, docs, help centre, changelog or pricing page show today; its capability links are marked guesses with a confidence and a source URL, reusing exact capability names from the metis inventory. Use when the owner names another company's product or app and its URL and asks to map it, add it to metis, compare it with their products, or see which of its capabilities they already have. Never writes to metis itself.
---

# Map an outside product into a seed file

The owner names a product that is not theirs and gives its public URL(s). You
read those public pages, decide what a user can do with the product today, and
write a `metis-seed/v1` file describing it as an external product. Loading the
file into metis is the owner's call, not yours.

The format is in `../metis-export/references/seed-format.md` (relative to this
skill's directory). Read its "Guesses" section and the external-product rules
before writing.

Why guesses: we have no access to the product's code, its users, or the
product itself, so every feature-to-capability link is inferred. Metis stores
such links as guesses, shows them to editors only, and counts none of them
until a person confirms each one on the desktop.

`$API` below means `${METIS_API_URL:-http://localhost:8000}`. If the API has
auth on, add `-H "Authorization: Bearer $METIS_API_TOKEN"` to each `curl`.

## Steps

1. **Get the product and its URLs.** You need the product's exact public name
   and at least one public URL (home page, docs or help centre). If the owner
   gave no URL, ask for one, or find the official site with WebSearch and
   confirm it with them.

2. **Check whether metis already has it.**

   ```sh
   curl -s "$API/api/products" | python3 -c 'import json,sys; [print(p["id"], p["name"], "external" if p["external"] else "ours") for p in json.load(sys.stdin)]'
   ```

   - Same product, `external`: reuse its exact `name`. Then list its features
     and reuse each exact feature name when you describe the same thing, or
     the loader creates a duplicate:

     ```sh
     curl -s "$API/api/features" | python3 -c 'import json,sys; [print(f["name"]) for f in json.load(sys.stdin) if f["product_id"]=="<product id>"]'
     ```

   - Same product but `ours`: stop. It is the owner's own product, so its
     links come from code: use `metis-export` or `metis-fill-gaps` instead.
   - If metis is unreachable, say so and stop: without the inventory the file
     would split shared capabilities into near-duplicates.

3. **Read the capability inventory.**

   ```sh
   curl -s "$API/api/capabilities/inventory" | python3 -c 'import json,sys; [print(c["name"], "|", (c["description"] or "")[:140]) for c in json.load(sys.stdin)]'
   ```

   Use this REST list, not the MCP `capability_inventory` tool's slugs: you
   need the exact names.

4. **Read the public pages.** Use WebFetch on the URLs you were given, then on
   the pages they link to: features, docs, help centre, changelog, pricing,
   integrations. Use WebSearch only to find the product's own official pages.
   For each user-facing thing you find, note the URL and whether the page
   shows it working (screenshot, demo, step-by-step docs) or only describes
   it. Stop at roughly 10 to 30 features; breadth matters more than every
   settings toggle.

5. **Write the features.** One per user-facing thing the pages show or
   describe as available today, named the way a user changelog would read
   ("Share a dashboard with a public link"), never as machinery ("Event
   ingestion pipeline"). Each one:
   - `status: "done"`. A feature on a paid plan, or in a public beta anyone
     can turn on, is still available. Leave out anything marked coming soon,
     planned, on a waitlist, or on a roadmap.
   - `product_ref` set to the one product.
   - `capability_refs: []` and `unknown_capabilities: true`.
   - `capability_guesses`: the capabilities it is most likely built from,
     each with:
     - `confidence`: `high` when a public page shows it working (docs with
       screenshots, a demo); `medium` when a page describes it but does not
       show it; `low` when it is only plausible from the product's category.
     - `basis`: one sentence that cites the URL it came from.
   - `description`: one sentence of what the user gets, from the pages.

6. **Write the capabilities.** Declare every capability a guess names.
   - Reuse an existing capability by its exact inventory name, character for
     character, whenever the meaning matches. There is no fuzzy matching in
     metis: "Auth" will not join "User Authentication".
   - Add a new capability only when nothing in the inventory fits. Give it a
     durable noun name and a one-line `description`. Leave `maturity` and
     `evidence_anchors` unset: they describe our own code.
   - Keep a list of the new names for the summary.

7. **Write the product.** Exactly one, with `"external": true`, its exact
   name and a one-line `summary`. No goals, motivations, edges, technologies
   or decomposition: those describe our own work or need code to confirm.

8. **Save the file** in the current directory as
   `metis-seed-<product-slug>.json` (lowercase, every run of other characters
   becomes `-`). Do not overwrite a repo's own `metis-seed.json`. Set
   `"source": {"name": "<product name> public pages", "generated_by":
   "metis-map-outside-product", "urls": [...]}`.

9. **Validate.**

   ```sh
   python3 <this skill's directory>/../metis-export/scripts/validate_seed.py metis-seed-<product-slug>.json
   ```

   Fix every error and run it again until it passes.

10. **Stop and hand off.** Tell the owner:
    - the file's absolute path,
    - counts: features, capabilities reused, capabilities new, guesses by
      confidence,
    - every new capability name, so they can review it before it enters the
      inventory,
    - that loading is their call: the `metis-seed-instance` skill (dry run
      first), or on the desktop, Settings, Seed files: check, then import.

## Never

- Write to metis. This skill only reads the API and writes one local file.
- Put a link in `capability_refs`. Nothing about someone else's product is
  confirmed from outside; every link is a guess.
- Invent a capability name when an exact inventory name fits, or create a
  near-duplicate of one.
- Mark a roadmap, coming soon or waitlist item as a feature, or as `done`.
- Write a guess without a `basis` that cites the public URL it came from.
- Read anything that is not public: no logins, no trial accounts, no scraped
  user data.
