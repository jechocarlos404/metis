import React from "react";

// Wraps instead of squeezing: on a narrow screen the actions move to their own
// line, still at the right, at their own width, so a picker keeps its value
// visible and a button isn't clipped.
export function PageHeader({ title, meta, actions }) {
  return (
    <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "8px 12px", padding: "14px 24px", borderBottom: "1px solid var(--border-hairline)", background: "var(--surface-card)", flex: "none" }}>
      <h1 style={{ fontSize: "var(--text-lg)", fontWeight: "var(--weight-semibold)", minWidth: 0, overflowWrap: "anywhere" }}>{title}</h1>
      {meta && <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", color: "var(--text-secondary)" }}>{meta}</span>}
      {actions && (
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", justifyContent: "flex-end", flexWrap: "wrap", gap: "8px 12px", minWidth: 0 }}>
          {actions}
        </div>
      )}
    </div>
  );
}
