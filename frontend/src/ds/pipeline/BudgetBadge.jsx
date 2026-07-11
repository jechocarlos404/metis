import React from "react";

export function BudgetBadge({ budget = "M", style }) {
  const b = String(budget).toUpperCase();
  const k = { S: "s", M: "m", L: "l" }[b] || "m";
  return (
    <span title={b === "L" ? "L tickets must be split before the PRD is ready" : "context_budget: " + b} style={{
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      minWidth: "20px", height: "20px", padding: "0 6px",
      borderRadius: "var(--radius-xs)",
      background: "var(--budget-" + k + "-bg)", color: "var(--budget-" + k + "-fg)",
      fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", fontWeight: "var(--weight-bold)", ...style,
    }}>{b}</span>
  );
}
