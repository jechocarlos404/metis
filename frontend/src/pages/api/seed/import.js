export const prerender = false;

const backend = () =>
  (process.env.API_INTERNAL_URL || "http://localhost:8000").replace(/\/$/, "");

const GOAL_TYPES = new Set(["org", "product"]);
const WORK_STATUSES = new Set(["pending", "in_progress", "done"]);
const MATURITIES = new Set(["planned", "alpha", "beta", "ga", "deprecated", "retired"]);
const EDGE_KINDS = new Set(["DEPENDS_ON", "BLOCKS", "RELATES_TO"]);
const CONTEXT_BUDGETS = new Set(["S", "M", "L"]);

function prune(payload) {
  return Object.fromEntries(
    Object.entries(payload).filter(([, value]) => value !== null && value !== undefined),
  );
}

function checkPriority(errors, where, item) {
  const p = item.priority;
  if (p != null && (!Number.isInteger(p) || p < 1 || p > 5)) {
    errors.push(`${where}: priority must be an integer 1-5`);
  }
}

function checkStatus(errors, where, item) {
  const s = item.status;
  if (s != null && !WORK_STATUSES.has(s)) {
    errors.push(`${where}: status must be one of ${JSON.stringify([...WORK_STATUSES].sort())}`);
  }
}

function checkFacets(errors, where, item) {
  const facets = item.facets;
  if (facets == null) return;
  const valid =
    typeof facets === "object" &&
    !Array.isArray(facets) &&
    Object.entries(facets).every(([k, v]) => typeof k === "string" && typeof v === "string");
  if (!valid) errors.push(`${where}: facets must be an object of string -> string`);
}

// Every capability ref a feature REALIZES. `capability_refs` (list) is current;
// a legacy single `capability_ref` reads as a one-element list.
function featureCapabilityRefs(feature) {
  if (feature.capability_refs != null) return feature.capability_refs;
  if (feature.capability_ref != null) return [feature.capability_ref];
  return null;
}

