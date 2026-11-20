// The approval card's words: names instead of the UUIDs an agent passed,
// plain words instead of enum values, the raw value kept for the hover.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { changeLabel, display, fieldRows, objects } from "../src/components/chat/proposal-words.js";

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

  test("a thing an earlier change creates shows by name, even in a list", () => {
    const made = { proposal: "p-1", name: "Ride Café Stops" };
    const [row] = fieldRows({ capability: made }, null);
    assert.equal(row.text, "Ride Café Stops");
    const [list] = fieldRows({ capabilities: ["Maps", made] }, null);
    assert.equal(list.text, "Maps, Ride Café Stops");
  });

  test("untrusted shapes become text, never objects on the page (SR2)", () => {
    assert.equal(display({ nested: true }), '{"nested":true}');
    assert.equal(display(["a", 2]), "a, 2");
    assert.equal(display(null), "");
    assert.deepEqual(objects("not a list"), []);
    assert.deepEqual(objects(["s", 7, null, ["x"], { title: "E" }]), [{ title: "E" }]);
    const rows = fieldRows({ maturity: { odd: 1 } }, null);
    assert.equal(rows[0].text, '{"odd":1}');
  });

  test("headings say what the change does, not the tool's name", () => {
    assert.equal(changeLabel("motivate_capability"), "Link a goal to a capability");
    assert.equal(changeLabel("create_capability"), "New capability");
    assert.equal(changeLabel("some_new_tool"), "some new tool");
  });
});
