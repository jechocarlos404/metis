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

export function Tabs({ tabs = [], value, onChange, style }) {
  const strip = React.useRef(null);
  // After render: the selected tab is set in semibold, so it is wider now.
  React.useEffect(() => {
    reveal(strip.current, strip.current?.querySelector('[aria-selected="true"]'));
  }, [value]);
  return (
    <div ref={strip} role="tablist" style={{ display: "flex", gap: "2px", borderBottom: "1px solid var(--border-hairline)", fontFamily: "var(--font-body)", ...style }}>
      {tabs.map((t) => {
        const tab = typeof t === "string" ? { value: t, label: t } : t;
        const active = tab.value === value;
        return (
          <button key={tab.value} role="tab" aria-selected={active} title={tab.title}
            onClick={() => onChange && onChange(tab.value)}
            onFocus={(e) => reveal(strip.current, e.currentTarget)}
            style={{
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
