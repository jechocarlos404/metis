// The approval card's words: names instead of the UUIDs an agent passed,
// plain words instead of enum values, the raw value kept for the hover.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { changeLabel, display, fieldRows, objects, stepLabel, stepProposals, stepRows } from "../src/components/chat/proposal-words.js";

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

// "What it did": each step in plain words and names, as the approval card
// says them (A36); the raw value stays the hover.
describe("what it did", () => {
  const CAP_ID = "cdca9ce1-ae77-4fab-add6-8d3dbc5000cf";

  test("a step reads as what it did, not the tool's name", () => {
    assert.equal(stepLabel("motivate_capability"), changeLabel("motivate_capability"));
    assert.equal(stepLabel("list_goals"), "Read the goals");
    assert.equal(stepLabel("existing_product_coverage"), "Score a product");
    assert.equal(stepLabel("some_new_tool"), "some new tool");
  });

  test("every agent tool has words", () => {
    const tools = readFileSync(new URL("../../backend/app/agents/tools.py", import.meta.url), "utf8");
    const names = [...tools.matchAll(/_tool\(\s*"([a-z_]+)"/g)].map((m) => m[1]);
    assert.ok(names.length > 20);
    for (const name of names) assert.notEqual(stepLabel(name), name.replace(/_/g, " "), name);
  });

  test("IDs read as names, the UUID is the hover (chat1, QA c3)", () => {
    const args = { goal: GOAL_ID, capability: CAP_ID };
    const named = { goal: "PG-40 Plan work from goal to ticket with AI assistance", capability: "Knowledge Graph" };
    assert.deepEqual(stepRows(args, named), [
      { key: "goal", label: "goal", text: "PG-40 Plan work from goal to ticket with AI assistance", raw: GOAL_ID },
      { key: "capability", label: "capability", text: "Knowledge Graph", raw: CAP_ID },
    ]);
  });

  test("without names the raw values show; plain words for enum values", () => {
    const rows = stepRows({ src: "Plan a route", dst: "Show the map", kind: "DEPENDS_ON", feature: null }, undefined);
    assert.deepEqual(rows.map((r) => [r.label, r.text, r.raw]), [
      ["from", "Plan a route", null], ["to", "Show the map", null], ["kind", "needs", "DEPENDS_ON"], ["feature", "none", null],
    ]);
  });

  test("a document or a list of objects is counted, not printed", () => {
    const doc = { epics: [{ title: "E" }], summary: "s" };
    const rows = stepRows({ product: "Atlas", document: doc, features: [{ name: "a" }, { name: "b" }], targets: ["x", "y"] }, null);
    assert.deepEqual(rows.map((r) => [r.key, r.text]), [["product", "Atlas"], ["document", "2 fields"], ["features", "2 items"], ["targets", "x, y"]]);
  });
});

describe("what it did (A53)", () => {
  const read = { name: "get_capability", status: "finished" };
  const link = { name: "link_goal_capability", status: "proposed" };
  const create = { name: "create_capability", status: "proposed" };
  const refused = { name: "create_capability", status: "failed" };

  test("a proposed step reads its proposal's current state, in order", () => {
    const proposals = [{ tool_name: "link_goal_capability", status: "applied" }, { tool_name: "create_capability", status: "pending" }];
    assert.deepEqual(stepProposals([read, link, refused, create], proposals).map((p) => p?.status ?? null), [null, "applied", null, "pending"]);
  });

  test("a pairing that doesn't line up shows no state rather than a wrong one", () => {
    assert.deepEqual(stepProposals([link], [{ tool_name: "create_capability", status: "applied" }]), [null]);
    assert.deepEqual(stepProposals([link], []), [null]);
    assert.deepEqual(stepProposals([link]), [null]);
  });

  test("the step keeps no 'proposed' word of its own", () => {
    const src = readFileSync(new URL("../src/components/islands/ChatIsland.jsx", import.meta.url), "utf8");
    assert.doesNotMatch(src, /proposed: "proposed"/);
  });
});
