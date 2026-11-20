// The in-app seed importer against an in-memory metis. `fetch` is stubbed, so
// nothing here can reach a real instance: any other host fails the test.

import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { POST, validateSeed } from "../src/pages/api/seed/import.js";
import { POST as unseedPOST } from "../src/pages/api/seed/unseed.js";

const HOST = "http://metis.test";
const slugify = (value) => value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/** Just enough of the metis API for the importer. Every request is recorded. */
class FakeMetis {
  constructor({ capabilities = [], products = [], features = [], edges = [] } = {}) {
    this.seq = 0;
    this.capabilities = capabilities.map((c) => ({ id: this.id("cap"), slug: slugify(c.name), parent_id: null, ...c }));
    this.products = products.map((p) => ({ id: this.id("prod"), external: false, ...p }));
    this.features = features.map((f) => ({ id: this.id("feat"), unknown_capabilities: false, capability_ids: [], ...f }));
    this.edges = edges;
    this.goals = [];
    this.requests = [];
    // Capabilities someone else creates after the importer read the list.
    this.racing = [];
    this.rejectPatch = false;
  }

  id(prefix) {
    this.seq += 1;
    return `${prefix}-${this.seq}`;
  }

  get writes() {
    return this.requests.filter((r) => r.method !== "GET" && r.path !== "/api/capabilities/coverage");
  }

  handle(method, path, body) {
    const route = `${method} ${path.split("?")[0]}`;
    let m;
    if (route === "GET /api/goals") return [200, this.goals];
    if (route === "GET /api/capabilities") return [200, this.capabilities];
    if (route === "POST /api/capabilities") {
      // The backend's clash rule: the explicit slug, the derived one, or the
      // current name ignoring case; the 409 names the row that holds it.
      const slug = body.slug ?? slugify(body.name);
      const clashes = (c) =>
        [slug, slugify(body.name)].includes(c.slug) || c.name.toLowerCase() === body.name.trim().toLowerCase();
      this.capabilities.push(...this.racing.filter(clashes));
      this.racing = this.racing.filter((c) => !clashes(c));
      const held = this.capabilities.find(clashes);
      if (held) return [409, { detail: { message: `"${held.name}" already exists`, slug: held.slug, name: held.name } }];
      const row = { id: this.id("cap"), slug, parent_id: null, ...body };
      this.capabilities.push(row);
      return [201, row];
    }
    if (route === "POST /api/capabilities/coverage") {
      const words = (name) => new Set(name.toLowerCase().split(/\W+/).filter(Boolean));
      const needs = body.features[0].capabilities.map((name) => ({
        name,
        match: null,
        candidates: this.capabilities.filter((c) => [...words(c.name)].some((w) => words(name).has(w))),
      }));
      return [200, { features: [{ name: body.features[0].name, capabilities: needs }] }];
    }
    if (route === "GET /api/products") return [200, this.products];
    if (route === "POST /api/products") {
      const row = { id: this.id("prod"), external: false, ...body };
      this.products.push(row);
      return [201, row];
    }
    if ((m = route.match(/^POST \/api\/products\/([^/]+)\/seeded$/))) {
      return [200, this.products.find((p) => p.id === m[1])];
    }
    if (route === "GET /api/features") return [200, this.features];
    if (route === "POST /api/features") {
      const row = { id: this.id("feat"), ...body };
      this.features.push(row);
      return [201, row];
    }
    if ((m = route.match(/^PATCH \/api\/features\/([^/]+)$/))) {
      if (this.rejectPatch) return [422, { detail: "refused" }];
      const row = this.features.find((f) => f.id === m[1]);
      Object.assign(row, body);
      return [200, row];
    }
    if (route === "GET /api/features/edges") return [200, this.edges];
    if (route === "POST /api/features/edges") {
      this.edges.push(body);
      return [201, body];
    }
    if (route === "GET /api/guesses" || route === "GET /api/tech/satisfactions") return [200, []];
    if (route === "GET /api/tech") return [200, { rows: [], total: 0 }];
    throw new Error(`fake metis has no route ${route}`);
  }

  fetch = async (url, init = {}) => {
    const { origin, pathname, search } = new URL(url);
    assert.equal(origin, HOST, `request left the fake backend: ${url}`);
    const method = init.method || "GET";
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    this.requests.push({ method, path: pathname + search, body });
    const [status, json] = this.handle(method, pathname + search, body);
    return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
  };
}

let metis;
const realFetch = globalThis.fetch;
const realBackend = process.env.API_INTERNAL_URL;

beforeEach(() => {
  process.env.API_INTERNAL_URL = HOST;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realBackend === undefined) delete process.env.API_INTERNAL_URL;
  else process.env.API_INTERNAL_URL = realBackend;
});

