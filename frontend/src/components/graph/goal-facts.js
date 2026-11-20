// Facts about goals that more than one screen shows, computed once here so
// the screens can't disagree. No DOM, no React: node --test imports it.
//
//   goals:      /api/goals rows ({ id, parent_goal_id, product_id, ... })
//   capsByGoal: { goalId: [{ id, name }] }, the goal's own capability links

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
