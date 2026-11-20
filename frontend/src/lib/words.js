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

// How fresh a product's map is, from its seeded_at (the last seed file import).
// freshness(null) → "never imported from a seed file"; else "updated today",
// "updated 3 days ago", "updated 5 months ago", "updated 2 years ago".
export function freshness(seededAt, now = Date.now()) {
  if (!seededAt) return "never imported from a seed file";
  const days = Math.max(0, Math.floor((now - new Date(seededAt).getTime()) / 86400000));
  if (days === 0) return "updated today";
  if (days < 30) return `updated ${count(days, "day")} ago`;
  if (days < 365) return `updated ${count(Math.floor(days / 30), "month")} ago`;
  return `updated ${count(Math.floor(days / 365), "year")} ago`;
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
// The same edges read from the other end: X DEPENDS_ON this → "needed by X".
export const EDGE_INCOMING = { DEPENDS_ON: "needed by", BLOCKS: "blocked by", RELATES_TO: "related to" };

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

/** Stack slot flags. */
export const FLAG = { gap: "empty", redundant: "duplicate", drift: "not in a slot", workaround: "workaround", trial: "on trial" };

// Who answered in Chat. The orchestrator is the one voice the reader talks
// to; specialists are named by the job they do.
export const AGENT = {
  orchestrator: "Metis",
  spec_decomposer: "Specs and tickets",
  feature_manager: "Features and capabilities",
  graph_agent: "Dependencies",
  strategist: "Delivery strategy",
};

/** A change a Chat agent proposed. */
export const PROPOSAL_STATUS = { pending: "waiting for you", applying: "applying", applied: "applied", rejected: "rejected", failed: "failed" };

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

/** Where one capability stands against the inventory. "Ours" takes a
 *  finished (done) feature: planned and in-progress work isn't having it.
 *  "missing" is never a capability's word: it is a feature's or a step's. */
export const NEED = {
  ours: { label: "ours", tone: "ok", hint: "a finished feature of one of our products realizes it" },
  elsewhere: { label: "only elsewhere", tone: "warn", hint: "only products we don't own have it, so it isn't ours" },
  // Not an alarm: often it is being built. Red is "missing"'s, a feature's word.
  none: { label: "not built yet", tone: "neutral", hint: "no finished feature in metis realizes it" },
};

/** The NEED key for a capability match or inventory entry (null: no match).
 *  `ours` false covers two cases; external_products tells them apart. */
export const needKey = (c) => (c?.ours ? "ours" : c?.external_products?.length ? "elsewhere" : "none");

/** For a "missing" feature or step: the NEED key every capability it lacks
 *  shares ("elsewhere" when each is known from a product we don't own, "none"
 *  when none is), or null for a mix. Takes the needs' matches (null for an
 *  unmatched name). Shown beside "missing", it says why. */
export function lackingKey(matches) {
  const keys = new Set(matches.map(needKey).filter((k) => k !== "ours"));
  return keys.size === 1 ? [...keys][0] : null;
}

/** "A", "A and B", "A, B and C". */
export const andList = (names) =>
  names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

/** One-line headline for a coverage report, the same wording everywhere. */
export function coverageHeadline(report) {
  return `We have ${report.existing} of the ${report.needed} capabilities needed · ${report.mature} proven (beta or stable)`;
}

// ---- A scored product (GET /products/{id}/coverage) ----
// The product page and its Share snapshot both say it with these, so the two
// can't drift apart. Only someone else's product is scored: ours would only
// be scoring themselves.

/** The answer first: how much we have, and whether anything is buildable. */
export function scoreHeadline(score) {
  if (!score.report) return null;
  return `${coverageHeadline(score.report)}${score.buildable.length === 0 ? ". Nothing is buildable yet." : ""}`;
}

/** Under "missing": how many of those also have capabilities nobody named. */
export function incompleteNote(score) {
  const n = score.missing_incomplete.length;
  if (n === 0) return null;
  return `${n === score.missing.length ? `All ${n}` : `${n} of these`} also have capabilities nobody has named yet, so adding what's named may not be enough.`;
}

export const gapsTitle = (gaps) => `${count(gaps.length, "capability", "capabilities")} we don't have, most useful first`;
/** After a missing capability's name in the ranked list. */
export function gapNote(gap) {
  return [
    `needed by ${count(gap.features, "feature")}`,
    gap.only_gap > 0 ? `the only gap in ${gap.only_gap} of them` : null,
    gap.elsewhere.length > 0 ? `also in ${andList(gap.elsewhere.map((p) => p.name))}` : "in no other product",
  ].filter(Boolean).join(" · ");
}
export const GAP_HINT = "The only gap: adding it covers every capability named for that feature, whose list may be incomplete.";

export const CLOSEST_TITLE = "Closest of our products";
/** Closest products with ties on one line: [{ products, capabilities }]. */
export function closestGroups(closest) {
  const groups = [];
  for (const c of closest) {
    const last = groups[groups.length - 1];
    if (last && last.capabilities === c.capabilities) last.products.push(c.product);
    else groups.push({ products: [c.product], capabilities: c.capabilities });
  }
  return groups;
}
/** After a closest group's names. */
export const closestNote = (group, score) =>
  `${group.products.length === 1 ? "has" : "have"} ${group.capabilities} of the ${score.report.needed} capabilities ${score.product.name}'s features name`;

export const NOTHING_TO_SCORE = "Nothing to score yet: none of its features names a capability.";

/** A scored product's features by VERDICT key (GET /products/{id}/coverage).
 *  The API partitions them, so the groups sum to total_features. */
export function scoreGroups(score) {
  return [
    { key: "buildable", names: score.buildable },
    { key: "partly", names: score.partly },
    { key: "missing", names: score.missing },
    { key: "unknown", names: score.not_described },
  ];
}

/** Look up a plain word; unknown values fall back to spaced lower case. */
export function plain(dict, value) {
  if (value == null) return "";
  return dict[value] ?? String(value).replace(/_/g, " ").toLowerCase();
}

/** The backend's slug rule (services/slugs.py): lowercase kebab. Capability
 *  identity is the slug, so "Route Import" and "route import" are one name. */
export const slugify = (value) => String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

// A guessed capability link (capability_guesses). Never counted until confirmed.
export const CONFIDENCE = {
  high: { label: "likely", tone: "accent", hint: "Strong public evidence, such as a docs page that shows it." },
  medium: { label: "possibly", tone: "warn", hint: "Described somewhere, but not shown." },
  low: { label: "a hunch", tone: "neutral", hint: "Plausible from what kind of product it is, nothing more." },
};
