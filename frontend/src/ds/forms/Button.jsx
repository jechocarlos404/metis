import React from "react";

const heights = { sm: "28px", md: "34px", lg: "40px" };
const pads = { sm: "0 10px", md: "0 14px", lg: "0 18px" };
const fonts = { sm: "var(--text-xs)", md: "var(--text-sm)", lg: "var(--text-md)" };

export function Button({ variant = "primary", size = "md", disabled, children, style, ...rest }) {
  const [hover, setHover] = React.useState(false);
  const base = {
    display: "inline-flex", alignItems: "center", justifyContent: "center", gap: "6px",
    height: heights[size], padding: pads[size], fontFamily: "var(--font-body)",
    fontSize: fonts[size], fontWeight: "var(--weight-medium)",
    borderRadius: "var(--radius-sm)", cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.5 : 1, transition: "background var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out)",
    border: "1px solid transparent", whiteSpace: "nowrap",
  };
  const variants = {
    primary: { background: hover && !disabled ? "var(--ink-7)" : "var(--surface-inverse)", color: "var(--text-inverse)" },
    accent: { background: hover && !disabled ? "var(--accent-hover)" : "var(--accent)", color: "var(--text-inverse)" },
    secondary: { background: hover && !disabled ? "var(--surface-hover)" : "var(--surface-card)", color: "var(--text-heading)", borderColor: "var(--border-default)" },
    ghost: { background: hover && !disabled ? "var(--surface-hover)" : "transparent", color: "var(--text-body)" },
    danger: { background: hover && !disabled ? "oklch(0.48 0.17 25)" : "var(--danger-solid)", color: "var(--text-inverse)" },
  };
  return (
    <button {...rest} disabled={disabled}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ ...base, ...variants[variant], ...style }}>
      {children}
    </button>
  );
}
