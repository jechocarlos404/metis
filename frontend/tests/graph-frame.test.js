// Graph framing: names are never drawn under 11px, Fit shows every node, and
// a graph opens where its names can be read without zooming.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GOAL_LINES, LABEL_PX, READABLE_SCALE, centreTransform, fitTransform, openTransform, pickTransform, readableUnion, revealTransform, wrapLabel,
} from "../src/components/graph/graph-data.js";

const screen = (t, x) => x * t.k + t.x;
const screenY = (t, y) => y * t.k + t.y;

test("a name at the readable scale is at least 11px, and the scale is not stricter than it needs to be", () => {
  assert.ok(LABEL_PX * READABLE_SCALE >= 11);
  assert.ok(LABEL_PX * (READABLE_SCALE - 0.01) < 11);
});

test("Fit shows every node, however far out that takes it", () => {
  const b = { x0: -100, y0: -50, x1: 4900, y1: 2950 }; // 5000 x 3000, far beyond the old 0.2 floor in 300px
  const t = fitTransform(b, 300, 400, 0);
  assert.ok(t.k < 0.2);
  assert.ok(screen(t, b.x0) >= -0.01 && screen(t, b.x1) <= 300.01);
  assert.ok(screenY(t, b.y0) >= -0.01 && screenY(t, b.y1) <= 400.01);
});

test("Fit keeps the inset clear on the left", () => {
  const b = { x0: 0, y0: 0, x1: 1000, y1: 500 };
  const t = fitTransform(b, 800, 600, 200);
  assert.ok(screen(t, b.x0) >= 199.99 && screen(t, b.x1) <= 800.01);
});

test("a graph that fits at a readable scale opens fitted", () => {
  const b = { x0: 0, y0: 0, x1: 600, y1: 400 };
  assert.deepEqual(openTransform(b, 900, 800, 0), fitTransform(b, 900, 800, 0));
});

test("a graph too big to read when fitted opens at full size from its top-left corner", () => {
  const b = { x0: -300, y0: -200, x1: 3000, y1: 2000 };
  const t = openTransform(b, 290, 420, 0);
  assert.equal(t.k, 1);
  assert.equal(screen(t, b.x0), 0);
  assert.equal(screenY(t, b.y0), 0);
  // With a key open on the left, the drawing starts after it.
  assert.equal(screen(openTransform(b, 900, 800, 160), b.x0), 160);
});

test("the selected card opens in view, as the first column, with nothing half cut at its left", () => {
  const b = { x0: 0, y0: 0, x1: 3000, y1: 2000 };
  const inView = { x0: 40, y0: 40, x1: 200, y1: 110 };
  assert.deepEqual(openTransform(b, 600, 400, 0, 2.5, inView), openTransform(b, 600, 400, 0));
  const far = { x0: 1000, y0: 1500, x1: 1160, y1: 1570 };
  const t = openTransform(b, 600, 400, 0, 2.5, far);
  assert.equal(screen(t, far.x0), 0);
  assert.ok(screenY(t, far.y0) >= 0 && screenY(t, far.y1) <= 400);
  // The card one cell to its left (16 units apart) is wholly out of view.
  assert.ok(screen(t, far.x0 - 16) <= 0);
});

test("reveal leaves a card in view alone and brings one out of view to the left edge", () => {
  const t = { k: 0.5, x: 0, y: 0 };
  assert.equal(revealTransform(t, { x0: 100, y0: 100, x1: 250, y1: 160 }, 400, 300), null);
  const moved = revealTransform(t, { x0: 2000, y0: 100, x1: 2150, y1: 160 }, 400, 300, 40);
  assert.equal(moved.k, 0.5);
  assert.equal(moved.y, 0); // already in view down the canvas: only moves across
  assert.equal(screen(moved, 2000), 40);
  const below = revealTransform(t, { x0: 100, y0: 3000, x1: 250, y1: 3060 }, 400, 300);
  assert.equal(below.x, 0);
  assert.equal(screenY(below, 3030), 150);
});

const inside = (t, b, x0, y0, x1, y1) =>
  screen(t, b.x0) >= x0 - 0.01 && screen(t, b.x1) <= x1 + 0.01 && screenY(t, b.y0) >= y0 - 0.01 && screenY(t, b.y1) <= y1 + 0.01;

test("Fit keeps every node out of the strip the controls sit in, on any side (C29, C12)", () => {
  // At 768 the folded key covered the top-left goal: the key's strip is kept clear now.
  const b = { x0: 0, y0: 0, x1: 2000, y1: 1400 };
  const t = fitTransform(b, 670, 418, { top: 46 });
  assert.ok(inside(t, b, 0, 46, 670, 418));
  const all = fitTransform(b, 600, 500, { top: 40, right: 30, bottom: 20, left: 10 });
  assert.ok(inside(all, b, 10, 40, 570, 480));
});

