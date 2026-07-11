import React from "react";

const typeColors = {
  capability: "var(--stage-feature)",
  integration: "var(--stage-spec)",
  ui: "var(--stage-goal)",
  infra: "var(--stage-ticket)",
};

export function Tag({ type, onRemove, children, style }) {
  const dot = type ? typeColors[type] : null;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: "6px",
      padding: "3px 8px", borderRadius: "var(--radius-xs)",
      background: "var(--surface-card)", border: "1px solid var(--border-default)",
      color: "var(--text-body)", fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)",
      whiteSpace: "nowrap", ...style,
    }}>
      {dot && <span style={{ width: "7px", height: "7px", borderRadius: "50%", background: dot, flex: "none" }} />}
      {children}
      {onRemove && (
        <button aria-label="Remove" onClick={onRemove} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "var(--text-disabled)", display: "flex" }}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M18 6L6 18M6 6l12 12" /></svg>
        </button>
      )}
    </span>
  );
}
