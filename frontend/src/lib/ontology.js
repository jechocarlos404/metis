/**
 * Shared vocabulary for the tech-plane screens.
 *
 * The constants here are the API's raw enum values (tones, facet orders).
 * Screens show people plain words and keep the raw value one hover away
 * (<Term>, lib/words.js; see PRODUCT.md). Chat tool output, MCP and logs keep
 * the raw values verbatim so they stay greppable against each other.
 */

/** Adoption stance → Badge tone. From the design handoff, unchanged. */
export const STANCE_TONE = {
  standard: "ok",
  adopted: "ok",
  trial: "accent",
  candidate: "neutral",
  contained: "warn",
  deprecated: "danger",
  banned: "danger",
};

/** Slot flag → Badge tone. Each flag is a predicate over one row. */
export const FLAG_TONE = {
  gap: "danger",
  redundant: "warn",
  drift: "warn",
  workaround: "warn",
  trial: "accent",
};

/** Fit is a three-value judgement, not a score. */
export const FIT_TONE = {
  native: "ok",
  partial: "neutral",
  workaround: "warn",
};

/** Pipeline order, agent-first — the stack reads the way a request travels. */
export const LAYERS = ["agent", "web", "api", "data", "infra", "ops"];

export const KINDS = [
  "language",
  "framework",
  "library",
  "runtime",
  "service",
  "model",
  "protocol",
];

export const STANCES = Object.keys(STANCE_TONE);

/** `as_of` is printed, not hidden in metadata: it is how a reader knows how
 *  stale the thing in front of them is. */
export function formatAsOf(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return `as of ${d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`;
}

/** Mono micro-label, 11px uppercase with caps tracking. Used for every
 *  machine-flavoured label in these screens. */
export const MICRO = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-2xs)",
  letterSpacing: "var(--tracking-caps)",
  textTransform: "uppercase",
  color: "var(--text-disabled)",
};

/** Machine values rendered in place: ids, slugs, statuses, enum values. */
export const MONO = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-2xs)",
  color: "var(--text-secondary)",
};

export const CARD = {
  background: "var(--surface-card)",
  border: "1px solid var(--border-hairline)",
  borderRadius: "var(--radius-md)",
  boxShadow: "var(--shadow-card)",
};

/** Dense grids keep their column widths and scroll rather than truncate. */
export const SCROLL_X = { overflowX: "auto" };
