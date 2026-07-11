import React from "react";

export function Input({ label, hint, error, mono, style, inputStyle, ...rest }) {
  const [focus, setFocus] = React.useState(false);
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontFamily: "var(--font-body)", ...style }}>
      {label && <span style={{ fontSize: "var(--text-xs)", fontWeight: "var(--weight-medium)", color: "var(--text-heading)" }}>{label}</span>}
      <input {...rest}
        onFocus={(e) => { setFocus(true); rest.onFocus && rest.onFocus(e); }}
        onBlur={(e) => { setFocus(false); rest.onBlur && rest.onBlur(e); }}
        style={{
          height: "34px", padding: "0 10px", fontSize: "var(--text-sm)",
          fontFamily: mono ? "var(--font-mono)" : "var(--font-body)",
          color: "var(--text-heading)", background: "var(--surface-card)",
          border: "1px solid " + (error ? "var(--danger-fg)" : focus ? "var(--border-focus)" : "var(--border-default)"),
          borderRadius: "var(--radius-sm)", outline: "none",
          boxShadow: focus ? "var(--ring-focus)" : "none",
          transition: "border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out)",
          ...inputStyle,
        }} />
      {(error || hint) && (
        <span style={{ fontSize: "var(--text-xs)", color: error ? "var(--danger-fg)" : "var(--text-secondary)" }}>{error || hint}</span>
      )}
    </label>
  );
}
