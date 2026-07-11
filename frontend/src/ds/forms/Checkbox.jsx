import React from "react";

export function Checkbox({ label, checked, onChange, disabled, style }) {
  return (
    <label style={{ display: "inline-flex", alignItems: "center", gap: "8px", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1, fontFamily: "var(--font-body)", fontSize: "var(--text-sm)", color: "var(--text-body)", ...style }}>
      <span style={{ position: "relative", width: "16px", height: "16px", flex: "none" }}>
        <input type="checkbox" checked={!!checked} disabled={disabled}
          onChange={(e) => onChange && onChange(e.target.checked)}
          style={{ position: "absolute", inset: 0, opacity: 0, cursor: "inherit" }} />
        <span style={{
          position: "absolute", inset: 0, borderRadius: "var(--radius-xs)",
          border: "1px solid " + (checked ? "var(--accent)" : "var(--border-default)"),
          background: checked ? "var(--accent)" : "var(--surface-card)",
          display: "flex", alignItems: "center", justifyContent: "center",
          transition: "background var(--dur-fast) var(--ease-out)",
        }}>
          {checked && <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3.5"><path d="M4 12.5l5 5L20 6.5" /></svg>}
        </span>
      </span>
      {label}
    </label>
  );
}