function validateSeed(doc) {
  const errors = [];
  if (doc.format !== "metis-seed/v1") {
    errors.push("'format' must be \"metis-seed/v1\"");
  }

  function checkRefs(collection) {
    const refs = new Set();
    for (const [i, item] of (doc[collection] || []).entries()) {
      const ref = item.ref;
      if (typeof ref !== "string" || ref.length === 0) {
        errors.push(`${collection}[${i}]: missing or non-string 'ref'`);
      } else if (refs.has(ref)) {
        errors.push(`${collection}: duplicate ref ${JSON.stringify(ref)}`);
      } else {
        refs.add(ref);
      }
    }
    return refs;
  }

  function checkParentForest(collection, refs) {
    const parents = new Map();
    for (const item of doc[collection] || []) {
      const ref = item.ref;
      const parent = item.parent_ref;
      if (parent != null) {
        if (!refs.has(parent)) errors.push(`${collection} ${JSON.stringify(ref)}: unknown parent_ref ${JSON.stringify(parent)}`);
        else if (parent === ref) errors.push(`${collection} ${JSON.stringify(ref)}: is its own parent`);
        else parents.set(ref, parent);
      }
    }
    for (const start of parents.keys()) {
      const seen = new Set();
      let node = start;
      while (parents.has(node)) {
        if (seen.has(node)) {
          errors.push(`${collection}: parent cycle involving ${JSON.stringify(node)}`);
          break;
        }
        seen.add(node);
        node = parents.get(node);
      }
    }
  }

  const goalRefs = checkRefs("goals");
  const capRefs = checkRefs("capabilities");
  const featureRefs = checkRefs("features");
  const productRefs = checkRefs("products");
  checkParentForest("goals", goalRefs);
  checkParentForest("capabilities", capRefs);

  for (const [i, goal] of (doc.goals || []).entries()) {
    const where = `goals[${i}] (${goal.ref})`;
    if (!GOAL_TYPES.has(goal.goal_type)) errors.push(`${where}: goal_type must be one of ${JSON.stringify([...GOAL_TYPES].sort())}`);
    if (!goal.title) errors.push(`${where}: 'title' is required`);
    checkPriority(errors, where, goal);
    checkStatus(errors, where, goal);
  }

  for (const [i, capability] of (doc.capabilities || []).entries()) {
    const where = `capabilities[${i}] (${capability.ref})`;
    if (!capability.name) errors.push(`${where}: 'name' is required`);
    if (capability.maturity != null && !MATURITIES.has(capability.maturity)) {
      errors.push(`${where}: maturity must be one of ${JSON.stringify([...MATURITIES].sort())}`);
    }
    checkFacets(errors, where, capability);
    const anchors = capability.evidence_anchors;
    if (anchors != null && (!Array.isArray(anchors) || anchors.some((a) => typeof a !== "string"))) {
      errors.push(`${where}: evidence_anchors must be a list of strings`);
    }
  }

  const seenMotivations = new Set();
  for (const [i, motivation] of (doc.motivations || []).entries()) {
    const where = `motivations[${i}]`;
    if (!goalRefs.has(motivation.goal_ref)) errors.push(`${where}: unknown goal_ref ${JSON.stringify(motivation.goal_ref)}`);
    if (!capRefs.has(motivation.capability_ref)) errors.push(`${where}: unknown capability_ref ${JSON.stringify(motivation.capability_ref)}`);
    const pair = `${motivation.goal_ref}:${motivation.capability_ref}`;
    if (seenMotivations.has(pair)) errors.push(`${where}: duplicate motivation ${pair}`);
    seenMotivations.add(pair);
  }

  for (const [i, feature] of (doc.features || []).entries()) {
    const where = `features[${i}] (${feature.ref})`;
    if (!feature.name) errors.push(`${where}: 'name' is required`);
    const refs = featureCapabilityRefs(feature);
    if (!Array.isArray(refs) || refs.length === 0) {
      errors.push(`${where}: capability_refs must be a non-empty list of capability refs`);
    } else {
      for (const ref of refs) {
        if (!capRefs.has(ref)) errors.push(`${where}: capability ref ${JSON.stringify(ref)} does not match a capability`);
      }
      if (new Set(refs.map(String)).size !== refs.length) {
        errors.push(`${where}: capability_refs lists a capability twice`);
      }
    }
    if (feature.product_ref != null && !productRefs.has(feature.product_ref)) {
      errors.push(`${where}: unknown product_ref ${JSON.stringify(feature.product_ref)}`);
    }
    checkPriority(errors, where, feature);
    checkStatus(errors, where, feature);
    checkFacets(errors, where, feature);
  }

  const seenEdges = new Set();
  const precedence = new Map();
  for (const [i, edge] of (doc.edges || []).entries()) {
    const where = `edges[${i}]`;
    const src = edge.src_ref;
    const dst = edge.dst_ref;
    const kind = edge.kind || "DEPENDS_ON";
    if (!featureRefs.has(src)) {
      errors.push(`${where}: unknown src_ref ${JSON.stringify(src)}`);
      continue;
    }
    if (!featureRefs.has(dst)) {
      errors.push(`${where}: unknown dst_ref ${JSON.stringify(dst)}`);
      continue;
    }
    if (!EDGE_KINDS.has(kind)) {
      errors.push(`${where}: kind must be one of ${JSON.stringify([...EDGE_KINDS].sort())}`);
      continue;
    }
    if (src === dst) {
      errors.push(`${where}: self-loop on ${JSON.stringify(src)}`);
      continue;
    }
    const key = `${src}:${dst}:${kind}`;
    if (seenEdges.has(key)) errors.push(`${where}: duplicate edge ${key}`);
    seenEdges.add(key);
    if (kind === "DEPENDS_ON") {
      precedence.set(src, new Set([...(precedence.get(src) || []), dst]));
    } else if (kind === "BLOCKS") {
      precedence.set(dst, new Set([...(precedence.get(dst) || []), src]));
    }
  }

  const state = new Map();
  let cycleFound = false;
  function dfs(node, trail) {
    state.set(node, "in");
    trail.push(node);
    for (const next of [...(precedence.get(node) || [])].sort()) {
      if (cycleFound) return;
      if (state.get(next) === "in") {
        const cycle = [...trail.slice(trail.indexOf(next)), next];
        errors.push(`edges: precedence cycle: ${cycle.join(" -> ")}`);
        cycleFound = true;
        return;
      }
      if (!state.has(next)) dfs(next, trail);
    }
    trail.pop();
    state.set(node, "done");
  }
  for (const ref of [...precedence.keys()].sort()) {
    if (!state.has(ref) && !cycleFound) dfs(ref, []);
  }

  for (const [i, product] of (doc.products || []).entries()) {
    const where = `products[${i}] (${product.ref})`;
    if (!product.name) errors.push(`${where}: 'name' is required`);
    if (product.goal_ref != null && !goalRefs.has(product.goal_ref)) {
      errors.push(`${where}: unknown goal_ref ${JSON.stringify(product.goal_ref)}`);
    }
    if (
      product.bundle_refs != null &&
      (!Array.isArray(product.bundle_refs) ||
        product.bundle_refs.some((ref) => typeof ref !== "string" || !capRefs.has(ref)))
    ) {
      errors.push(`${where}: bundle_refs must be capability refs`);
    }
    const decomp = product.decomposition;
    if (!decomp) continue;
    for (const [j, epic] of (decomp.epics || []).entries()) {
      const ewhere = `${where}.epics[${j}]`;
      if (!epic.title) errors.push(`${ewhere}: 'title' is required`);
      if (epic.capability_ref != null && !capRefs.has(epic.capability_ref)) {
        errors.push(`${ewhere}: unknown capability_ref ${JSON.stringify(epic.capability_ref)}`);
      }
      for (const [k, story] of (epic.stories || []).entries()) {
        const swhere = `${ewhere}.stories[${k}]`;
        if (!story.title) errors.push(`${swhere}: 'title' is required`);
        if (story.feature_ref != null && !featureRefs.has(story.feature_ref)) {
          errors.push(`${swhere}: unknown feature_ref ${JSON.stringify(story.feature_ref)}`);
        }
        for (const [t, ticket] of (story.tickets || []).entries()) {
          const twhere = `${swhere}.tickets[${t}]`;
          if (!ticket.title) errors.push(`${twhere}: 'title' is required`);
          if (ticket.context_budget != null && !CONTEXT_BUDGETS.has(ticket.context_budget)) {
            errors.push(`${twhere}: context_budget must be one of ${JSON.stringify([...CONTEXT_BUDGETS].sort())}`);
          }
          if (
            ticket.affected_files != null &&
            (!Array.isArray(ticket.affected_files) || ticket.affected_files.some((a) => typeof a !== "string"))
          ) {
            errors.push(`${twhere}: affected_files must be a list of strings`);
          }
        }
      }
    }
  }

  return errors;
}

