import React from "react";
import { StatusBadge } from "../../ds";

// A product serves one product goal (Product.goal_id), which may sit under an
// org goal. Same link Goals uses to list a goal's products.
export function ProductGoals({ product, goals, canWrite }) {
  const goal = goals.find((g) => g.id === product.goal_id);
  if (!goal) {
    return (
      <div style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)" }}>
        No goals for this product yet.
        {canWrite && <> Add one on <a href="/goals">Goals</a>, then choose it under Edit.</>}
      </div>
    );
  }
  const parent = goals.find((g) => g.id === goal.parent_goal_id);
  return (
    <div style={{ background: "var(--surface-card)", border: "1px solid var(--border-hairline)", borderRadius: "var(--radius-md)", padding: "12px 16px", display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-secondary)" }}>{goal.display_id}</span>
        <a href={`/goals?goal=${goal.id}`} style={{ flex: 1, minWidth: 0, fontSize: "var(--text-sm)", fontWeight: "var(--weight-semibold)", color: "var(--text-heading)" }}>{goal.title}</a>
        <StatusBadge status={goal.status} />
      </div>
      {goal.description && <div style={{ fontSize: "var(--text-sm)", color: "var(--text-body)" }}>{goal.description}</div>}
      {goal.success_criteria && <div style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>Done when: {goal.success_criteria}</div>}
      {parent && (
        <div style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>
          Part of <a href={`/goals?goal=${parent.id}`}>{parent.title}</a>
        </div>
      )}
    </div>
  );
}
