---
name: metis-check-idea
description: Before building something new (a feature, a product, a module), check the metis capability inventory for what already exists and where, using the metis MCP server's check_idea tool. Use when the user asks to build, add, or plan something and wants to know what can be reused, asks "do we already have X", "what would it take to build Y", or proposes a new product or feature idea.
---

# Check an idea against metis

Metis is the owner's capability inventory, shared across all their products. A
capability is a durable noun ("User Authentication", "File Storage"); a feature
is something a user can do. This skill answers: *how much of this idea do we
already have, and in which products?*

Everything here is a read. The metis MCP server is read-only; never try to
write to metis from this skill.

## Steps

1. **Phrase the idea as features with capability names.** Break the idea into
   the user-facing features it needs, and for each, the capabilities it needs.
   Use metis's own names: first call `capability_inventory` (optionally with a
   `q` substring, such as `auth` or `search`) and reuse the exact slugs it
   prints whenever a capability means the same thing. `check_idea` takes a
   slug (`file-storage`) or the name (`File Storage`) alike. Only invent a
   name when nothing in the inventory fits.

2. **Call `check_idea`** with that breakdown:

   ```json
   {
     "features": [
       { "name": "Sign in with Google", "capabilities": ["User Authentication"] },
       { "name": "Upload a receipt photo", "capabilities": ["File Storage", "Receipt Parsing"] }
     ]
   }
   ```

   Each capability comes back as one of:
   - `ours`: a finished (`done`) feature of one of our products realizes it.
     Reuse it. The products listed beside it have work on it at any status;
     at least one of them finished it.
   - `only elsewhere`: only an external product has it. It exists in the
     world, we have not built it.
   - `not built yet`: metis knows the capability, but no finished feature
     realizes it; our features on it, if any, are planned or in progress.
   - `no match`: metis has no capability by that name. Near names may be
     listed as unconfirmed candidates.

3. **For each `ours` capability that matters, call `capability`** with its slug
   (lowercase, dashes, as `check_idea` prints it) to see which products and
   features realize it, its maturity, and the evidence paths an export
   recorded. Those paths are relative to the repo that exported them and
   belong to the capability, not to one product: say which repo they likely
   come from only if the path makes it obvious.

4. **Report** in this order:
   - What we already have, by capability, with the products that have it and
     its maturity (`ga` and `beta` are proven; `alpha` and `planned` are not).
   - What we don't have yet (`only elsewhere`, `not built yet`, `no match`),
     and any near-name candidates, labelled as unconfirmed.
   - A short recommendation: which pieces to reuse from where, which to build.

## Rules

- Matching is exact by name. A near name is a candidate for the human to
  confirm, never a match. Do not count it as something we have.
- An empty answer or a gap is a real answer. Say so plainly.
- If the metis tools are not available (the MCP server is not running), say
  so and point at the plugin README's "Start the MCP service" section. Do not
  guess at the inventory.
