import React from "react";

export function PageHeader({ title, meta, actions }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 24px", borderBottom: "1px solid var(--border-hairline)", background: "var(--surface-card)", flex: "none" }}>
      <h2 style={{ fontSize: "var(--text-lg)", fontWeight: "var(--weight-semibold)" }}>{title}</h2>
      {meta && <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", color: "var(--text-secondary)" }}>{meta}</span>}
      <span style={{ flex: 1 }} />
      {actions}
    </div>
  );
}
