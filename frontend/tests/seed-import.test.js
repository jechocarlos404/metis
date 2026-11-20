// The in-app seed importer against an in-memory metis. `fetch` is stubbed, so
// nothing here can reach a real instance: any other host fails the test.

import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { POST, validateSeed } from "../src/pages/api/seed/import.js";
import { POST as unseedPOST } from "../src/pages/api/seed/unseed.js";
import { GET as exportGET } from "../src/pages/api/seed/export.js";

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
    this.motivations = [];
    this.bundles = [];
    this.usage = [];
    this.guesses = [];
    // 403 plays an account that may not read guesses (a viewer, an MCP token).
    this.guessesStatus = 200;
    this.requests = [];
    // Capabilities someone else creates after the importer read the list.
    this.racing = [];
    this.rejectPatch = false;
    // Rows no seed carries: plans, stacks, journeys, recorded uses.
    this.techs = [];
    this.encounters = [];
    this.epics = [];
    this.tickets = [];
    this.stacks = [];
    this.slots = [];
    this.journeys = [];
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
    if (route === "GET /api/guesses") {
      return this.guessesStatus === 200 ? [200, this.guesses] : [this.guessesStatus, { detail: "Requires editor or admin role" }];
    }
    if (route === "GET /api/tech/satisfactions") return [200, []];
    if (route === "GET /api/tech" && this.techs.length > 0) return [200, { rows: this.techs, total: this.techs.length }];
    if ((m = route.match(/^GET \/api\/tech\/([a-z0-9-]+)$/)) && this.techs.some((t) => t.slug === m[1])) {
      const tech = this.techs.find((t) => t.slug === m[1]);
      return [200, { ...tech, versions: [], outgoing: [], incoming: [], encounters: this.encounters.filter((e) => e.tech_id === tech.id) }];
    }
    if (route === "GET /api/stacks") return [200, this.stacks];
    if ((m = route.match(/^GET \/api\/stacks\/(stk[^/]*)$/))) return [200, { stack: this.stacks.find((s) => s.id === m[1]), slots: this.slots.filter((s) => s.stack_id === m[1]) }];
    if ((m = route.match(/^GET \/api\/stacks\/([^/]+)\/concerns$/))) return [200, []];
    if (route === "GET /api/constraints") return [200, []];
    if (route === "GET /api/journeys") return [200, this.journeys];
    if (route === "GET /api/tickets") return [200, this.tickets];
    if ((m = route.match(/^GET \/api\/products\/([^/]+)\/epics$/))) return [200, this.epics.filter((e) => e.product_id === m[1])];
    if ((m = route.match(/^GET \/api\/products\/([^/]+)\/strategies$/))) return [200, []];
    if (route === "GET /api/tech") return [200, { rows: [], total: 0 }];
    if (route === "GET /api/motivations") return [200, this.motivations];
    if (route === "GET /api/product-bundles") return [200, this.bundles];
    if (route === "GET /api/stacks/usage") {
      const productId = new URLSearchParams(path.split("?")[1]).get("product_id");
      return [200, this.usage.filter((u) => u.product_id === productId)];
    }
    if (route === "GET /api/capabilities/map") {
      const node = (c) => ({ ...c, children: this.capabilities.filter((k) => k.parent_id === c.id).map(node) });
      return [200, this.capabilities.filter((c) => !c.parent_id).map(node)];
    }
    if ((m = route.match(/^GET \/api\/products\/([^/]+)\/decompositions$/))) return [200, []];
    if ((m = route.match(/^GET \/api\/products\/([^/]+)\/bundles$/))) {
      const ids = this.bundles.filter((b) => b.product_id === m[1]).map((b) => b.capability_id);
      return [200, this.capabilities.filter((c) => ids.includes(c.id))];
    }
    if ((m = route.match(/^GET \/api\/products\/([^/]+)$/))) return [200, this.products.find((p) => p.id === m[1])];
    // Deletes cascade the way the database does, so a test can see every
    // row a removal takes with it.
    if ((m = route.match(/^DELETE \/api\/capabilities\/([^/]+)\/motivations\/([^/]+)$/))) {
      this.motivations = this.motivations.filter((r) => !(r.capability_id === m[1] && r.goal_id === m[2]));
      return [204, null];
    }
    if ((m = route.match(/^DELETE \/api\/features\/edges\/([^/]+)$/))) {
      this.edges = this.edges.filter((e) => e.id !== m[1]);
      return [204, null];
    }
    if ((m = route.match(/^DELETE \/api\/products\/([^/]+)$/))) {
      // A product's delete takes its features with it.
      for (const f of this.features.filter((f) => f.product_id === m[1])) this.handle("DELETE", `/api/features/${f.id}`);
      this.products = this.products.filter((p) => p.id !== m[1]);
      this.bundles = this.bundles.filter((b) => b.product_id !== m[1]);
      this.usage = this.usage.filter((u) => u.product_id !== m[1]);
      return [204, null];
    }
    if ((m = route.match(/^DELETE \/api\/features\/([^/]+)$/))) {
      this.features = this.features.filter((f) => f.id !== m[1]);
      this.edges = this.edges.filter((e) => e.src_id !== m[1] && e.dst_id !== m[1]);
      this.guesses = this.guesses.filter((g) => g.feature_id !== m[1]);
      return [204, null];
    }
    if ((m = route.match(/^DELETE \/api\/capabilities\/([^/]+)$/))) {
      if (this.features.some((f) => (f.capability_ids || []).includes(m[1]))) return [409, { detail: "in use" }];
      this.capabilities = this.capabilities.filter((c) => c.id !== m[1]);
      this.motivations = this.motivations.filter((r) => r.capability_id !== m[1]);
      this.bundles = this.bundles.filter((b) => b.capability_id !== m[1]);
      this.guesses = this.guesses.filter((g) => g.capability_id !== m[1]);
      return [204, null];
    }
    if ((m = route.match(/^DELETE \/api\/goals\/([^/]+)$/))) {
      this.goals = this.goals.filter((g) => g.id !== m[1]);
      this.motivations = this.motivations.filter((r) => r.goal_id !== m[1]);
      for (const p of this.products) if (p.goal_id === m[1]) p.goal_id = null;
      return [204, null];
    }
    throw new Error(`fake metis has no route ${route}`);
  }

  // product_id is the product the goal belongs to, which the real backend
  // works out (services/goals.py); a test sets it.
  goal(title, { parent = null, goal_type = parent ? "product" : "org", product = null } = {}) {
    const row = { id: this.id("goal"), display_id: `G-${this.seq}`, goal_type, title, parent_goal_id: parent?.id ?? null, product_id: product?.id ?? null };
    this.goals.push(row);
    return row;
  }

  link(goal, capability) {
    this.motivations.push({ id: this.id("mot"), goal_id: goal.id, goal_title: goal.title, capability_id: capability.id, capability_name: capability.name });
  }

  /** Every row, keyed so a test can say which ones a removal took. */
  snapshot() {
    return new Set([
      ...this.goals.map((g) => `goal ${g.title}`),
      ...this.capabilities.map((c) => `capability ${c.name}`),
      ...this.products.map((p) => `product ${p.name}`),
      ...this.features.map((f) => `feature ${f.name}`),
      ...this.motivations.map((r) => `goal link ${r.goal_title} -> ${r.capability_name}`),
      ...this.bundles.map((b) => `bundle ${b.product_name} -> ${b.capability_name}`),
      ...this.usage.map((u) => `usage ${u.product_id} -> ${u.tech_id}`),
      ...this.edges.map((e) => `edge ${e.src_id} -> ${e.dst_id}`),
      ...this.guesses.map((g) => `guess ${g.feature_id} -> ${g.capability_id}`),
    ]);
  }

  fetch = async (url, init = {}) => {
    const { origin, pathname, search } = new URL(url);
    assert.equal(origin, HOST, `request left the fake backend: ${url}`);
    const method = init.method || "GET";
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    this.requests.push({ method, path: pathname + search, body });
    const [status, json] = this.handle(method, pathname + search, body);
    if (status === 204) return new Response(null, { status });
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

  test("the trimmed note carries both texts in full for its hover", async () => {
    const before = "Plans delivery in phases, sized for one coding session each, and orders them by dependency.";
    const after = "Plans delivery in phases, sized for one coding session each, and orders them by risk. Answers stream in as they are written, so a long plan shows its first phase at once.";
    use(existing({ feature: { description: before } }));
    const { body } = await importSeed(seed({ features: plan(after) }));
    const note = body.notes.find((n) => n.startsWith(`feature "${PLAN}": description`));
    assert.ok(note.length < after.length, "the note itself stays short");
    assert.equal(body.fullText[note], `Description before:\n${before}\n\nAfter:\n${after}`);
  });

  test("a feature with no description yet", async () => {
    use(existing({ feature: { description: null } }));
    const { body } = await importSeed(seed({ features: plan("Plans in phases.") }));
    assert.ok(body.notes.includes(`feature "${PLAN}": description empty → "Plans in phases."`));
  });
});

