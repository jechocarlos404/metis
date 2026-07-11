import React from "react";

export function Radio({ label, checked, onChange, name, disabled, style }) {
  return (
    <label style={{ display: "inline-flex", alignItems: "center", gap: "8px", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1, fontFamily: "var(--font-body)", fontSize: "var(--text-sm)", color: "var(--text-body)", ...style }}>
      <span style={{ position: "relative", width: "16px", height: "16px", flex: "none" }}>
        <input type="radio" name={name} checked={!!checked} disabled={disabled}
          onChange={() => onChange && onChange()}
          style={{ position: "absolute", inset: 0, opacity: 0, cursor: "inherit" }} />
        <span style={{
          position: "absolute", inset: 0, borderRadius: "50%",
          border: checked ? "5px solid var(--accent)" : "1px solid var(--border-default)",
          background: "var(--surface-card)", transition: "border var(--dur-fast) var(--ease-out)",
        }} />
      </span>
      {label}
    </label>
  );
}
