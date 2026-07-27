/**
 * Shared vocabulary for the tech-plane screens.
 *
 * Every value here is rendered verbatim — snake_case stays snake_case, and a
 * stance is never title-cased. A screenshot, a log line and a chat transcript
 * have to stay greppable against each other, which stops being true the moment
 * one surface prettifies `in_progress` into "In Progress".
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
  return `as_of ${d.toISOString().replace(/\.\d+Z$/, "Z")}`;
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
