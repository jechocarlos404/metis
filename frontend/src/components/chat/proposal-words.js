import { EDGE, LAYER, MATURITY, count, plain, priorityLabel, statusLabel } from "../../lib/words.js";

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

/** What each read tool does, as a step in "What it did". */
const READ = {
  list_goals: "Read the goals",
  list_products: "Read the products",
  list_features: "Read the features",
  list_capabilities: "Read the capabilities",
  capability_inventory: "Read what already exists",
  product_coverage: "Check an idea",
  existing_product_coverage: "Score a product",
  search_features: "Search the features",
  impact_query: "Find what needs a feature",
  topo_order: "Work out the build order",
  find_cycles: "Look for features that need each other in a loop",
  ready_set: "Find what's ready to start",
  capability_rollup: "Count a capability's progress",
  why_feature: "Trace why a feature exists",
  mvp_cut: "Work out the smallest version",
  taxonomy_health: "Check the capability map for gaps",
};

/** A step in "What it did": a change in the approval card's words, a read in its own. */
export const stepLabel = (tool) => CHANGE[tool] ?? READ[tool] ?? String(tool ?? "").replace(/_/g, " ");

const FIELD = {
  unknown_capabilities: "capability list incomplete",
  evidence_anchors: "evidence",
  priority_rationale: "why this priority",
  context_budget: "size",
  affected_files: "files",
  src: "from",
  dst: "to",
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

/** One row per argument of a step in "What it did", as fieldRows: names from
 *  the step's named arguments, plain words, the raw value for the hover. An
 *  object, or a list of them (a PRD document, an idea's features), is counted;
 *  the step's Raw block has it in full. */
export function stepRows(args, named) {
  const shown = named ?? args ?? {};
  return Object.keys(args ?? {}).map((key) => {
    const v = shown[key];
    const nested = v != null && typeof v === "object" && !isNew(v)
      && (!Array.isArray(v) || v.some((x) => x != null && typeof x === "object" && !isNew(x)));
    const value = v == null ? "none"
      : nested ? (Array.isArray(v) ? count(v.length, "item") : count(Object.keys(v).length, "field"))
      : text(key, v);
    const raw = nested || args[key] == null ? null : text(null, args[key]);
    return { key, label: FIELD[key] ?? key.replace(/_/g, " "), text: value, raw: raw === value ? null : raw };
  });
}

/**
 * The proposal each step stands for: a step is "proposed" exactly when the
 * runner stored a proposal for it, in the same order (proposals by seq), so
 * the k-th proposed step is the k-th proposal. A step shows that proposal's
 * state, never a word of its own that goes stale once someone decides. A
 * pairing that doesn't line up (another tool) gives null: no word beats a
 * wrong one.
 */
export function stepProposals(tools, proposals = []) {
  let k = 0;
  return tools.map((t) => {
    if (t.status !== "proposed") return null;
    const p = proposals[k++];
    return p && p.tool_name === t.name ? p : null;
  });
}
