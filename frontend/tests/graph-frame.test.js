// Graph framing: names are never drawn under 11px, Fit shows every node, and
// a graph opens where its names can be read without zooming.

import { test } from "node:test";
import assert from "node:assert/strict";
import { LABEL_PX, READABLE_SCALE, fitTransform, openTransform, revealTransform } from "../src/components/graph/graph-data.js";

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
