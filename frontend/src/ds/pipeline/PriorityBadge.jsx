import React from "react";

export function PriorityBadge({ priority = 3, rationale, style }) {
  const p = Math.min(5, Math.max(1, priority));
  return (
    <span title={rationale} style={{
      display: "inline-flex", alignItems: "center", gap: "5px",
      fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", fontWeight: "var(--weight-semibold)",
      color: "var(--priority-" + p + ")", whiteSpace: "nowrap", ...style,
    }}>
      <span style={{ display: "inline-flex", gap: "2px" }}>
        {[1, 2, 3, 4, 5].map((i) => (
          <span key={i} style={{
            width: "4px", height: "10px", borderRadius: "1px",
            // Empty bars use the control border: 3:1 on white and on a selected row (B31).
            background: i <= 6 - p ? "var(--priority-" + p + ")" : "var(--border-control)",
          }} />
        ))}
      </span>
      P{p}
    </span>
  );
}
