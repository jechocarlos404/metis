import React from "react";

export function Dialog({ open, title, onClose, footer, width = "480px", children }) {
  if (!open) return null;
  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "oklch(0.2 0.01 90 / 0.4)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, padding: "24px",
    }}>
      <div role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()} style={{
        width, maxWidth: "100%", maxHeight: "85vh", overflow: "auto",
        background: "var(--surface-card)", borderRadius: "var(--radius-lg)",
        boxShadow: "var(--shadow-overlay)", fontFamily: "var(--font-body)",
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "var(--space-4) var(--space-5)", borderBottom: "1px solid var(--border-hairline)" }}>
          <div style={{ fontWeight: "var(--weight-semibold)", fontSize: "var(--text-lg)", color: "var(--text-heading)" }}>{title}</div>
          <button aria-label="Close" onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-secondary)", padding: "4px", display: "flex" }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
          </button>
        </div>
        <div style={{ padding: "var(--space-5)" }}>{children}</div>
        {footer && <div style={{ padding: "var(--space-4) var(--space-5)", borderTop: "1px solid var(--border-hairline)", display: "flex", justifyContent: "flex-end", gap: "8px" }}>{footer}</div>}
      </div>
    </div>
  );
}
