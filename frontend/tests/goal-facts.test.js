// Facts about goals that two screens show: computed once (goal-facts.js).

import { test } from "node:test";
import assert from "node:assert/strict";
import { deleteEffects, ownedTrees } from "../src/components/graph/goal-facts.js";

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

test("a product's Goals tab draws the tree it owns, whichever goal in it the product points at (A34)", () => {
  // Steps points at PG-61 and owns OG-60, PG-61 and PG-62: PG-62 is PG-61's sibling, not its child.
  const goals = [
    goal("OG-39", { product_id: "tm" }), goal("PG-40", { parent_goal_id: "OG-39", product_id: "tm" }),
    goal("OG-60", { product_id: "steps" }), goal("PG-61", { parent_goal_id: "OG-60", product_id: "steps" }),
    goal("PG-62", { parent_goal_id: "OG-60", product_id: "steps" }),
  ];
  const shape = (trees) => trees.map((t) => [t.goal.id, t.children.map((c) => `${c.goal.id}@${c.depth}`)]);
  assert.deepEqual(shape(ownedTrees("steps", goals)), [["OG-60", ["PG-61@1", "PG-62@1"]]]);
  assert.deepEqual(shape(ownedTrees("tm", goals)), [["OG-39", ["PG-40@1"]]]);
  assert.deepEqual(ownedTrees("strava", goals), []);
});

test("an owned goal under a goal the product doesn't own starts its own tree, deeper goals nest", () => {
  const goals = [
    goal("OG-1"), // shared: no product
    goal("PG-2", { parent_goal_id: "OG-1", product_id: "p" }),
    goal("PG-3", { parent_goal_id: "PG-2", product_id: "p" }),
    goal("PG-4", { parent_goal_id: "PG-3", product_id: "p" }),
  ];
  const [tree, ...rest] = ownedTrees("p", goals);
  assert.equal(rest.length, 0);
  assert.equal(tree.goal.id, "PG-2");
  assert.deepEqual(tree.children.map((c) => [c.goal.id, c.depth]), [["PG-3", 1], ["PG-4", 2]]);
});
