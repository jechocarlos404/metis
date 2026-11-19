// People's words for the API's enums and counts — one word per concept,
// everywhere. Screens render the plain word; the raw value stays one hover
// away (<Term>, components/shared/Term.jsx) and verbatim in Chat/MCP output.

const STATUS = {
  pending: "planned",
  in_progress: "in progress",
  done: "done",
  draft: "draft",
  approved: "approved",
  blocked: "blocked",
};

export function statusLabel(status) {
  return STATUS[status] ?? String(status ?? "").replace(/_/g, " ");
}

// count(3, "slot") → "3 slots"; count(1, "capability", "capabilities") → "1 capability"
export function count(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

// One product order for every picker: ours first, then external, each A–Z.
export const productOptions = (products) =>
  [...products]
    .sort((a, b) => Number(a.external) - Number(b.external) || a.name.localeCompare(b.name))
    .map((p) => ({ value: p.id, label: p.external ? `${p.name} (external)` : p.name }));

// ---- Shared vocabulary (PRODUCT.md: plain words on screen, raw underneath) ----

/** Capability maturity. "Proven" = beta or stable. */
export const MATURITY = {
  planned: "planned",
  alpha: "alpha",
  beta: "beta",
  ga: "stable",
  deprecated: "deprecated",
  retired: "retired",
};
export const PROVEN_MATURITIES = new Set(["beta", "ga"]);

/** Feature edge kinds. */
export const EDGE = {
  DEPENDS_ON: "needs",
  BLOCKS: "blocks",
  RELATES_TO: "related to",
};

/** Feature layer facet. */
export const LAYER = {
  ui: "UI",
  service: "service",
  integration: "integration",
  infra: "infrastructure",
};

/** Technology fit for a capability. */
export const FIT = {
  native: "fits",
  partial: "partial fit",
  workaround: "workaround",
};

/** Priority 1–5, 1 most urgent. */
export const priorityLabel = (p) => (p == null ? "no priority" : `P${p}`);
export const PRIORITY_HINT = "P1 is most urgent, P5 least";

/**
 * The one "can we build it?" vocabulary — Home, Products, Journeys and every
 * coverage report use these words and tones and nothing else.
 *   live        a product of ours does this today
 *   buildable   every capability it needs is ours
 *   partly      everything anyone named is ours, but the list is incomplete
 *   missing     needs a capability we don't have
 *   unknown     nobody has named its capabilities yet
 */
export const VERDICT = {
  live: { label: "live", tone: "accent", hint: "one of our products does this today" },
  buildable: { label: "buildable", tone: "ok", hint: "every capability it needs is ours" },
  partly: { label: "partly known", tone: "warn", hint: "everything named so far is ours, but the list is incomplete" },
  missing: { label: "missing", tone: "danger", hint: "needs a capability we don't have" },
  unknown: { label: "not described", tone: "neutral", hint: "nobody has named the capabilities it needs yet" },
};

/** Where one capability need stands against the inventory. */
export const NEED = {
  ours: { label: "ours", tone: "ok", hint: "one of our features realizes it" },
  elsewhere: { label: "only elsewhere", tone: "warn", hint: "only products we don't own have it, so it isn't ours" },
  none: { label: "missing", tone: "danger", hint: "no product in metis has it" },
};

/** Look up a plain word; unknown values fall back to spaced lower case. */
export function plain(dict, value) {
  if (value == null) return "";
  return dict[value] ?? String(value).replace(/_/g, " ").toLowerCase();
}

/** The backend's slug rule (services/slugs.py): lowercase kebab. Capability
 *  identity is the slug, so "Route Import" and "route import" are one name. */
export const slugify = (value) => String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
