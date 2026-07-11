import React from "react";

const STAGES = [
  { key: "goal", label: "OrgGoal" },
  { key: "goal", label: "ProductGoal" },
  { key: "spec", label: "Spec" },
  { key: "feature", label: "FeatureGraph" },
  { key: "prd", label: "PRD" },
  { key: "ticket", label: "Tickets" },
];

export function PipelineStepper({ active = 0, compact, onSelect, style }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: compact ? "6px" : "8px", fontFamily: "var(--font-mono)", ...style }}>
      {STAGES.map((s, i) => (
        <React.Fragment key={i}>
          <button onClick={() => onSelect && onSelect(i)} style={{
            padding: compact ? "3px 8px" : "5px 12px",
            fontSize: compact ? "10px" : "var(--text-xs)", fontFamily: "inherit",
            fontWeight: i === active ? "var(--weight-bold)" : "var(--weight-regular)",
            color: i === active ? "var(--text-inverse)" : i < active ? "var(--stage-" + s.key + ")" : "var(--text-disabled)",
            background: i === active ? "var(--stage-" + s.key + ")" : "var(--surface-card)",
            border: "1px solid " + (i <= active ? "var(--stage-" + s.key + ")" : "var(--border-hairline)"),
            borderRadius: "var(--radius-sm)", cursor: onSelect ? "pointer" : "default",
            whiteSpace: "nowrap", transition: "all var(--dur-fast) var(--ease-out)",
          }}>{s.label}</button>
          {i < STAGES.length - 1 && <span style={{ color: "var(--ink-3)", fontSize: "11px" }}>→</span>}
        </React.Fragment>
      ))}
    </div>
  );
}
