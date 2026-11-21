// The capability picker offers near names and never picks one for you (A55).

import { test } from "node:test";
import assert from "node:assert/strict";
import { pickerItems } from "../src/components/shared/picker-items.js";

const options = [
  { id: 1, name: "Route Planning" },
  { id: 2, name: "Ride Prep Checklist" },
  { id: 3, name: "Cafe Directory" },
  { id: 4, name: "User Authentication" },
];
const base = { options, picked: new Set(), allowNew: true };
const lines = (r) => r.items.map((i) => (i.kind === "add" ? `add ${i.name}` : `${i.literal ? "" : "~"}${i.option.name}`));

test("a near name is listed above Add, and Add is not the default", () => {
  const r = pickerItems({ ...base, query: "Route Planner", near: ["Route Planning"] });
  assert.deepEqual(lines(r), ["~Route Planning", "add Route Planner"]);
  assert.equal(r.current, -1);
});

test("while the near names are being looked up, Add is not the default either", () => {
  const r = pickerItems({ ...base, query: "Route Planner", near: null });
  assert.equal(r.pending, true);
  assert.deepEqual(lines(r), ["add Route Planner"]);
  assert.equal(r.current, -1);
});

test("a name with no near name keeps Add as the default", () => {
  const r = pickerItems({ ...base, query: "Ride group chat", near: [] });
  assert.deepEqual(lines(r), ["add Ride group chat"]);
  assert.equal(r.current, 0);
});

test("a name holding the typed text is still the default", () => {
  const r = pickerItems({ ...base, query: "route plan", near: ["Route Planning"] });
  assert.deepEqual(lines(r), ["Route Planning", "add route plan"]);
  assert.equal(r.current, 0);
});

test("an exact name needs no lookup and offers no Add", () => {
  const r = pickerItems({ ...base, query: "route planning", near: null });
  assert.equal(r.lookup, false);
  assert.equal(r.pending, false);
  assert.deepEqual(lines(r), ["Route Planning"]);
});

test("near names the caller can't take, or already picked, are left out", () => {
  const r = pickerItems({ ...base, picked: new Set(["route-planning"]), query: "Route Planner", near: ["Route Planning", "Route Sharing"] });
  assert.deepEqual(lines(r), ["add Route Planner"]);
  assert.equal(r.current, 0);
});

test("without allowNew a near name is offered, nothing is the default", () => {
  const r = pickerItems({ ...base, allowNew: false, query: "Route Planner", near: ["Route Planning"] });
  assert.deepEqual(lines(r), ["~Route Planning"]);
  assert.equal(r.current, -1);
});
