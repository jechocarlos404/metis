---
name: metis-find-reuse
description: Find another of the owner's products that already has a capability you are about to build, and point at its evidence (code paths) so you can reuse or copy its approach. Uses the metis MCP server's capability_inventory and capability tools. Use when the user is about to implement something like authentication, file uploads, search, notifications, or payments and asks "where have we done this before", "can I reuse this from another project", or when a metis hook says a capability already exists in another product.
---

# Find reuse in another product

Metis knows which of the owner's products realize which capabilities, and for
many capabilities it records evidence anchors: file paths, relative to the
exporting repo's root, where the capability lives. This skill finds the best
existing implementation of a capability so the agent can read it instead of
writing one from scratch.

Read-only: the metis MCP server refuses every write.

## Steps

1. **Find the capability.** Call `capability_inventory` with a short `q`
   substring of what you are about to build (`auth`, `upload`, `search`,
   `notif`). It prints one line per capability: slug, maturity, feature
   count, our products and external products. Pick the slugs that look like
   the same thing. If none does, say metis has no record of it and stop: that
   is an answer.

2. **Look it up.** Call `capability` with the slug. It returns:
   - its name and description, to confirm it really is the same thing,
   - our products that have it, and external products listed apart,
   - our features that realize it, with status and product,
   - its maturity (`ga` and `beta` are proven),
   - `Evidence (...)`: the recorded paths, when an export recorded any.

3. **Choose where to look.** Prefer a product whose features using this
   capability are `done`, and a capability at `ga` or `beta`. The evidence
   paths belong to the capability, not to one product, so match a path to a
   product only when the path makes it obvious (for example a top-level
   directory named after the product's repo). Otherwise list the paths and the products side by side
   and say the mapping is not recorded.

4. **Point at the code.** If the other product's repo is on this machine (try
   a sibling directory of the current repo named like the product slug), read
   the evidence paths there. If it is not, give the user the product name and
   the paths so they can open it.

5. **Report** the product to reuse from, why (status, maturity), the paths to
   read, and anything that suggests the implementation would not fit here.

## Rules

- Exact names only. A near name is a candidate, never the same capability.
- External products tell us something exists in the world; they have no code
  of ours to reuse.
- If the metis tools are not available, say so and point at the plugin
  README. Do not invent paths.
