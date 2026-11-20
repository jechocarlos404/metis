// One word per concept: "missing" is a feature's or step's word, never a
// capability's.

import { test } from "node:test";
import assert from "node:assert/strict";
import { NEED, VERDICT, lackingKey, needKey } from "../src/lib/words.js";

const ours = { ours: true, external_products: [] };
const elsewhere = { ours: false, external_products: [{ name: "Strava" }] };
const none = { ours: false, external_products: [] };

test("a capability nobody has finished is not built yet, not missing", () => {
  assert.equal(NEED[needKey(none)].label, "not built yet");
  assert.equal(NEED[needKey(null)].label, "not built yet"); // a name no capability has
  assert.equal(VERDICT.missing.label, "missing");
  assert.ok(Object.values(NEED).every((n) => n.label !== VERDICT.missing.label));
});

test("why a feature or step is missing, when its gaps agree", () => {
  assert.equal(lackingKey([ours, elsewhere, elsewhere]), "elsewhere");
  assert.equal(lackingKey([none, null]), "none");
  assert.equal(lackingKey([elsewhere, none]), null);
  assert.equal(lackingKey([ours]), null);
});