function parentsFirst(items) {
  const done = new Set();
  const remaining = [...items];
  const ordered = [];
  while (remaining.length > 0) {
    let progressed = false;
    for (let i = 0; i < remaining.length; i += 1) {
      const item = remaining[i];
      const parent = item.parent_ref;
      if (parent == null || done.has(parent)) {
        ordered.push(item);
        done.add(item.ref);
        remaining.splice(i, 1);
        i -= 1;
        progressed = true;
      }
    }
    if (!progressed) throw new Error("unresolvable parent_ref ordering");
  }
  return ordered;
}


/** Feature identity: (product, name). A missing product is its own bucket. */
function featureKey(productId, name) {
  return `${productId ?? ""}\u0000${name}`;
}

class UpstreamApi {
  constructor(accessToken) {
    this.accessToken = accessToken;
  }

  async request(method, route, payload) {
    const res = await fetch(`${backend()}${route}`, {
      method,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.accessToken}`,
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    const text = await res.text();
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    return { status: res.status, body };
  }

  async get(route) {
    const { status, body } = await this.request("GET", route);
    if (status !== 200) {
      throw new Error(`GET ${route} returned ${status}: ${JSON.stringify(body)}`);
    }
    return body;
  }

  async post(route, payload) {
    return this.request("POST", route, payload);
  }
}

class Loader {
  constructor(api, doc, dryRun) {
    this.api = api;
    this.doc = doc;
    this.dryRun = dryRun;
    this.counts = {};
    this.notes = [];
    this.warnings = [];
    this.goalIds = new Map();
    this.capIds = new Map();
    this.featureIds = new Map();
    this.productIds = new Map();
  }

  note(collection, action) {
    const key = `${collection}:${action}`;
    this.counts[key] = (this.counts[key] || 0) + 1;
  }

  count(collection) {
    return Object.fromEntries(
      Object.entries(this.counts)
        .filter(([key]) => key.startsWith(`${collection}:`))
        .map(([key, value]) => [key.split(":")[1], value]),
    );
  }

  async create(collection, route, payload, label) {
    if (this.dryRun) {
      this.note(collection, "would create");
      return `dry-run:${collection}:${label}`;
    }
    const { status, body } = await this.api.post(route, prune(payload));
    if (status !== 201) {
      throw new Error(`POST ${route} for ${label} returned ${status}: ${JSON.stringify(body)}`);
    }
    this.note(collection, "created");
    return body.id;
  }

  async loadGoals() {
    const existing = new Map(
      (await this.api.get("/api/goals")).map((goal) => [`${goal.goal_type}:${goal.title}`, goal.id]),
    );
    for (const goal of parentsFirst(this.doc.goals || [])) {
      const key = `${goal.goal_type}:${goal.title}`;
      if (existing.has(key)) {
        this.goalIds.set(goal.ref, existing.get(key));
        this.note("goals", "reused");
        continue;
      }
      this.goalIds.set(
        goal.ref,
        await this.create("goals", "/api/goals", {
          goal_type: goal.goal_type,
          parent_goal_id: this.goalIds.get(goal.parent_ref),
          title: goal.title,
          description: goal.description,
          success_criteria: goal.success_criteria,
          priority: goal.priority,
          status: goal.status,
        }, goal.title),
      );
    }
  }

  async loadCapabilities() {
    const existing = new Map(
      (await this.api.get("/api/capabilities")).map((capability) => [capability.name, capability.id]),
    );
    for (const capability of parentsFirst(this.doc.capabilities || [])) {
      if (existing.has(capability.name)) {
        this.capIds.set(capability.ref, existing.get(capability.name));
        this.note("capabilities", "reused");
        continue;
      }
      this.capIds.set(
        capability.ref,
        await this.create("capabilities", "/api/capabilities", {
          parent_id: this.capIds.get(capability.parent_ref),
          name: capability.name,
          description: capability.description,
          maturity: capability.maturity,
          facets: capability.facets,
          evidence_anchors: capability.evidence_anchors,
        }, capability.name),
      );
    }
  }

  async loadMotivations() {
    const byCapability = new Map();
    for (const motivation of this.doc.motivations || []) {
      const bucket = byCapability.get(motivation.capability_ref) || [];
      bucket.push(motivation.goal_ref);
      byCapability.set(motivation.capability_ref, bucket);
    }
    for (const [capRef, goalRefs] of [...byCapability.entries()].sort()) {
      const capabilityId = this.capIds.get(capRef);
      let existing = new Set();
      if (!String(capabilityId).startsWith("dry-run:")) {
        existing = new Set(
          (await this.api.get(`/api/capabilities/${capabilityId}/motivations`)).map((goal) => goal.id),
        );
      }
      for (const goalRef of goalRefs) {
        const goalId = this.goalIds.get(goalRef);
        if (existing.has(goalId)) {
          this.note("motivations", "reused");
        } else if (this.dryRun) {
          this.note("motivations", "would create");
        } else {
          const { status, body } = await this.api.post(
            `/api/capabilities/${capabilityId}/motivations`,
            { goal_id: goalId },
          );
          if (status !== 201) {
            throw new Error(`motivation ${goalRef} -> ${capRef} returned ${status}: ${JSON.stringify(body)}`);
          }
          this.note("motivations", "created");
        }
      }
    }
  }

  async loadFeatures() {
    // Add-only: an existing feature keeps its capability links as they are —
    // the importer never rewrites a row. Identity is (product, name): another
    // product's "Sign in" is a different feature, not a reuse.
    const existing = new Map(
      (await this.api.get("/api/features")).map((feature) => [featureKey(feature.product_id, feature.name), feature.id]),
    );
    for (const feature of this.doc.features || []) {
      const key = featureKey(this.productIds.get(feature.product_ref), feature.name);
      if (existing.has(key)) {
        this.featureIds.set(feature.ref, existing.get(key));
        this.note("features", "reused");
        continue;
      }
      this.featureIds.set(
        feature.ref,
        await this.create("features", "/api/features", {
          capability_ids: featureCapabilityRefs(feature).map((ref) => this.capIds.get(ref)),
          product_id: this.productIds.get(feature.product_ref),
          name: feature.name,
          description: feature.description,
          facets: feature.facets,
          status: feature.status,
          priority: feature.priority,
          priority_rationale: feature.priority_rationale,
        }, feature.name),
      );
    }
  }

  async loadEdges() {
    const existing = new Set(
      (await this.api.get("/api/features/edges")).map((edge) => `${edge.src_id}:${edge.dst_id}:${edge.kind}`),
    );
    for (const edge of this.doc.edges || []) {
      const kind = edge.kind || "DEPENDS_ON";
      const src = this.featureIds.get(edge.src_ref);
      const dst = this.featureIds.get(edge.dst_ref);
      const key = `${src}:${dst}:${kind}`;
      const label = `${edge.src_ref} -${kind}-> ${edge.dst_ref}`;
      if (existing.has(key)) {
        this.note("edges", "reused");
        continue;
      }
      if (this.dryRun) {
        this.note("edges", "would create");
        continue;
      }
      const { status, body } = await this.api.post("/api/features/edges", {
        src_id: src,
        dst_id: dst,
        kind,
      });
      if (status === 201) {
        this.note("edges", "created");
      } else {
        this.warnings.push(`edge ${label} rejected (${status}): ${JSON.stringify(body)}`);
        this.note("edges", "rejected");
      }
    }
  }

  buildPrd(decomposition) {
    return prune({
      summary: decomposition.summary,
      epics: (decomposition.epics || []).map((epic) => prune({
        title: epic.title,
        acceptance_criteria: epic.acceptance_criteria,
        capability_id: this.capIds.get(epic.capability_ref),
        stories: (epic.stories || []).map((story) => prune({
          title: story.title,
          description: story.description,
          feature_id: this.featureIds.get(story.feature_ref),
          tickets: (story.tickets || []).map((ticket) => prune({
            title: ticket.title,
            description: ticket.description,
            technical_approach: ticket.technical_approach,
            acceptance_criteria: ticket.acceptance_criteria,
            affected_files: ticket.affected_files,
            context_budget: ticket.context_budget,
          })),
        })),
      })),
    });
  }

  // Products before features: a feature's product_ref needs the id.
  async loadProductRows() {
    const existing = new Map(
      (await this.api.get("/api/products")).map((product) => [product.name, product.id]),
    );
    for (const product of this.doc.products || []) {
      let productId = existing.get(product.name);
      if (productId != null) {
        this.note("products", "reused");
      } else {
        productId = await this.create("products", "/api/products", {
          goal_id: this.goalIds.get(product.goal_ref),
          name: product.name,
          summary: product.summary,
          body: product.body,
        }, product.name);
      }
      this.productIds.set(product.ref, productId);
    }
  }

  // Bundles and PRDs, once features exist for stories to pin.
  async loadProducts() {
    for (const product of this.doc.products || []) {
      const productId = this.productIds.get(product.ref);
      const decomposition = product.decomposition;
      for (const capabilityRef of product.bundle_refs || []) {
        const capabilityId = this.capIds.get(capabilityRef);
        const existing = await this.api.get(`/api/products/${productId}/bundles`);
        if (existing.some((cap) => cap.id === capabilityId)) {
          this.note("bundles", "reused");
        } else if (this.dryRun) {
          this.note("bundles", "would create");
        } else {
          const { status, body } = await this.api.post(`/api/products/${productId}/bundles`, {
            capability_id: capabilityId,
          });
          if (status !== 201) {
            throw new Error(`bundle ${capabilityRef} for ${product.name} returned ${status}: ${JSON.stringify(body)}`);
          }
          this.note("bundles", "created");
        }
      }
      if (!decomposition) continue;
      if (String(productId).startsWith("dry-run:")) {
        this.note("decompositions", "would create");
        continue;
      }
      if ((await this.api.get(`/api/products/${productId}/decompositions`)).length > 0) {
        this.notes.push(
          `product "${product.name}" already has a PRD; left as-is (the importer never stacks a second decomposition)`,
        );
        this.note("decompositions", "skipped");
        continue;
      }
      if (this.dryRun) {
        this.note("decompositions", "would create");
        continue;
      }
      const { status, body } = await this.api.post(
        `/api/products/${productId}/decompositions`,
        { document: this.buildPrd(decomposition), created_by: "seed-import-ui" },
      );
      if (status !== 201) {
        throw new Error(`decomposition for ${product.name} returned ${status}: ${JSON.stringify(body)}`);
      }
      this.note("decompositions", "created");
    }
  }

  async run() {
    await this.loadGoals();
    await this.loadCapabilities();
    await this.loadMotivations();
    await this.loadProductRows();
    await this.loadFeatures();
    await this.loadEdges();
    await this.loadProducts();
    return {
      dryRun: this.dryRun,
      counts: {
        goals: this.count("goals"),
        capabilities: this.count("capabilities"),
        motivations: this.count("motivations"),
        features: this.count("features"),
        edges: this.count("edges"),
        products: this.count("products"),
        bundles: this.count("bundles"),
        decompositions: this.count("decompositions"),
      },
      notes: this.notes,
      warnings: this.warnings,
    };
  }
}

export async function POST({ request, locals }) {
  if (!locals.accessToken) {
    return new Response(JSON.stringify({ detail: "Not authenticated" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return new Response(JSON.stringify({ detail: "Invalid JSON request body" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const documentText = payload?.document;
  const dryRun = payload?.dryRun !== false;
  if (typeof documentText !== "string" || documentText.trim() === "") {
    return new Response(JSON.stringify({ detail: "Seed document is required" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  let doc;
  try {
    doc = JSON.parse(documentText);
  } catch {
    return new Response(JSON.stringify({ detail: "Seed document must be valid JSON" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const validationErrors = validateSeed(doc);
  if (validationErrors.length > 0) {
    return new Response(JSON.stringify({ detail: validationErrors.join("\n") }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  try {
    const result = await new Loader(new UpstreamApi(locals.accessToken), doc, dryRun).run();
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({ detail: String(error.message || error) }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
}