/** A seeded product, a second product sharing one of its capabilities, and
 * the goal the seed made. */
function probe() {
  const fake = new FakeMetis({
    capabilities: [{ name: "Probe Cap" }, { name: "Shared Cap" }],
    products: [{ name: "Probe" }, { name: "Other" }],
  });
  const [cap, shared] = fake.capabilities;
  const [prod, other] = fake.products;
  fake.features.push(
    { id: "feat-probe", product_id: prod.id, name: "Probe feature", capability_ids: [cap.id, shared.id] },
    { id: "feat-second", product_id: prod.id, name: "Second feature", capability_ids: [cap.id] },
    { id: "feat-other", product_id: other.id, name: "Other feature", capability_ids: [shared.id] },
  );
  const org = fake.goal("Probe org goal");
  fake.link(org, cap);
  prod.goal_id = org.id;
  return fake;
}

const probeSeed = ({ motivations = [{ goal_ref: "g", capability_ref: "c" }] } = {}) => ({
  format: "metis-seed/v1",
  goals: [{ ref: "g", goal_type: "org", title: "Probe org goal" }],
  capabilities: [{ ref: "c", name: "Probe Cap" }, { ref: "s", name: "Shared Cap" }],
  motivations,
  products: [{ ref: "p", name: "Probe", goal_ref: "g" }],
  features: [
    { ref: "f", product_ref: "p", name: "Probe feature", capability_refs: ["c", "s"] },
    { ref: "f2", product_ref: "p", name: "Second feature", capability_refs: ["c"] },
  ],
  edges: [{ src_ref: "f2", dst_ref: "f", kind: "DEPENDS_ON" }],
});

