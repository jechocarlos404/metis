import React from "react";
import { StatusBadge } from "../../ds";
import { DONE_WHEN, count } from "../../lib/words.js";
import { productGoalTrees } from "../graph/goal-facts.js";

// A product's own goals are the ones the goals API says belong to it
// (product_id), drawn as the tree they form, whichever of them the product
// points at (Product.goal_id): Steps points at PG-61 and owns OG-60 with
// PG-61 and PG-62 under it, the same shape as the Goals list. Below, folded:
// other goals that motivate a capability one of this product's features
// realizes (direct links only: feature -> capability <- goal).
export function ProductGoals({ product, goals, features, capabilities, motivations, canWrite }) {
  const trees = productGoalTrees(product, goals); // the Share snapshot draws the same (A43)
  const own = new Set([product.goal_id, ...goals.filter((g) => g.product_id === product.id).map((g) => g.id)]);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {trees.length > 0 ? trees.map(({ goal, children }) => {
        const parent = goals.find((g) => g.id === goal.parent_goal_id);
        return (
          <div key={goal.id} style={{ background: "var(--surface-card)", border: "1px solid var(--border-hairline)", borderRadius: "var(--radius-md)", padding: "12px 16px", display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-secondary)" }}>{goal.display_id}</span>
              <a href={`/goals?goal=${goal.id}`} style={{ flex: "1 1 180px", minWidth: 0, fontSize: "var(--text-sm)", fontWeight: "var(--weight-semibold)", color: "var(--text-heading)" }}>{goal.title}</a>
              <StatusBadge status={goal.status} />
            </div>
            {goal.description && <div style={{ fontSize: "var(--text-sm)", color: "var(--text-body)" }}>{goal.description}</div>}
            {goal.success_criteria && <div style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>{DONE_WHEN}: {goal.success_criteria}</div>}
            {parent && (
              <div style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>
                Part of <a href={`/goals?goal=${parent.id}`}>{parent.title}</a>
              </div>
            )}
            {children.length > 0 && (
              <div style={{ borderTop: "1px solid var(--border-hairline)", marginTop: 4, paddingTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
                {children.map(({ goal: g, depth }) => <GoalRow key={g.id} goal={g} indent={depth - 1} />)}
              </div>
            )}
          </div>
        );
      }) : (
        <div style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)" }}>
          {product.external ? "Someone else's product: metis doesn't record its goals." : <>
            No goals for this product yet.
            {canWrite && <> Add one on <a href="/goals">Goals</a>, then choose it under Edit.</>}
          </>}
        </div>
      )}
      <GoalsBehindCapabilities own={own} goals={goals} features={features} capabilities={capabilities} motivations={motivations} />
    </div>
  );
}

function GoalRow({ goal: g, indent = 0, children }) {
  return (
    // Wraps the status under the title at phone width rather than squeezing it to a word per line.
    <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 10px", alignItems: "baseline", fontSize: "var(--text-sm)", paddingLeft: indent * 16 }}>
      <span style={{ flex: "none", width: "3.5rem", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-secondary)" }}>{g.display_id}</span>
      <span style={{ flex: "1 1 180px", minWidth: 0 }}>
        <a href={`/goals?goal=${g.id}`}>{g.title}</a>
        {children}
      </span>
      <StatusBadge status={g.status} />
    </div>
  );
}

function GoalsBehindCapabilities({ own, goals, features, capabilities, motivations }) {
  if (!features || !motivations) return null;
  const used = new Set(features.flatMap((f) => f.capability_ids ?? []));
  const capById = new Map(capabilities.map((c) => [c.id, c]));
  const byGoal = new Map();
  for (const m of motivations) {
    const cap = capById.get(m.capability_id);
    if (!cap || !used.has(cap.id) || own.has(m.goal_id)) continue;
    if (!byGoal.has(m.goal_id)) byGoal.set(m.goal_id, []);
    byGoal.get(m.goal_id).push(cap);
  }
  const rows = goals.filter((g) => byGoal.has(g.id));
  if (rows.length === 0) return null;
  return (
    <details style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {/* Closed by default: shared capabilities pull in other products' goals, so this list runs long. */}
      <summary style={{ cursor: "pointer", fontSize: "var(--text-sm)", fontWeight: "var(--weight-semibold)", color: "var(--text-heading)" }}>
        {count(rows.length, "other goal")} behind capabilities this product uses
      </summary>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
        {rows.map((g) => (
          <GoalRow key={g.id} goal={g}>
            <span style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>
              {" "}through{" "}
              {byGoal.get(g.id).map((c, i) => (
                <React.Fragment key={c.id}>
                  {i > 0 && ", "}
                  <a href={`/capabilities/${c.slug}`}>{c.name}</a>
                </React.Fragment>
              ))}
            </span>
          </GoalRow>
        ))}
      </div>
    </details>
  );
}
