import React from "react";

export function IconButton({ label, size = "md", active, disabled, children, style, ...rest }) {
  const [hover, setHover] = React.useState(false);
  const dim = { sm: "28px", md: "34px", lg: "40px" }[size];
  return (
    <button {...rest} aria-label={label} title={label} disabled={disabled}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        width: dim, height: dim, display: "inline-flex", alignItems: "center", justifyContent: "center",
        background: active ? "var(--accent-wash)" : hover && !disabled ? "var(--surface-hover)" : "transparent",
        color: active ? "var(--text-accent)" : "var(--text-secondary)",
        border: "1px solid transparent", borderRadius: "var(--radius-sm)",
        cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1,
        transition: "background var(--dur-fast) var(--ease-out)", ...style,
      }}>
      {children}
    </button>
  );
}
