// Facts about goals that more than one screen shows, computed once here so
// the screens can't disagree. No DOM, no React: node --test imports it.
//
//   goals:      /api/goals rows ({ id, parent_goal_id, product_id, ... })
//   capsByGoal: { goalId: [{ id, name }] }, the goal's own capability links

import { count } from "../../lib/words.js";

/**
 * A goal's capability count, worded the same on the Goals list and in the
 * network panel. A goal with product goals under it also counts the distinct
 * capabilities across them, when that is more than its own links.
 */
export function capabilityCount(goal, goals, capsByGoal) {
  const own = capsByGoal[goal.id] ?? [];
  const children = goals.filter((g) => g.parent_goal_id === goal.id);
  const linked = count(own.length, "capability", "capabilities");
  if (children.length === 0) return { direct: own.length, total: own.length, text: `${linked} linked` };
  const ids = new Set(own.map((c) => c.id));
  for (const g of children) for (const c of capsByGoal[g.id] ?? []) ids.add(c.id);
  const more = ids.size > own.length ? ` · ${ids.size} with its product goals` : "";
  return { direct: own.length, total: ids.size, text: `${linked} linked directly${more}` };
}

/**
 * What deleting a goal does to other rows (the goals table's foreign keys):
 * its capability links go (motivations, ON DELETE CASCADE), products that
 * have it as their goal are left with none and the goals under it lose their
 * parent (both ON DELETE SET NULL). The capabilities, products and goals
 * themselves stay.
 */
export function deleteEffects(goal, goals, capsByGoal, products) {
  return {
    capabilities: [...(capsByGoal[goal.id] ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
    products: products.filter((p) => p.goal_id === goal.id),
    children: goals.filter((g) => g.parent_goal_id === goal.id),
  };
}

/**
 * The goals a product owns (the goals API's product_id), as the tree they
 * form: each owned goal whose parent it doesn't own starts a tree, and its
 * owned goals follow it, depth first, in the API's order.
 * Returns [{ goal, children: [{ goal, depth }] }], depth 1 directly under it.
 */
export function ownedTrees(productId, goals) {
  const own = goals.filter((g) => g.product_id === productId);
  const ids = new Set(own.map((g) => g.id));
  const seen = new Set();
  const below = (id, depth, out) => {
    for (const g of own) {
      if (g.parent_goal_id !== id || seen.has(g.id)) continue;
      seen.add(g.id);
      out.push({ goal: g, depth });
      below(g.id, depth + 1, out);
    }
    return out;
  };
  return own.filter((g) => !ids.has(g.parent_goal_id)).map((root) => {
    seen.add(root.id);
    return { goal: root, children: below(root.id, 1, []) };
  });
}
