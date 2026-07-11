import React from "react";

const toastTones = {
  neutral: { border: "var(--border-default)", fg: "var(--text-heading)" },
  ok: { border: "var(--ok-fg)", fg: "var(--ok-fg)" },
  danger: { border: "var(--danger-fg)", fg: "var(--danger-fg)" },
};

export function Toast({ tone = "neutral", title, detail, onDismiss, style }) {
  const t = toastTones[tone] || toastTones.neutral;
  return (
    <div role="status" style={{
      display: "flex", alignItems: "flex-start", gap: "10px",
      width: "340px", padding: "12px 14px",
      background: "var(--surface-card)", border: "1px solid var(--border-hairline)",
      borderLeft: "3px solid " + t.border,
      borderRadius: "var(--radius-md)", boxShadow: "var(--shadow-raised)",
      fontFamily: "var(--font-body)", ...style,
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: "var(--text-sm)", fontWeight: "var(--weight-semibold)", color: t.fg }}>{title}</div>
        {detail && <div style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)", marginTop: "2px" }}>{detail}</div>}
      </div>
      {onDismiss && (
        <button aria-label="Dismiss" onClick={onDismiss} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-disabled)", padding: 0, display: "flex" }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M18 6L6 18M6 6l12 12" /></svg>
        </button>
      )}
    </div>
  );
}
