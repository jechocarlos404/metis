import React from "react";

const tones = {
  neutral: { bg: "var(--surface-inset)", fg: "var(--text-secondary)" },
  accent: { bg: "var(--accent-wash)", fg: "var(--text-accent)" },
  ok: { bg: "var(--ok-bg)", fg: "var(--ok-fg)" },
  warn: { bg: "var(--warn-bg)", fg: "var(--warn-fg)" },
  danger: { bg: "var(--danger-bg)", fg: "var(--danger-fg)" },
};

export function Badge({ tone = "neutral", children, style }) {
  const t = tones[tone] || tones.neutral;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: "4px",
      padding: "2px 8px", borderRadius: "var(--radius-pill)",
      background: t.bg, color: t.fg,
      fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", fontWeight: "var(--weight-semibold)",
      lineHeight: "1.6", whiteSpace: "nowrap", ...style,
    }}>{children}</span>
  );
}
