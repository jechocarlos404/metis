---
name: metis-what-next
description: Propose 2 to 4 concrete ideas worth building next, made mostly from capabilities the owner's products already have, using the metis MCP server's capability_inventory and check_idea tools. Each idea is checked against the inventory, ranked by how much already exists, and comes with a link that opens Home's idea check filled in. Use when the user asks "what should we build next", "what could we make from what we have", "what should I work on next", or gives a goal or a product and wants ideas that reuse existing work.
---

# What could we build next?

Metis is the owner's capability inventory across all their products. The
useful answer to "what next" is an idea checked against that inventory: a new
product or feature that mostly reuses capabilities already built. This skill
proposes a few such ideas and hands the owner one link per idea.

Everything here is a read. The metis MCP server is read-only, and saving an
idea is the owner's choice on the metis desktop. Never save, create or change
anything, and never say an idea was saved.

## Steps

1. **Start from the owner's aim.** Use the goal or product the user gave. If
   they gave neither and the session's metis brief (from the SessionStart hook)
   named this repo's product, start from that product. Otherwise ask one short
   question: a goal, or a product to build on.

2. **See what already exists.** Call `capability_inventory` (no `q` for the
   most reused first; add a `q` substring to look for something specific). The
   strongest raw material is a capability that is ours, `beta` or `ga`, and in
   several products. For a product the user named, `capability` on a few of its
   slugs shows which products and features already use them.

3. **Draft 2 to 4 ideas.** Each idea is a name and one to three user-facing
   features, each feature with the capabilities it needs. Build them mostly
   from exact slugs the inventory printed. A capability nobody has yet is fine
   when the idea needs it; give it a plain name and expect it to come back
   `no match`. Prefer ideas that serve the stated goal over ones that only
   reuse a lot.

4. **Check each idea.** Call `check_idea` once per idea, with `idea` set to the
   idea's name:

   ```json
   {"idea": "Ride receipts", "features": [{"name": "Scan a receipt", "capabilities": ["file-storage", "on-device-text-recognition"]}]}
   ```

   Keep the first line (how many distinct capabilities are ours, how many
   in use) and the last line, which starts with `Open:`.

5. **Rank** by how much already exists: the share of distinct capabilities
   that are ours, then how many of those are in use (`beta` or `ga`). An idea
   whose missing capabilities have near-name candidates is not further along:
   a candidate is unconfirmed until a human confirms it.

6. **Report** each idea in rank order:
   - the name and one line on what a user could do with it;
   - the first line of its `check_idea` answer, verbatim;
   - what is ours (and from which products), what is missing;
   - its link: the `Open:` path exactly as `check_idea` printed it, prefixed
     with the metis web address if you know it (by default
     `http://localhost:4321`). Never build or edit the link yourself.

   End by saying that each link opens Home's idea check filled in and already
   checked, and the owner can adjust it and choose Save as idea there.

## Rules

- Exact names only. A near name is a candidate for a human to confirm, never
  counted as ours.
- A gap is an answer. If nothing in the inventory fits the goal, say so and
  propose the smallest idea that would start building toward it.
- Do not use `ready_features` to answer this. It lists pending, unblocked
  features, which is usually empty.
- If the metis tools are not available, say so and point at the plugin
  README's "Start the MCP service" section. Do not guess the inventory.
