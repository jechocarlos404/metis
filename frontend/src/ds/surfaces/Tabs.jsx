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

export function Tabs({ tabs = [], value, onChange, style }) {
  const strip = React.useRef(null);
  // After render: the selected tab is set in semibold, so it is wider now.
  React.useEffect(() => {
    reveal(strip.current, strip.current?.querySelector('[aria-selected="true"]'));
  }, [value]);
  const items = tabs.map((t) => (typeof t === "string" ? { value: t, label: t } : t));
  // The one Tab stop; the first tab when nothing is selected, so the strip stays reachable.
  const stop = items.some((t) => t.value === value) ? value : items[0]?.value;
  return (
    <div ref={strip} role="tablist" onKeyDown={moveFocus} style={{ display: "flex", gap: "2px", borderBottom: "1px solid var(--border-hairline)", fontFamily: "var(--font-body)", ...style }}>
      {items.map((tab) => {
        const active = tab.value === value;
        return (
          <button key={tab.value} role="tab" aria-selected={active} title={tab.title}
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
