import React from "react";

export function Switch({ label, checked, onChange, disabled, style }) {
  return (
    <label style={{ display: "inline-flex", alignItems: "center", gap: "8px", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1, fontFamily: "var(--font-body)", fontSize: "var(--text-sm)", color: "var(--text-body)", ...style }}>
      <span style={{ position: "relative", width: "32px", height: "18px", flex: "none" }}>
        <input type="checkbox" role="switch" checked={!!checked} disabled={disabled}
          onChange={(e) => onChange && onChange(e.target.checked)}
          style={{ position: "absolute", inset: 0, opacity: 0, cursor: "inherit" }} />
        <span style={{
          position: "absolute", inset: 0, borderRadius: "var(--radius-pill)",
          background: checked ? "var(--accent)" : "var(--ink-3)",
          transition: "background var(--dur-fast) var(--ease-out)",
        }} />
        <span style={{
          position: "absolute", top: "2px", left: checked ? "16px" : "2px",
          width: "14px", height: "14px", borderRadius: "50%", background: "white",
          boxShadow: "0 1px 2px oklch(0.2 0.01 90 / 0.2)",
          transition: "left var(--dur-fast) var(--ease-out)",
        }} />
      </span>
      {label}
    </label>
  );
}