describe("removing a seeded product names every row it deletes or keeps", () => {
  const unseed = (doc, options) => postSeed(unseedPOST, doc, options);

  test("a goal link made outside the file keeps its capability, and names the goal", async () => {
    use(probe());
    const pg55 = metis.goal("Edit every part of the site", { parent: metis.goal("Site org goal") });
    metis.link(pg55, metis.capabilities[0]);
    const { body } = await unseed(probeSeed());
    assert.ok(body.notes.includes(
      `kept capability "Probe Cap": goal ${pg55.display_id} "Edit every part of the site" links to it, a link the seed does not have`,
    ));
    assert.ok(!body.notes.some((n) => n.includes('capability "Probe Cap"') && n.startsWith("would delete")));
    await unseed(probeSeed(), { dryRun: false });
    assert.ok(metis.motivations.some((r) => r.goal_id === pg55.id), "the hand-made link survives");
    assert.ok(metis.capabilities.some((c) => c.name === "Probe Cap"));
  });

  test("a goal link between two of the file's rows that the file leaves out keeps both", async () => {
    use(probe());
    const { body } = await unseed(probeSeed({ motivations: [] }));
    const org = metis.goals[0];
    assert.ok(body.notes.includes('kept goal "Probe org goal": it links to capability "Probe Cap", a link the seed does not have'));
    assert.ok(body.notes.includes(`kept capability "Probe Cap": goal ${org.display_id} "Probe org goal" links to it, a link the seed does not have`));
  });

  test("a capability another product added by hand is kept", async () => {
    use(probe());
    const [cap] = metis.capabilities;
    metis.bundles.push({ id: "b1", product_id: metis.products[1].id, product_name: "Other", capability_id: cap.id, capability_name: cap.name });
    const { body } = await unseed(probeSeed());
    assert.ok(body.notes.includes('kept capability "Probe Cap": product "Other" lists it as a capability added by hand'));
  });

  test("every row the removal takes is named in its result, and nothing else goes", async () => {
    use(probe());
    const [cap, shared] = metis.capabilities;
    const [prod] = metis.products;
    metis.edges = [
      { id: "e-declared", src_id: "feat-second", dst_id: "feat-probe", kind: "DEPENDS_ON" },
      { id: "e-hand", src_id: "feat-probe", dst_id: "feat-second", kind: "RELATES_TO" },
      { id: "e-cross", src_id: "feat-other", dst_id: "feat-probe", kind: "DEPENDS_ON" },
    ];
    metis.bundles.push({ id: "b1", product_id: prod.id, product_name: "Probe", capability_id: cap.id, capability_name: cap.name });
    metis.guesses.push({ id: "q1", feature_id: "feat-second", capability_id: shared.id, confidence: "low" });
    metis.usage.push({ id: "u1", product_id: prod.id, tech_id: "tech-postgres" });
    const before = metis.snapshot();
    const preview = await unseed(probeSeed());
    const { body } = await unseed(probeSeed(), { dryRun: false });
    const after = metis.snapshot();
    assert.deepEqual([...before].filter((row) => !after.has(row)).sort(), [
      "bundle Probe -> Probe Cap",
      "capability Probe Cap",
      "edge feat-other -> feat-probe",
      "edge feat-probe -> feat-second",
      "edge feat-second -> feat-probe",
      "feature Probe feature",
      "feature Second feature",
      "goal Probe org goal",
      "goal link Probe org goal -> Probe Cap",
      `guess feat-second -> ${shared.id}`,
      "product Probe",
      `usage ${prod.id} -> tech-postgres`,
    ]);
    assert.deepEqual(body.notes.filter((n) => n.startsWith("deleted ")), [
      'deleted goal link "Probe org goal" → "Probe Cap"',
      'deleted link "Second feature" needs "Probe feature"',
      'deleted link "Probe feature" related to "Second feature" (not in the seed; it goes with its features)',
      'deleted link "Other feature" needs "Probe feature" (feature "Other feature" is outside the seed; the link goes with the deleted one)',
      'deleted feature "Probe feature"',
      'deleted feature "Second feature", with its 1 guess',
      'deleted product "Probe", with its use of 1 technology and 1 capability added by hand',
      'deleted capability "Probe Cap"',
      'deleted goal "Probe org goal"',
    ]);
    assert.deepEqual(
      preview.body.notes.filter((n) => n.startsWith("would delete ")).map((n) => n.slice("would ".length)),
      body.notes.filter((n) => n.startsWith("deleted ")).map((n) => n.replace(/^deleted/, "delete")),
    );
    assert.deepEqual(body.warnings, []);
    // Features go before their product, so none of them is left to the
    // product's delete and counted "absent".
    assert.deepEqual(body.counts.features, { deleted: 2 });
    assert.deepEqual(body.counts.products, { deleted: 1 });
  });

  test("a product with a feature outside the seed is kept, so that feature stays", async () => {
    use(probe());
    metis.features.push({ id: "feat-hand", product_id: metis.products[0].id, name: "Added by hand", capability_ids: [] });
    const { body } = await unseed(probeSeed(), { dryRun: false });
    assert.ok(body.notes.includes('kept product "Probe": 1 feature outside the seed belongs to it'));
    assert.ok(metis.features.some((f) => f.id === "feat-hand"));
  });

  test("keeping a shared capability is information, not a warning", async () => {
    use(probe());
    const { body } = await unseed(probeSeed());
    assert.ok(body.notes.includes('kept capability "Shared Cap": 1 feature outside the seed realizes it'));
    assert.deepEqual(body.counts.capabilities, { kept: 1, "would delete": 1 });
    assert.deepEqual(body.warnings, []);
  });

  test("an account that can't read guesses gets 'can't tell', never a false 'would delete'", async () => {
    use(probe());
    metis.guessesStatus = 403;
    const { body } = await unseed(probeSeed());
    assert.match(body.notes[0], /^This account can't read guesses \(guesses need an editor or admin\)/);
    assert.deepEqual(body.counts.capabilities, { kept: 1, "can't tell": 1 });
    assert.ok(body.notes.includes('can\'t tell whether capability "Probe Cap" goes'));
    assert.ok(!body.notes.some((n) => n.startsWith("would delete capability")));
    // The goal goes for sure, so its declared link does too.
    assert.ok(body.notes.includes('would delete goal link "Probe org goal" → "Probe Cap"'));
  });

  test("a technology someone recorded using is kept, and says who", async () => {
    use(probe());
    const [prod] = metis.products;
    metis.techs.push({ id: "tech-q", slug: "qdrant", name: "Qdrant", used_by: 1 });
    metis.usage.push({ id: "u1", product_id: prod.id, tech_id: "tech-q" });
    metis.encounters.push({ id: "enc-1", tech_id: "tech-q", person: "ana", product_id: prod.id });
    const doc = { ...probeSeed(), technologies: [{ ref: "t", name: "Qdrant", kind: "service", products: ["p"] }] };
    const { body } = await unseed(doc);
    assert.ok(body.notes.includes('kept technology "Qdrant": ana recorded using it'), body.notes.join("\n"));
    assert.ok(!body.notes.some((n) => n.startsWith('would delete technology "Qdrant"')));
    // The product goes; the recorded use stays and says it loses the product.
    assert.ok(body.notes.some((n) =>
      n.startsWith('would delete product "Probe"') && n.endsWith('; 1 recorded use of "Qdrant" stays, no longer naming it')));
  });

  test("a product's line counts its plan and stack; another product's rows that point in stay", async () => {
    use(probe());
    const [cap] = metis.capabilities;
    const [prod, other] = metis.products;
    metis.epics.push(
      { id: "ep1", product_id: prod.id, capability_id: cap.id, title: "Own epic", stories: [{ id: "st1", title: "Own story", feature_id: "feat-probe" }] },
      { id: "ep2", product_id: other.id, capability_id: cap.id, title: "Their epic", stories: [{ id: "st2", title: "Their story", feature_id: "feat-second" }] },
    );
    metis.tickets.push({ id: "tk1", product_id: prod.id, epic_id: "ep1", story_id: "st1" }, { id: "tk2", product_id: prod.id, epic_id: null, story_id: null });
    metis.stacks.push({ id: "stk1", name: "Probe stack", product_id: prod.id, parent_id: null });
    metis.slots.push({ id: "sl1", stack_id: "stk1", role: "db", capability_id: null, tech_id: null });
    metis.journeys.push({ id: "j1", name: "Sign up", steps: [{ id: "js1", feature_id: "feat-probe" }] });
    const { body } = await unseed(probeSeed());
    assert.ok(body.notes.includes(
      'would delete product "Probe", with 1 epic, 1 story, 2 tickets and its stack "Probe stack" (1 slot)',
    ), body.notes.join("\n"));
    assert.ok(body.notes.includes('would delete feature "Probe feature"; journey "Sign up" keeps its step, no longer linked to it'));
    assert.ok(body.notes.includes('would delete feature "Second feature"; story "Their story" of product "Other" stays, no longer about it'));
    assert.ok(body.notes.includes('kept capability "Probe Cap": epic "Their epic" of product "Other" is about it'));
  });

  test("a slot of a stack that stays keeps its capability", async () => {
    use(probe());
    const [cap] = metis.capabilities;
    metis.stacks.push({ id: "stk2", name: "Other stack", product_id: metis.products[1].id, parent_id: null });
    metis.slots.push({ id: "sl2", stack_id: "stk2", role: "search", capability_id: cap.id, tech_id: null });
    const { body } = await unseed(probeSeed());
    assert.ok(body.notes.includes('kept capability "Probe Cap": slot "search" of stack "Other stack" of product "Other" answers it'));
  });

  test("the preview says a re-import gets new numbers", async () => {
    use(probe());
    const { body } = await unseed(probeSeed());
    const [goal] = metis.goals;
    assert.equal(body.notes[0], `Numbers are not kept: importing this file again adds these rows back under new numbers (${goal.display_id} would not come back as ${goal.display_id}).`);
  });

  test("an account that can't read guesses can't remove anything", async () => {
    use(probe());
    metis.guessesStatus = 403;
    const { status, body } = await unseed(probeSeed(), { dryRun: false });
    assert.equal(status, 403);
    assert.match(body.detail, /can't read guesses, so it can't tell which capabilities and technologies are safe to delete/);
    assert.deepEqual(metis.writes, []);
  });
});

describe("exporting a product carries its whole goal tree", () => {
  async function exportOf(productId) {
    const response = await exportGET({
      request: new Request(`http://app.test/api/seed/export?productId=${productId}`),
      locals: { accessToken: "test-token" },
    });
    assert.equal(response.status, 200);
    return (await response.json()).document;
  }

  function taskmaster() {
    const fake = new FakeMetis({
      capabilities: [{ name: "Chat Assistant" }, { name: "Team Directory" }, { name: "Unrelated" }],
      products: [{ name: "Taskmaster" }, { name: "Other" }],
    });
    const [chat, team, unrelated] = fake.capabilities;
    const [tm, other] = fake.products;
    fake.features.push({ id: "f-chat", product_id: tm.id, name: "Chat", capability_ids: [chat.id] });
    const org = fake.goal("Help teams", { product: tm });
    fake.link(org, chat);
    fake.link(fake.goal("Plan work", { parent: org, product: tm }), chat);
    fake.link(fake.goal("Know who can do it", { parent: org, product: tm }), team);
    tm.goal_id = org.id;
    const otherOrg = fake.goal("Other org goal", { product: other });
    fake.link(otherOrg, unrelated);
    other.goal_id = otherOrg.id;
    return fake;
  }

  test("sub-goals and every goal link they have travel with the product", async () => {
    use(taskmaster());
    const doc = await exportOf(metis.products[0].id);
    assert.deepEqual(doc.goals.map((g) => g.title).sort(), ["Help teams", "Know who can do it", "Plan work"]);
    assert.equal(doc.motivations.length, 3);
    assert.deepEqual(doc.capabilities.map((c) => c.name).sort(), ["Chat Assistant", "Team Directory"]);
    assert.deepEqual(validateSeed(doc), []);
  });

  test("removing with that export names every goal link it deletes", async () => {
    use(taskmaster());
    const doc = await exportOf(metis.products[0].id);
    const { body } = await postSeed(unseedPOST, doc);
    assert.deepEqual(body.notes.filter((n) => n.startsWith("would delete goal link")).sort(), [
      'would delete goal link "Help teams" → "Chat Assistant"',
      'would delete goal link "Know who can do it" → "Team Directory"',
      'would delete goal link "Plan work" → "Chat Assistant"',
    ]);
    assert.ok(!body.notes.some((n) => n.startsWith("kept goal")));
  });

  test("only the goals the backend says are the product's travel with it", async () => {
    // Before the website points into the org goal, all of it is Tagomoto's;
    // after, the org goal and its unclaimed goal are neither one's.
    const fake = use(new FakeMetis({ products: [{ name: "Tagomoto" }, { name: "Website" }] }));
    const [app, site] = fake.products;
    const org = fake.goal("Household org goal", { product: app });
    app.goal_id = fake.goal("Find items", { parent: org, product: app }).id;
    const keep = fake.goal("Keep inventory current", { parent: org, product: app });
    let doc = await exportOf(app.id);
    assert.deepEqual(doc.goals.map((g) => g.title).sort(), ["Find items", "Household org goal", "Keep inventory current"]);
    site.goal_id = fake.goal("Turn visitors into downloads", { parent: org, product: site }).id;
    org.product_id = null;
    keep.product_id = null;
    doc = await exportOf(app.id);
    assert.deepEqual(doc.goals.map((g) => g.title).sort(), ["Find items", "Household org goal"]);
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
