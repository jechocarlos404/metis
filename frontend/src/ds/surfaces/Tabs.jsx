import React from "react";

// A strip too wide for its box scrolls (the caller sets overflowX), so the
// tab reached by keyboard, and the one selected, scroll fully into view.
// Sideways only: the page itself stays where it is.
function reveal(strip, tab) {
  if (!strip || !tab) return;
  const s = strip.getBoundingClientRect();
  const t = tab.getBoundingClientRect();
  if (t.left < s.left) strip.scrollLeft -= s.left - t.left;
  else if (t.right > s.right) strip.scrollLeft += t.right - s.right;
}

const MOVE = { ArrowLeft: (i) => i - 1, ArrowRight: (i) => i + 1, Home: () => 0, End: (i, n) => n - 1 };

// The tabs keyboard pattern: Tab stops once, on the selected tab; Left and
// Right move along the strip (wrapping), Home and End go to its ends; Enter
// or Space selects. Moving doesn't select: on /data each tab loads its rows.
function moveFocus(e) {
  const move = MOVE[e.key];
  if (!move || e.altKey || e.ctrlKey || e.metaKey) return;
  const tabs = [...e.currentTarget.querySelectorAll('[role="tab"]')];
  const at = tabs.indexOf(e.target);
  if (at < 0) return;
  e.preventDefault(); // the browser would scroll the strip instead
  tabs[(move(at, tabs.length) + tabs.length) % tabs.length].focus({ preventScroll: true });
}

// label: the strip's accessible name ("Tables"). panelId: the id of the
// element the tabs swap, which the caller marks role="tabpanel" and labels
// with tabId(panelId, value); without it the tabs claim no panel, rather
// than point at one that isn't there.
export const tabId = (panelId, value) => `${panelId}-tab-${value}`;

export function Tabs({ tabs = [], value, onChange, style, label, panelId }) {
  const strip = React.useRef(null);
  // After render: the selected tab is set in semibold, so it is wider now.
  React.useEffect(() => {
    reveal(strip.current, strip.current?.querySelector('[aria-selected="true"]'));
  }, [value]);
  // A strip that scrolls fades at each edge it hides tabs behind, so a phone
  // shows there is more ("Features 4…" cut with no cue was C's note).
  const [cut, setCut] = React.useState({ start: false, end: false });
  const measure = React.useRef(() => {});
  measure.current = () => {
    const el = strip.current;
    if (!el) return;
    const start = el.scrollLeft > 1;
    const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setCut((c) => (c.start === start && c.end === end ? c : { start, end }));
  };
  React.useEffect(() => {
    const el = strip.current;
    const run = () => measure.current();
    el.addEventListener("scroll", run, { passive: true });
    const observer = new ResizeObserver(run);
    observer.observe(el);
    return () => { el.removeEventListener("scroll", run); observer.disconnect(); };
  }, []);
  React.useEffect(() => measure.current()); // labels and counts change widths
  const fade = cut.start || cut.end
    ? `linear-gradient(to right, ${cut.start ? "transparent, #000 32px" : "#000"}, ${cut.end ? "#000 calc(100% - 32px), transparent" : "#000"})`
    : undefined;
  const items = tabs.map((t) => (typeof t === "string" ? { value: t, label: t } : t));
  // The one Tab stop; the first tab when nothing is selected, so the strip stays reachable.
  const stop = items.some((t) => t.value === value) ? value : items[0]?.value;
  return (
    <div ref={strip} role="tablist" aria-label={label} onKeyDown={moveFocus}
      style={{ display: "flex", gap: "2px", borderBottom: "1px solid var(--border-hairline)", fontFamily: "var(--font-body)", maskImage: fade, WebkitMaskImage: fade, ...style }}>
      {items.map((tab) => {
        const active = tab.value === value;
        return (
          <button key={tab.value} role="tab" aria-selected={active} title={tab.title}
            id={panelId ? tabId(panelId, tab.value) : undefined} aria-controls={panelId}
            tabIndex={tab.value === stop ? 0 : -1}
            onClick={() => onChange && onChange(tab.value)}
            onFocus={(e) => reveal(strip.current, e.currentTarget)}
            style={{
              // A tab keeps its label on one line; a strip too wide scrolls instead.
              flex: "none", whiteSpace: "nowrap",
              padding: "8px 14px", fontSize: "var(--text-sm)", background: "none", border: "none",
              borderBottom: "2px solid " + (active ? "var(--accent)" : "transparent"),
              marginBottom: "-1px", cursor: "pointer",
              color: active ? "var(--text-heading)" : "var(--text-secondary)",
              fontWeight: active ? "var(--weight-semibold)" : "var(--weight-regular)",
              transition: "color var(--dur-fast) var(--ease-out)",
            }}>
            {tab.label}
            {tab.count != null && <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", marginLeft: "6px", color: "var(--text-secondary)" }}>{tab.count}</span>}
          </button>
        );
      })}
    </div>
  );
}