function use(fake) {
  metis = fake;
  globalThis.fetch = fake.fetch;
  return fake;
}

/** POST the document to an endpoint, as the Settings page does. */
async function postSeed(handler, doc, options = {}) {
  const payload = { document: JSON.stringify(doc), ...options };
  const response = await handler({
    request: new Request("http://app.test/api/seed", { method: "POST", body: JSON.stringify(payload) }),
    locals: { accessToken: "test-token" },
  });
  return { status: response.status, body: await response.json() };
}

const importSeed = (doc, options) => postSeed(POST, doc, options);

const PLAN = "Get a phased delivery plan";

function seed({ capabilities, features } = {}) {
  return {
    format: "metis-seed/v1",
    products: [{ ref: "p", name: "Metis" }],
    capabilities: capabilities ?? [{ ref: "c-search", name: "Keyword search" }],
    features: features ?? [
      { ref: "f-plan", product_ref: "p", name: PLAN, capability_refs: ["c-search"], status: "done", description: "Plans in phases." },
    ],
  };
}

/** An instance that already has the product, its capability and the feature. */
function existing({ capability = { name: "Keyword Search" }, feature = {} } = {}) {
  const fake = new FakeMetis({ capabilities: [capability], products: [{ name: "Metis" }] });
  fake.features.push({
    id: "feat-plan",
    product_id: fake.products[0].id,
    name: PLAN,
    capability_ids: [fake.capabilities[0].id],
    unknown_capabilities: false,
    status: "in_progress",
    description: "Plans.",
    priority: 2,
    ...feature,
  });
  return fake;
}

describe("capability identity is the slug", () => {
  test("a name that differs only in case reuses the capability", async () => {
    use(existing());
    const { status, body } = await importSeed(seed(), { dryRun: false });
    assert.equal(status, 200);
    assert.deepEqual(body.counts.capabilities, { reused: 1 });
    assert.equal(metis.requests.filter((r) => r.method === "POST" && r.path === "/api/capabilities").length, 0);
    assert.equal(metis.capabilities.length, 1);
    assert.ok(body.notes.includes('capability "Keyword search" is the existing "Keyword Search"; reused as it is'));
  });

  test("a renamed capability, whose slug kept its old name, is found by its current name", async () => {
    use(existing({ capability: { name: "Keyword Search", slug: "search" } }));
    const { body } = await importSeed(seed({ capabilities: [{ ref: "c-search", name: "Keyword Search" }] }), { dryRun: false });
    assert.deepEqual(body.counts.capabilities, { reused: 1 });
    assert.equal(metis.capabilities.length, 1);
  });

  test("an explicit slug no row has falls back to the name", async () => {
    use(existing({ capability: { name: "Authentication" } }));
    const doc = seed({ capabilities: [{ ref: "c-search", name: "Authentication", slug: "auth" }] });
    const { body } = await importSeed(doc, { dryRun: false });
    assert.deepEqual(body.counts.capabilities, { reused: 1 });
    assert.equal(metis.capabilities.length, 1);
  });

  test("an exported -2 pair maps each capability to itself", async () => {
    use(existing());
    metis.capabilities.push({ id: "cap-dup", slug: "keyword-search-2", name: "Keyword search", parent_id: null });
    metis.features[0].capability_ids.push("cap-dup");
    const doc = seed({
      capabilities: [
        { ref: "c1", name: "Keyword Search", slug: "keyword-search" },
        { ref: "c2", name: "Keyword search", slug: "keyword-search-2" },
      ],
      features: [{ ref: "f-plan", product_ref: "p", name: PLAN, capability_refs: ["c1", "c2"], status: "in_progress", description: "Plans." }],
    });
    assert.deepEqual(validateSeed(doc), []);
    const { body } = await importSeed(doc, { dryRun: false });
    assert.deepEqual(body.counts.capabilities, { reused: 2 });
    assert.deepEqual(body.counts.features, { reused: 1 });
    assert.deepEqual(metis.writes.map((r) => r.path), [`/api/products/${metis.products[0].id}/seeded`]);
  });

  test("a -2 pair imported where only the original exists lands both refs on it", async () => {
    use(existing());
    const doc = seed({
      capabilities: [
        { ref: "c1", name: "Keyword Search", slug: "keyword-search" },
        { ref: "c2", name: "Keyword search", slug: "keyword-search-2" },
      ],
      features: [{ ref: "f-new", product_ref: "p", name: "Find a capability", capability_refs: ["c1", "c2"] }],
    });
    const { status, body } = await importSeed(doc, { dryRun: false });
    assert.equal(status, 200);
    assert.deepEqual(body.counts.capabilities, { reused: 2 });
    assert.equal(metis.capabilities.length, 1);
    const created = metis.requests.find((r) => r.method === "POST" && r.path === "/api/features");
    assert.deepEqual([...new Set(created.body.capability_ids)], [metis.capabilities[0].id]);
  });

  test("a 409 slug clash on create is reuse of that slug", async () => {
    use(existing());
    metis.racing.push({ id: "cap-late", slug: "vector-search", name: "Vector Search", parent_id: null });
    const doc = seed({ capabilities: [{ ref: "c-search", name: "Keyword search" }, { ref: "c-vec", name: "Vector search" }] });
    const { status, body } = await importSeed(doc, { dryRun: false });
    assert.equal(status, 200);
    assert.deepEqual(body.counts.capabilities, { reused: 2 });
    assert.ok(body.notes.includes('capability "Vector search" is the existing "Vector Search"; reused as it is'));
  });

  test("the dry run names each capability it would create, with the nearest existing names", async () => {
    use(existing());
    const doc = seed({ capabilities: [{ ref: "c-search", name: "Keyword search" }, { ref: "c-vec", name: "Vector search" }, { ref: "c-pay", name: "Payments" }] });
    const { body } = await importSeed(doc);
    assert.deepEqual(body.counts.capabilities, { reused: 1, "would create": 2 });
    assert.ok(body.notes.includes('new capability "Vector search"; nearest existing: "Keyword Search"'));
    assert.ok(body.notes.includes('new capability "Payments"'));
  });
});

