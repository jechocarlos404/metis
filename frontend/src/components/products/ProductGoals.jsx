import React from "react";
import { StatusBadge } from "../../ds";

// A product serves one product goal (Product.goal_id), which may sit under an
// org goal. Same link Goals uses to list a goal's products.
// Below it: goals that motivate a capability one of this product's features
// realizes (direct links only: feature -> capability <- goal).
export function ProductGoals({ product, goals, features, capabilities, motivations, canWrite }) {
  const goal = goals.find((g) => g.id === product.goal_id);
  const parent = goal && goals.find((g) => g.id === goal.parent_goal_id);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {goal ? (
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
      ) : (
        <div style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)" }}>
          No goals for this product yet.
          {canWrite && <> Add one on <a href="/goals">Goals</a>, then choose it under Edit.</>}
        </div>
      )}
      <GoalsBehindCapabilities product={product} goals={goals} features={features} capabilities={capabilities} motivations={motivations} />
    </div>
  );
}

function GoalsBehindCapabilities({ product, goals, features, capabilities, motivations }) {
  if (!features || !motivations) return null;
  const used = new Set(features.flatMap((f) => f.capability_ids ?? []));
  const capById = new Map(capabilities.map((c) => [c.id, c]));
  const byGoal = new Map();
  for (const m of motivations) {
    const cap = capById.get(m.capability_id);
    if (!cap || !used.has(cap.id) || m.goal_id === product.goal_id) continue;
    if (!byGoal.has(m.goal_id)) byGoal.set(m.goal_id, []);
    byGoal.get(m.goal_id).push(cap);
  }
  const rows = goals.filter((g) => byGoal.has(g.id));
  if (rows.length === 0) return null;
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ fontSize: "var(--text-sm)", fontWeight: "var(--weight-semibold)", color: "var(--text-heading)" }}>
        Goals behind capabilities this product uses
      </div>
      {rows.map((g) => (
        <div key={g.id} style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", fontSize: "var(--text-sm)" }}>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-secondary)" }}>{g.display_id}</span>
          <a href={`/goals?goal=${g.id}`}>{g.title}</a>
          <span style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>
            through{" "}
            {byGoal.get(g.id).map((c, i) => (
              <React.Fragment key={c.id}>
                {i > 0 && ", "}
                <a href={`/capabilities/${c.slug}`}>{c.name}</a>
              </React.Fragment>
            ))}
          </span>
          <span style={{ flex: 1 }} />
          <StatusBadge status={g.status} />
        </div>
      ))}
    </section>
  );
}
