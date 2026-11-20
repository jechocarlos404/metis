import { slugify } from "./words.js";

// Home's idea check, pre-filled from a link: /home?idea=<name>&caps=<slug>,<slug>,...
// (the MCP check_idea tool ends with one). Each cap is an exact slug or an
// exact name; anything else stays as typed and reads "missing". Never fuzzy.
// idea and caps are the decoded query values (readParam), or null.
export function parseIdeaParams(idea, caps, inventory) {
  const picked = [];
  for (const raw of String(caps ?? "").split(",")) {
    const token = raw.trim();
    if (!token) continue;
    const known = inventory.find((c) => c.slug === token) ?? inventory.find((c) => c.name === token);
    const name = known ? known.name : token;
    // The picker treats slug-equal names as one pick.
    if (!picked.some((p) => slugify(p) === slugify(name))) picked.push(name);
  }
  return { idea: String(idea ?? "").trim(), caps: picked };
}
