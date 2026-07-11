import React from "react";

export function Select({ label, options = [], style, ...rest }) {
  const [focus, setFocus] = React.useState(false);
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontFamily: "var(--font-body)", ...style }}>
      {label && <span style={{ fontSize: "var(--text-xs)", fontWeight: "var(--weight-medium)", color: "var(--text-heading)" }}>{label}</span>}
      <div style={{ position: "relative", display: "flex" }}>
        <select {...rest}
          onFocus={(e) => { setFocus(true); rest.onFocus && rest.onFocus(e); }}
          onBlur={(e) => { setFocus(false); rest.onBlur && rest.onBlur(e); }}
          style={{
            appearance: "none", WebkitAppearance: "none", width: "100%",
            height: "34px", padding: "0 28px 0 10px", fontSize: "var(--text-sm)",
            fontFamily: "var(--font-body)", color: "var(--text-heading)",
            background: "var(--surface-card)",
            border: "1px solid " + (focus ? "var(--border-focus)" : "var(--border-default)"),
            borderRadius: "var(--radius-sm)", outline: "none", cursor: "pointer",
            boxShadow: focus ? "var(--ring-focus)" : "none",
          }}>
          {options.map((o) => {
            const opt = typeof o === "string" ? { value: o, label: o } : o;
            return <option key={opt.value} value={opt.value}>{opt.label}</option>;
          })}
        </select>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
          style={{ position: "absolute", right: "10px", top: "50%", transform: "translateY(-50%)", pointerEvents: "none", color: "var(--text-secondary)" }}>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </div>
    </label>
  );
}
