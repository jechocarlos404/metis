// The Share snapshot says what the product page says: the same score, words
// and ranked lists for someone else's product, and no score for ours.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { snapshotHtml } from "../src/components/products/shareSnapshot.js";

const ref = (id, name) => ({ id, slug: id, name });
const strava = { id: "strava", name: "Strava", external: true, summary: null, goal_id: null };
const ours = { id: "climb", name: "Can I Climb", external: false, summary: null, goal_id: null };
const capabilities = [
  { id: "c1", name: "Activity Logging", maturity: "planned", products: [], external_products: [ref("strava", "Strava")] },
  { id: "c2", name: "GPS Track Import", maturity: "ga", products: [ref("climb", "Can I Climb")], external_products: [ref("strava", "Strava")] },
];
const features = [
  { id: "f1", name: "Record an activity", status: "done", capability_ids: ["c1"] },
  { id: "f2", name: "Upload files", status: "done", capability_ids: ["c1", "c2"] },
];
const score = {
  product: ref("strava", "Strava"),
  total_features: 2,
  buildable: [],
  partly: [],
  missing: ["Record an activity", "Upload files"],
  missing_incomplete: [],
  not_described: [],
  report: { features: [], needed: 2, existing: 1, mature: 1, missing: ["Activity Logging"] },
  missing_capabilities: [{ name: "Activity Logging", slug: "activity-logging", features: 2, only_gap: 2, elsewhere: [] }],
  closest_products: [
    { product: ref("a", "Alpha"), capabilities: 1 },
    { product: ref("b", "Bravo"), capabilities: 1 },
  ],
};
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ");

describe("Share snapshot", () => {
  test("someone else's product: the page's answer, groups and ranked lists", () => {
    const out = text(snapshotHtml({ product: strava, goals: [], features, capabilities, score }));
    assert.match(out, /We have 1 of the 2 capabilities needed · 1 proven \(beta or stable\)\. Nothing is buildable yet\./);
    assert.match(out, /"Ours": a finished feature of one of our products realizes it\./);
    assert.match(out, /2 missing: needs a capability we don't have/);
    assert.doesNotMatch(out, /0 buildable/); // empty groups stay off, as on the page
    assert.match(out, /1 capability we don't have, most useful first/);
    assert.match(out, /Activity Logging · needed by 2 features · the only gap in 2 of them · in no other product/);
    assert.match(out, /Closest of our products Alpha and Bravo have 1 of the 2 capabilities Strava's features name/);
    assert.doesNotMatch(out, /a product in this portfolio/);
  });

  test("no maturity next to a capability", () => {
    const out = text(snapshotHtml({ product: strava, goals: [], features, capabilities, score }));
    const does = out.slice(out.indexOf("What it does"));
    assert.match(does, /Activity Logging Record an activity/);
    assert.doesNotMatch(does, /planned|stable/);
  });

  test("nothing named: the groups, then what's missing to score it", () => {
    const blank = { ...score, buildable: [], missing: [], not_described: ["Record an activity", "Upload files"], report: null, missing_capabilities: [], closest_products: [] };
    const out = text(snapshotHtml({ product: strava, goals: [], features, capabilities, score: blank }));
    assert.match(out, /Strava: 2 features 2 not described: nobody has named the capabilities it needs yet Nothing to score yet: none of its features names a capability\./);
    assert.doesNotMatch(out, /We have|Closest/);
  });

  test("our own product is not scored", () => {
    const out = text(snapshotHtml({ product: ours, goals: [], features, capabilities, score: { ...score, product: ref("climb", "Can I Climb") } }));
    assert.doesNotMatch(out, /We have|buildable|we could build|Closest/);
    assert.match(out, /What it does/);
  });
});