describe("a product's own seed is the authority on its features", () => {
  test("the dry run lists each overwrite and changes nothing", async () => {
    use(existing());
    const { body } = await importSeed(seed());
    assert.equal(body.dryRun, true);
    assert.deepEqual(body.counts.features, { reused: 1, "would update": 1 });
    assert.ok(body.notes.includes(`feature "${PLAN}": status in progress → done; description "Plans." → "Plans in phases."`));
    assert.deepEqual(metis.writes, []);
    assert.equal(metis.features[0].status, "in_progress");
  });

  test("the import applies status and description, reports the same, and leaves priority alone", async () => {
    use(existing());
    const { body } = await importSeed(seed(), { dryRun: false });
    const patch = metis.requests.find((r) => r.method === "PATCH");
    assert.deepEqual(patch.body, { status: "done", description: "Plans in phases." });
    assert.deepEqual(body.counts.features, { reused: 1, updated: 1 });
    assert.ok(body.notes.includes(`feature "${PLAN}": status in progress → done; description "Plans." → "Plans in phases."`));
    assert.equal(metis.features[0].status, "done");
    assert.equal(metis.features[0].priority, 2);
  });

  test("fields the file leaves out are left alone", async () => {
    use(existing());
    const doc = seed({ features: [{ ref: "f-plan", product_ref: "p", name: PLAN, capability_refs: ["c-search"] }] });
    const { body } = await importSeed(doc, { dryRun: false });
    assert.equal(metis.requests.filter((r) => r.method === "PATCH").length, 0);
    assert.ok(!body.notes.some((n) => n.startsWith("feature ")));
  });

  test("a refused update is a warning, not a reported overwrite", async () => {
    use(existing());
    metis.rejectPatch = true;
    const { body } = await importSeed(seed(), { dryRun: false });
    assert.deepEqual(body.counts.features, { reused: 1, rejected: 1 });
    assert.ok(!body.notes.some((n) => n.startsWith("feature ")));
    assert.equal(body.warnings.length, 1);
  });
});

describe("dry run and re-import", () => {
  const fresh = () => ({
    ...seed({
      capabilities: [{ ref: "c-search", name: "Keyword search" }, { ref: "c-plan", name: "Delivery Planning" }],
      features: [
        { ref: "f-search", product_ref: "p", name: "Search the inventory", capability_refs: ["c-search"], status: "done" },
        { ref: "f-plan", product_ref: "p", name: PLAN, capability_refs: ["c-plan", "c-search"], status: "in_progress" },
      ],
    }),
    edges: [{ src_ref: "f-plan", dst_ref: "f-search", kind: "DEPENDS_ON" }],
  });

  test("a dry run, the default, writes nothing", async () => {
    use(new FakeMetis());
    const { status, body } = await importSeed(fresh());
    assert.equal(status, 200);
    assert.equal(body.dryRun, true);
    assert.deepEqual(body.counts.features, { "would create": 2 });
    assert.deepEqual(body.counts.edges, { "would create": 1 });
    assert.deepEqual(metis.writes, []);
    assert.equal(metis.capabilities.length + metis.products.length + metis.features.length, 0);
  });

  test("re-importing an unchanged file changes nothing", async () => {
    use(new FakeMetis());
    const first = await importSeed(fresh(), { dryRun: false });
    assert.deepEqual(first.body.counts.features, { created: 2 });
    metis.requests = [];

    const again = await importSeed(fresh(), { dryRun: false });
    assert.equal(again.status, 200);
    for (const [collection, counts] of Object.entries(again.body.counts)) {
      assert.deepEqual(Object.keys(counts).filter((k) => k !== "reused"), [], `${collection}: ${JSON.stringify(counts)}`);
    }
    assert.deepEqual(metis.writes.map((r) => r.path), [`/api/products/${metis.products[0].id}/seeded`]);
    assert.deepEqual(again.body.notes, []);
    assert.deepEqual(again.body.warnings, []);
  });
});

