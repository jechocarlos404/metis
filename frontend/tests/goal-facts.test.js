// Facts about goals that two screens show: computed once (goal-facts.js).

import { test } from "node:test";
import assert from "node:assert/strict";
import { deleteEffects } from "../src/components/graph/goal-facts.js";

const goal = (id, extra = {}) => ({ id, display_id: id, title: `${id} title`, parent_goal_id: null, product_id: null, ...extra });

test("a goal's delete names every capability link, product and child goal it removes or changes (B37)", () => {
  const goals = [goal("OG-1"), goal("PG-2", { parent_goal_id: "OG-1" }), goal("PG-3", { parent_goal_id: "OG-1" }), goal("PG-4")];
  const capsByGoal = {
    "OG-1": [{ id: "c2", name: "QA Probe" }, { id: "c1", name: "Knowledge Graph" }],
    "PG-2": [{ id: "c3", name: "Search" }],
  };
  const products = [{ id: "p1", name: "Taskmaster007", goal_id: "OG-1" }, { id: "p2", name: "Steps", goal_id: "PG-2" }];
  const e = deleteEffects(goals[0], goals, capsByGoal, products);
  assert.deepEqual(e.capabilities.map((c) => c.name), ["Knowledge Graph", "QA Probe"]);
  assert.deepEqual(e.products.map((p) => p.name), ["Taskmaster007"]);
  assert.deepEqual(e.children.map((g) => g.id), ["PG-2", "PG-3"]);
  // A child's own links are not the deleted goal's: they stay.
  assert.ok(!e.capabilities.some((c) => c.name === "Search"));
});

test("a goal nothing links to deletes alone", () => {
  const goals = [goal("PG-4")];
  assert.deepEqual(deleteEffects(goals[0], goals, {}, []), { capabilities: [], products: [], children: [] });
});
