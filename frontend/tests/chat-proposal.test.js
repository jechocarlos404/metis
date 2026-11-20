// The approval card's words: names instead of the UUIDs an agent passed,
// plain words instead of enum values, the raw value kept for the hover.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { changeLabel, fieldRows } from "../src/components/chat/proposal-words.js";

const GOAL_ID = "bc55de64-3d5a-4934-b404-b0945c6e2492";

describe("approval card", () => {
  test("names the goal by code and title; the UUID is the hover", () => {
    const args = { goal: GOAL_ID, capability: "Ride Café Stops" };
    const named = { goal: "PG-88 Plan café stops on every ride", capability: "Ride Café Stops" };
    assert.deepEqual(fieldRows(args, named), [
      { key: "goal", label: "goal", text: "PG-88 Plan café stops on every ride", raw: GOAL_ID },
      { key: "capability", label: "capability", text: "Ride Café Stops", raw: null },
    ]);
  });

  test("enum values read as the screens say them", () => {
    const args = { name: "Ride Café Stops", maturity: "ga", status: "in_progress", layer: "infra", priority: 2, unknown_capabilities: true };
    const rows = Object.fromEntries(fieldRows(args, null).map((r) => [r.key, r]));
    assert.equal(rows.maturity.text, "stable");
    assert.equal(rows.maturity.raw, "ga");
    assert.equal(rows.status.text, "in progress");
    assert.equal(rows.layer.text, "infrastructure");
    assert.equal(rows.priority.text, "P2");
    assert.equal(rows.unknown_capabilities.label, "capability list incomplete");
    assert.equal(rows.unknown_capabilities.text, "yes");
    assert.equal(rows.name.raw, null);
  });

  test("headings say what the change does, not the tool's name", () => {
    assert.equal(changeLabel("motivate_capability"), "Link a goal to a capability");
    assert.equal(changeLabel("create_capability"), "New capability");
    assert.equal(changeLabel("some_new_tool"), "some new tool");
  });
});
