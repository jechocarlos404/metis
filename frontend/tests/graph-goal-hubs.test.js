// Group by goal: a feature's goals are the ones its product owns (product_id
// on /api/goals). Another product's goal reaching it through a shared
// capability is reuse, not why it was built.

import { test } from "node:test";
import assert from "node:assert/strict";
import { goalHubs } from "../src/components/graph/graph-data.js";

const goals = [
  { id: "og-ours", goal_type: "org", parent_goal_id: null, title: "Ours", product_id: "p1" },
  { id: "pg-ours", goal_type: "product", parent_goal_id: "og-ours", title: "Ours, v1", product_id: "p1" },
  { id: "pg-theirs", goal_type: "product", parent_goal_id: "og-ours", title: "Theirs, under our org goal", product_id: "p2" },
  { id: "og-shared", goal_type: "org", parent_goal_id: null, title: "Shared by two products", product_id: null },
];
const motivations = [
  { capability_id: "c1", goal_id: "pg-ours" },
  { capability_id: "c1", goal_id: "pg-theirs" },
  { capability_id: "c1", goal_id: "og-shared" },
  { capability_id: "c2", goal_id: "pg-theirs" },
];
const features = [
  { id: "f1", capability_ids: ["c1"] },
  { id: "f2", capability_ids: ["c2"] },
];

test("only the product's own goals are hubs, whatever top goal another product's goal sits under", () => {
  const spec = goalHubs(features, motivations, goals, "p1");
  assert.deepEqual(spec.hubs.map((h) => h.id), ["goal:pg-ours"]);
  assert.deepEqual(spec.byFeature.get("f1"), ["goal:pg-ours"]);
  assert.deepEqual(spec.byFeature.get("f2"), []);
  // Its product has goals; this feature just links to none of them (B34).
  assert.equal(spec.empty.name, "Linked to none of this product's goals");
});

test("with no product every goal counts", () => {
  const spec = goalHubs(features, motivations, goals, null);
  assert.deepEqual(spec.byFeature.get("f1").sort(), ["goal:og-shared", "goal:pg-ours", "goal:pg-theirs"]);
});
