import React from "react";

// Wraps instead of squeezing: on a narrow screen the meta and the actions move
// to their own lines at their own width, so a picker keeps its value visible
// and a button isn't clipped.
export function PageHeader({ title, meta, actions }) {
  return (
    <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "8px 12px", padding: "14px 24px", borderBottom: "1px solid var(--border-hairline)", background: "var(--surface-card)", flex: "none" }}>
      <h1 style={{ fontSize: "var(--text-lg)", fontWeight: "var(--weight-semibold)", minWidth: 0, overflowWrap: "anywhere" }}>{title}</h1>
      {meta && <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", color: "var(--text-secondary)" }}>{meta}</span>}
      <span style={{ flex: 1 }} />
      {actions}
    </div>
  );
}
