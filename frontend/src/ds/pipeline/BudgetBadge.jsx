import React from "react";

export function BudgetBadge({ budget = "M", style }) {
  const b = String(budget).toUpperCase();
  const k = { S: "s", M: "m", L: "l" }[b] || "m";
  return (
    <span title={{ S: "S: one file", M: "M: 2 to 4 files", L: "L: too big for one session, must be split" }[b]} style={{
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      minWidth: "20px", height: "20px", padding: "0 6px",
      borderRadius: "var(--radius-xs)",
      background: "var(--budget-" + k + "-bg)", color: "var(--budget-" + k + "-fg)",
      fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", fontWeight: "var(--weight-bold)", ...style,
    }}>{b}</span>
  );
}
