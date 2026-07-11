import React from "react";

export function Tooltip({ label, children, style }) {
  const [show, setShow] = React.useState(false);
  return (
    <span style={{ position: "relative", display: "inline-flex", ...style }}
      onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}>
      {children}
      {show && (
        <span role="tooltip" style={{
          position: "absolute", bottom: "calc(100% + 6px)", left: "50%", transform: "translateX(-50%)",
          background: "var(--surface-inverse)", color: "var(--text-inverse)",
          fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)",
          padding: "4px 8px", borderRadius: "var(--radius-xs)", whiteSpace: "nowrap", zIndex: 50,
        }}>{label}</span>
      )}
    </span>
  );
}
