import { EDGE, LAYER, MATURITY, plain, priorityLabel, statusLabel } from "../../lib/words.js";

// The approval card's words: what a proposed change does, and each of its
// fields as a person reads it. The raw value (tool name, enum, UUID or code
// the agent passed) stays one hover away.

/** What each write tool does, as the card's heading. */
export const CHANGE = {
  create_capability: "New capability",
  update_capability: "Change a capability",
  motivate_capability: "Link a goal to a capability",
  create_feature: "New feature",
  update_feature: "Change a feature",
  link_features: "Link two features",
  set_feature_priority: "Set a feature's priority",
  create_product_spec: "New product",
  create_prd_draft: "New PRD draft",
  create_ticket: "New ticket",
  update_ticket: "Change a ticket",
  create_delivery_strategy: "New delivery strategy",
};

export const changeLabel = (tool) => CHANGE[tool] ?? String(tool ?? "").replace(/_/g, " ");

const FIELD = {
  unknown_capabilities: "capability list incomplete",
  evidence_anchors: "evidence",
  priority_rationale: "why this priority",
  context_budget: "size",
  affected_files: "files",
};

const VALUE = {
  maturity: (v) => plain(MATURITY, v),
  kind: (v) => plain(EDGE, v),
  layer: (v) => plain(LAYER, v),
  status: statusLabel,
  priority: priorityLabel,
};

/** A thing an earlier change in the same reply creates: {proposal, name}. */
const isNew = (v) => v != null && typeof v === "object" && !Array.isArray(v) && "proposal" in v && "name" in v;

const text = (key, v) => {
  if (v == null) return "";
  if (isNew(v)) return String(v.name);
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (VALUE[key] && typeof v !== "object") return VALUE[key](v);
  if (Array.isArray(v)) {
    return v.every((x) => x == null || typeof x !== "object" || isNew(x)) ? v.map((x) => text(null, x)).join(", ") : JSON.stringify(v);
  }
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
};

/** Any value an agent sent, as text safe to put on the card. Model output is
 *  untrusted: an object where a name belongs must not break the page. */
export const display = (v) => text(null, v);

/** The objects in what should be a list of objects; anything else, none. */
export const objects = (v) => (Array.isArray(v) ? v.filter((x) => x != null && typeof x === "object" && !Array.isArray(x)) : []);

/** One row per field: `text` from the named arguments (references already
 *  replaced by names), `raw` what the agent passed when it reads differently. */
export function fieldRows(args, named) {
  const shown = named ?? args ?? {};
  return Object.keys(args ?? {}).map((key) => {
    const value = text(key, shown[key]);
    const raw = text(null, args[key]);
    return { key, label: FIELD[key] ?? key.replace(/_/g, " "), text: value, raw: raw === value ? null : raw };
  });
}
