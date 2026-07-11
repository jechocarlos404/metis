import React from "react";

export function Tabs({ tabs = [], value, onChange, style }) {
  return (
    <div role="tablist" style={{ display: "flex", gap: "2px", borderBottom: "1px solid var(--border-hairline)", fontFamily: "var(--font-body)", ...style }}>
      {tabs.map((t) => {
        const tab = typeof t === "string" ? { value: t, label: t } : t;
        const active = tab.value === value;
        return (
          <button key={tab.value} role="tab" aria-selected={active}
            onClick={() => onChange && onChange(tab.value)}
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