describe("unseed uses the importer's capability identity", () => {
  const unseed = (doc) => postSeed(unseedPOST, doc);
  const wouldDelete = (body) => body.notes.filter((n) => n.startsWith("would delete capability "));

  test("a name that differs only in case targets the existing capability", async () => {
    use(existing());
    const { status, body } = await unseed(seed());
    assert.equal(status, 200);
    assert.deepEqual(wouldDelete(body), ['would delete capability "Keyword Search"']);
    assert.deepEqual(metis.writes, []);
  });

  test("a renamed capability is found by its current name", async () => {
    use(existing({ capability: { name: "Keyword Search", slug: "search" } }));
    const { body } = await unseed(seed({ capabilities: [{ ref: "c-search", name: "Keyword Search" }] }));
    assert.deepEqual(wouldDelete(body), ['would delete capability "Keyword Search"']);
  });

  test("each capability of a slugged -2 pair targets its own row", async () => {
    use(existing());
    metis.capabilities.push({ id: "cap-dup", slug: "keyword-search-2", name: "Keyword search", parent_id: null });
    metis.features[0].capability_ids.push("cap-dup");
    const { body } = await unseed(seed({
      capabilities: [
        { ref: "c1", name: "Keyword Search", slug: "keyword-search" },
        { ref: "c2", name: "Keyword search", slug: "keyword-search-2" },
      ],
      features: [{ ref: "f-plan", product_ref: "p", name: PLAN, capability_refs: ["c1", "c2"] }],
    }));
    assert.deepEqual(wouldDelete(body).sort(), ['would delete capability "Keyword Search"', 'would delete capability "Keyword search"']);
  });
});

describe("a description change shows both versions", () => {
  const plan = (description) => [{ ref: "f-plan", product_ref: "p", name: PLAN, capability_refs: ["c-search"], description }];

  test("trimmed to where they differ", async () => {
    use(existing({ feature: { description: "Plans delivery in phases, sized for one coding session each, and orders them by dependency." } }));
    const { body } = await importSeed(seed({ features: plan("Plans delivery in phases, sized for one coding session each, and orders them by risk.") }));
    assert.ok(body.notes.includes(`feature "${PLAN}": description "…and orders them by dependency." → "…and orders them by risk."`));
  });

  test("a feature with no description yet", async () => {
    use(existing({ feature: { description: null } }));
    const { body } = await importSeed(seed({ features: plan("Plans in phases.") }));
    assert.ok(body.notes.includes(`feature "${PLAN}": description empty → "Plans in phases."`));
  });
});

describe("validateSeed", () => {
  test("rejects a wrong format, a duplicate capability slug and an unknown ref", () => {
    const doc = seed({
      capabilities: [{ ref: "c1", name: "Keyword search" }, { ref: "c2", name: "Keyword Search" }],
      features: [{ ref: "f", product_ref: "p", name: PLAN, capability_refs: ["c-missing"] }],
    });
    doc.format = "metis-seed/v2";
    const errors = validateSeed(doc);
    assert.ok(errors.includes(`'format' must be "metis-seed/v1"`), errors.join("\n"));
    assert.ok(errors.includes(`capabilities[1] (c2): duplicate capability slug "keyword-search"`), errors.join("\n"));
    assert.ok(errors.some((e) => e.startsWith("features[0] (f):") && e.includes('"c-missing"')), errors.join("\n"));
  });

  test("rejects a capability whose name yields no slug", () => {
    const errors = validateSeed(seed({ capabilities: [{ ref: "c-search", name: "!!!" }] }));
    assert.deepEqual(errors, ["capabilities[0] (c-search): slug must be a non-empty string (give one when the name yields none)"]);
  });

  test("the endpoint refuses an invalid file before touching the instance", async () => {
    use(new FakeMetis());
    const { status, body } = await importSeed({ ...seed(), format: "nope" }, { dryRun: false });
    assert.equal(status, 400);
    assert.match(body.detail, /'format' must be "metis-seed\/v1"/);
    assert.deepEqual(metis.requests, []);
  });
});
