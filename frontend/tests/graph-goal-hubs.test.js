// Group by goal: a feature's goals are the ones its product owns (product_id
// on /api/goals). Another product's goal reaching it through a shared
// capability is reuse, not why it was built.

import { test } from "node:test";
import assert from "node:assert/strict";
import { NODE_H, NODE_W, READABLE_SCALE, buildHubGraph, goalHubs, openTransform, readableUnion } from "../src/components/graph/graph-data.js";

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

// Hanko's shape (B35): a big org goal, a small product goal sharing a few of
// its features, and 20 features linked to none of them. "Linked to none"
// shares no feature with a goal, so nothing pulls it near one; it used to
// land beside the biggest group and open out of view at every width.
test("a grouped graph opens with its biggest hub and the one sharing nothing in view, at 1440, 768 and 390 (B35)", () => {
  const ids = (from, n) => Array.from({ length: n }, (_, i) => `f${from + i}`);
  const features = [...ids(0, 26), ...ids(26, 3), ...ids(29, 2), ...ids(31, 20)].map((id) => ({ id, name: id }));
  const byFeature = new Map(features.map(({ id }) => {
    const i = Number(id.slice(1));
    return [id, i < 26 ? ["goal:og"] : i < 29 ? ["goal:og", "goal:pg"] : i < 31 ? ["goal:pg"] : []];
  }));
  const graph = buildHubGraph(features, {
    hubs: [{ id: "goal:og", name: "Org goal" }, { id: "goal:pg", name: "Product goal" }],
    byFeature,
    empty: { id: "goal:none", name: "Linked to none of this product's goals" },
  });
  const box = (n, m) => {
    const hw = (n.width ?? NODE_W) / 2 + m;
    const hh = (n.height ?? NODE_H) / 2 + m;
    return { x0: n.anchorX - hw, y0: n.anchorY - hh, x1: n.anchorX + hw, y1: n.anchorY + hh };
  };
  const all = graph.nodes.map((n) => box(n, 40)).reduce((a, b) => ({
    x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1),
  }));
  const hubs = graph.nodes.filter((n) => n.hub).sort((a, b) => b.count - a.count);
  assert.deepEqual(hubs.map((n) => [n.id, n.count]), [["goal:og", 29], ["goal:none", 20], ["goal:pg", 5]]);
  // The Features graph's canvas at each width, as measured, and its control strip.
  for (const [w, h] of [[862, 874], [350, 803], [292, 585]]) {
    const inset = { top: 46 };
    const t = openTransform(all, w, h, inset, 2.5, readableUnion(hubs.map((n) => box(n, 8)), w, h, inset), true);
    assert.ok(t.k >= READABLE_SCALE, `${w}: names readable`);
    for (const id of ["goal:og", "goal:none"]) {
      const b = box(hubs.find((n) => n.id === id), 0);
      assert.ok(b.x0 * t.k + t.x >= 0 && b.x1 * t.k + t.x <= w && b.y0 * t.k + t.y >= 0 && b.y1 * t.k + t.y <= h, `${w}: ${id} in view`);
    }
  }
});
