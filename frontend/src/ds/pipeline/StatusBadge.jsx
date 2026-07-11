import React from "react";

const statusTones = {
  pending: { bg: "var(--surface-inset)", fg: "var(--text-secondary)" },
  in_progress: { bg: "var(--warn-bg)", fg: "var(--warn-fg)" },
  done: { bg: "var(--ok-bg)", fg: "var(--ok-fg)" },
  draft: { bg: "var(--accent-wash)", fg: "var(--text-accent)" },
  approved: { bg: "var(--ok-bg)", fg: "var(--ok-fg)" },
  blocked: { bg: "var(--danger-bg)", fg: "var(--danger-fg)" },
};

export function StatusBadge({ status = "pending", style }) {
  const t = statusTones[status] || statusTones.pending;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: "5px",
      padding: "2px 8px", borderRadius: "var(--radius-pill)",
      background: t.bg, color: t.fg,
      fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", fontWeight: "var(--weight-semibold)",
      whiteSpace: "nowrap", ...style,
    }}>
      <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: "currentColor" }} />
      {status}
    </span>
  );
}
