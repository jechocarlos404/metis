import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  SEED_KINDS, capabilityDeleteKept, capabilityDeleteLinks, featureDeleteKept, keptRows,
  seedImportTitle, seedRejected, seedRemovalTitle, takenCounts, takenWords,
} from "../src/lib/words.js";

describe("seed file result titles (SeedFiles.jsx)", () => {
  test("a check that would reject a link names it and says the rest is what it would do", () => {
    const result = { dryRun: true, counts: { goals: { "would create": 3 }, edges: { "would reject": 1 } } };
    assert.equal(seedImportTitle(result),
      "Check found a problem: the import would reject 1 link between features, named below. The rest is what it would do:");
  });

  test("an import that rejected rows says it imported the rest", () => {
    const result = { dryRun: false, counts: { features: { created: 7 }, edges: { rejected: 2 }, motivations: { rejected: 1 } } };
    assert.equal(seedImportTitle(result), "Imported, except 2 links between features and 1 goal link, rejected as named below");
  });

  test("nothing rejected: passed, nothing new, or imported", () => {
    assert.equal(seedImportTitle({ dryRun: true, counts: { goals: { "would create": 3 } } }), "Check passed. This is what the import would do:");
    assert.equal(seedImportTitle({ dryRun: false, counts: { goals: { created: 3 } } }), "Imported");
    assert.equal(seedImportTitle({ dryRun: true, counts: { goals: { reused: 3 }, features: { skipped: 1 } } }),
      "Check passed. Nothing new: everything in this file is already in metis.");
    assert.equal(seedImportTitle({ dryRun: false, counts: { goals: { reused: 3 } } }),
      "Nothing new: everything in this file was already in metis.");
  });

  test("rejections count only the importer's own collections", () => {
    assert.equal(seedRejected({ unknown: { rejected: 4 } }), "");
    assert.equal(seedRejected({ bundles: { rejected: 1 } }), "1 capability added by hand");
    assert.deepEqual(Object.keys(SEED_KINDS).slice(0, 3), ["goals", "capabilities", "motivations"]);
  });

  test("a removal is a preview until it runs", () => {
    assert.equal(seedRemovalTitle({ dryRun: true }), "Preview: this is what would be removed");
    assert.equal(seedRemovalTitle({ dryRun: false }), "Removed");
  });
});

describe("delete confirm sentences", () => {
  test("a product delete names what else it takes, by name when few, in a fixed order", () => {
    const takes = [
      { table: "features", label: "Features", count: 8, names: [] },
      { table: "feature_edges", label: "Feature edges", count: 3, names: ["a", "b", "c"] },
      { table: "epics", label: "Epics", count: 2, names: ["Search", "Sync"] },
      { table: "product_decompositions", label: "Product decompositions", count: 1, names: ["version 1"] },
      { table: "stories", label: "Stories", count: 6, names: ["1", "2", "3", "4", "5", "6"] },
    ];
    assert.deepEqual(takenWords(takes), ["1 plan document (version 1)", "2 epics (Search, Sync)", "6 stories", "3 links between features"]);
    assert.deepEqual(takenCounts(takes), ["1 plan document", "2 epics", "6 stories", "3 links between features"]);
    assert.deepEqual(takenWords([{ table: "new_table", label: "New Rows", count: 2, names: ["x"] }]), ["2 new rows"]);
  });

  test("a capability delete says which links go and what stays without it", () => {
    assert.equal(capabilityDeleteLinks([], 0), null);
    assert.equal(capabilityDeleteLinks([{ display_id: "PG-40" }], 0), "Unlinks goal PG-40.");
    assert.equal(capabilityDeleteLinks([{ display_id: "OG-39" }, { display_id: "PG-40" }], 2), "Unlinks goals OG-39 and PG-40 and drops 2 guesses waiting for review.");
    assert.equal(capabilityDeleteLinks(null, 1), "drops 1 guess waiting for review.");
    assert.equal(capabilityDeleteKept([]), null);
    assert.equal(capabilityDeleteKept([{ table: "epics", label: "Epics", count: 1, names: ["Search (Climb)"] }]), "Clears it from epic Search (Climb).");
    assert.equal(capabilityDeleteKept([
      { table: "stack_slots", label: "Stack slots", count: 2, names: ["a (S)", "b (S)"] },
      { table: "product_bundles", label: "Product bundles", count: 2, names: ["Magpie", "Steps (iOS)"] },
    ]), "Clears it from 2 stack slots: a (S), b (S) and takes it off the capabilities Magpie and Steps (iOS) added by hand.");
    assert.equal(capabilityDeleteKept([{ table: "product_bundles", label: "Product bundles", count: 1, names: ["Magpie"] }]),
      "Takes it off the capabilities Magpie added by hand.");
  });

  test("a feature delete says what it clears and which links it drops", () => {
    assert.equal(featureDeleteKept(null), null);
    assert.equal(featureDeleteKept([{ table: "stories", label: "Stories", count: 1, names: ["Plan (Search epic)"] }]),
      "Deleting it clears it from story Plan (Search epic).");
    assert.equal(featureDeleteKept([{ table: "feature_edges", label: "Feature edges", count: 1, names: ["Sync"] }]), "Deleting it drops the link Sync.");
    assert.equal(featureDeleteKept([
      { table: "journey_steps", label: "Journey steps", count: 2, names: ["a (J)", "b (J)"] },
      { table: "feature_edges", label: "Feature edges", count: 2, names: ["x", "y"] },
    ]), "Deleting it clears it from 2 journey steps: a (J), b (J) and drops 2 links: x and y.");
  });

  test("kept rows read singular for one", () => {
    assert.equal(keptRows([{ label: "Stories", count: 1, names: ["S"] }, { label: "Stack slots", count: 1, names: ["T"] }]), "story S and stack slot T");
  });
});
