import React from "react";

export function Card({ title, meta, footer, padding = "var(--space-4)", interactive, children, style, ...rest }) {
  const [hover, setHover] = React.useState(false);
  return (
    <div {...rest}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        background: "var(--surface-card)",
        border: "1px solid " + (interactive && hover ? "var(--border-default)" : "var(--border-hairline)"),
        borderRadius: "var(--radius-md)",
        boxShadow: interactive && hover ? "var(--shadow-raised)" : "var(--shadow-card)",
        cursor: interactive ? "pointer" : "default",
        transition: "box-shadow var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out)",
        fontFamily: "var(--font-body)", ...style,
      }}>
      {(title || meta) && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", padding: padding, paddingBottom: 0 }}>
          {title && <div style={{ fontWeight: "var(--weight-semibold)", fontSize: "var(--text-md)", color: "var(--text-heading)" }}>{title}</div>}
          {meta && <div style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", color: "var(--text-secondary)" }}>{meta}</div>}
        </div>
      )}
      <div style={{ padding: padding }}>{children}</div>
      {footer && (
        <div style={{ borderTop: "1px solid var(--border-hairline)", padding: "var(--space-2) " + padding, display: "flex", alignItems: "center", gap: "8px" }}>{footer}</div>
      )}
    </div>
  );
}