test("a goal picked from the list is centred in the frame the controls leave (A10)", () => {
  const box = { x0: 900, y0: 400, x1: 1048, y1: 472 };
  const t = centreTransform(box, 1, 670, 418, { top: 46 });
  assert.equal(t.k, 1);
  assert.equal((screen(t, box.x0) + screen(t, box.x1)) / 2, 335);
  assert.equal((screenY(t, box.y0) + screenY(t, box.y1)) / 2, 46 + (418 - 46) / 2);
});

test("a selected goal opens centred at full size when the whole network can't be read", () => {
  const b = { x0: 0, y0: 0, x1: 3000, y1: 2000 };
  const goal = { x0: 2000, y0: 1500, x1: 2148, y1: 1572 };
  const t = openTransform(b, 600, 400, { top: 40 }, 2.5, goal, true);
  assert.equal(t.k, 1);
  assert.equal((screen(t, goal.x0) + screen(t, goal.x1)) / 2, 300);
  assert.equal((screenY(t, goal.y0) + screenY(t, goal.y1)) / 2, 220);
});

test("a grouped graph opens on as many of its hubs as show whole and readable (B35)", () => {
  const b = { x0: -1000, y0: -600, x1: 1000, y1: 600 };
  // Most used first; the two on the left sit close, the first far right.
  const hubs = [{ x0: 400, y0: 0, x1: 548, y1: 40 }, { x0: -10, y0: -200, x1: 138, y1: -160 }, { x0: -10, y0: 0, x1: 138, y1: 40 }];
  // 300 px wide: no two across 400 units, so the pair that does fit wins.
  const narrow = readableUnion(hubs, 300, 600);
  assert.deepEqual(narrow, { x0: -10, y0: -200, x1: 138, y1: 40 });
  const t = openTransform(b, 300, 600, 0, 2.5, narrow, true);
  assert.ok(t.k >= READABLE_SCALE && t.k <= 1);
  for (const h of hubs.slice(1)) assert.ok(inside(t, h, 0, 0, 300, 600));
  // Wide, all of them.
  assert.deepEqual(readableUnion(hubs, 900, 600), { x0: -10, y0: -200, x1: 548, y1: 40 });
  assert.equal(readableUnion([], 900, 600), null);
});

test("a goal picked from the list is centred with the goals it shares with around it, when they fit readable (A10, C39)", () => {
  const goal = { x0: 0, y0: 0, x1: 148, y1: 72 };
  const near = [{ x0: -300, y0: 100, x1: -152, y1: 172 }, { x0: 250, y0: -150, x1: 398, y1: -78 }];
  const t = pickTransform(goal, near, 900, 700, { top: 40 });
  assert.ok(t.k >= READABLE_SCALE && t.k <= 1);
  assert.equal((screen(t, goal.x0) + screen(t, goal.x1)) / 2, 450);
  for (const n of near) assert.ok(inside(t, n, 0, 40, 900, 700));
  // Nothing near: centred at full size, as before.
  assert.deepEqual(pickTransform(goal, [], 900, 700, { top: 40 }), centreTransform(goal, 1, 900, 700, { top: 40 }));
});

test("a picked goal whose partners don't fit around it readable is fitted with all of them instead (C39)", () => {
  const goal = { x0: 0, y0: 0, x1: 148, y1: 72 };
  // One partner far right: centring on the goal would leave the left half empty.
  const near = [{ x0: 1200, y0: 0, x1: 1348, y1: 72 }, { x0: 300, y0: 300, x1: 448, y1: 372 }];
  const t = pickTransform(goal, near, 670, 418, { top: 46 });
  for (const n of [goal, ...near]) assert.ok(inside(t, n, 0, 46, 670, 418));
  assert.ok(t.k < READABLE_SCALE); // too far apart to read here: still all in view
  // Never closer than the cap.
  assert.ok(pickTransform(goal, [{ x0: 160, y0: 0, x1: 308, y1: 72 }], 2000, 2000, 0, 1).k <= 1);
});

test("a goal card holds the whole name the first-run network cut (C35)", () => {
  for (const name of [
    "Turn Tagomoto website visitors into App Store downloads",
    "Grow adoption of Tagomoto: Home Organizer",
    "Publish Tagomoto's privacy policy and terms of service",
  ]) {
    const lines = wrapLabel(name, 19, GOAL_LINES);
    assert.equal(lines.join(" "), name);
  }
});
