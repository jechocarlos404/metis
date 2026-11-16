export const prerender = false;

const backend = () =>
  (process.env.API_INTERNAL_URL || "http://localhost:8000").replace(/\/$/, "");

class UpstreamApi {
  constructor(accessToken) {
    this.accessToken = accessToken;
  }

  async request(method, route, payload) {
    const res = await fetch(`${backend()}${route}`, {
      method,
      headers: {
        authorization: `Bearer ${this.accessToken}`,
        "content-type": "application/json",
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

  async delete(route) {
    return this.request("DELETE", route);
  }
}

class Unseeder {
  constructor(api, doc, dryRun) {
    this.api = api;
    this.doc = doc;
    this.dryRun = dryRun;
    this.counts = {};
    this.notes = [];
    this.warnings = [];
  }

  async init() {
    this.instGoals = await this.api.get("/api/goals");
    this.instCaps = await this.api.get("/api/capabilities");
    this.instFeatures = await this.api.get("/api/features");
    this.instEdges = await this.api.get("/api/features/edges");
    this.instProducts = await this.api.get("/api/products");

    this.goals = this.match(
      "goals",
      (goal) => `${goal.goal_type}:${goal.title}`,
      new Map(this.instGoals.map((goal) => [`${goal.goal_type}:${goal.title}`, goal])),
    );
    this.caps = this.match(
      "capabilities",
      (capability) => capability.name,
      new Map(this.instCaps.map((capability) => [capability.name, capability])),
    );
    this.products = this.match(
      "products",
      (product) => product.name,
      new Map(this.instProducts.map((product) => [product.name, product])),
    );
    // A feature is its product's: identity is (product, name), so two products
    // may each have a "Sign in" without one unseed taking both.
    const featureKey = (productId, name) => `${productId ?? ""}\u0000${name}`;
    this.features = this.match(
      "features",
      (feature) => featureKey(this.products.get(feature.product_ref)?.id, feature.name),
      new Map(this.instFeatures.map((feature) => [featureKey(feature.product_id, feature.name), feature])),
    );
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

  match(collection, keyFn, existing) {
    const matched = new Map();
    for (const item of this.doc[collection] || []) {
      const found = existing.get(keyFn(item));
      if (!found) {
        this.note(collection, "absent");
      } else if (item.ref) {
        matched.set(item.ref, found);
      }
    }
    return matched;
  }

  keep(collection, label, reasons) {
    this.note(collection, "kept");
    this.warnings.push(`kept ${label}: ${reasons.join("; ")}`);
  }

  async remove(collection, route, label) {
    if (this.dryRun) {
      this.note(collection, "would delete");
      this.notes.push(`would delete ${label}`);
      return;
    }
    const { status, body } = await this.api.delete(route);
    if (status === 204) {
      this.note(collection, "deleted");
      this.notes.push(`deleted ${label}`);
    } else if (status === 404) {
      this.note(collection, "absent");
    } else {
      this.note(collection, "failed");
      this.warnings.push(`${label}: DELETE returned ${status}: ${JSON.stringify(body)}`);
    }
  }

  deletableCaps() {
    const matchedCapIds = new Set([...this.caps.values()].map((cap) => cap.id));
    const matchedFeatureIds = new Set([...this.features.values()].map((feature) => feature.id));
    const children = new Map();
    const featuresOf = new Map();
    for (const cap of this.instCaps) {
      const bucket = children.get(cap.parent_id) || [];
      bucket.push(cap);
      children.set(cap.parent_id, bucket);
    }
    for (const feature of this.instFeatures) {
      for (const capabilityId of feature.capability_ids || []) {
        const bucket = featuresOf.get(capabilityId) || [];
        bucket.push(feature);
        featuresOf.set(capabilityId, bucket);
      }
    }

    const verdict = new Map();
    const check = (cap) => {
      if (verdict.has(cap.id)) return verdict.get(cap.id);
      const reasons = [];
      const foreignFeatures = (featuresOf.get(cap.id) || []).filter(
        (feature) => !matchedFeatureIds.has(feature.id),
      );
      if (foreignFeatures.length > 0) {
        reasons.push(`${foreignFeatures.length} feature(s) outside the seed realize it`);
      }
      for (const child of children.get(cap.id) || []) {
        if (!matchedCapIds.has(child.id)) reasons.push(`child capability ${JSON.stringify(child.name)} is not in the seed`);
        else if (!check(child)) reasons.push(`child capability ${JSON.stringify(child.name)} is kept`);
      }
      const ok = reasons.length === 0;
      verdict.set(cap.id, ok);
      if (!ok) this.keep("capabilities", `capability ${JSON.stringify(cap.name)}`, reasons);
      return ok;
    };

    const byId = new Map(this.instCaps.map((cap) => [cap.id, cap]));
    const depth = (cap) => {
      let d = 0;
      let node = cap;
      while (node.parent_id && byId.has(node.parent_id)) {
        d += 1;
        node = byId.get(node.parent_id);
      }
      return d;
    };

    return [...this.caps.values()].filter(check).sort((a, b) => depth(b) - depth(a));
  }

  // Matched product id -> number of features outside the seed that belong to
  // it. Deleting such a product would silently orphan them (product_id SET
  // NULL), so it is shared state and kept.
  foreignFeatureCounts() {
    const matchedFeatureIds = new Set([...this.features.values()].map((feature) => feature.id));
    const matchedProductIds = new Set([...this.products.values()].map((product) => product.id));
    const counts = new Map();
    for (const feature of this.instFeatures) {
      const productId = feature.product_id;
      if (matchedProductIds.has(productId) && !matchedFeatureIds.has(feature.id)) {
        counts.set(productId, (counts.get(productId) || 0) + 1);
      }
    }
    return counts;
  }

  deletableGoals() {
    const matchedGoalIds = new Set([...this.goals.values()].map((goal) => goal.id));
    // Products kept for their foreign features count as foreign here too.
    const keptProducts = this.foreignFeatureCounts();
    const matchedProductIds = new Set(
      [...this.products.values()].map((product) => product.id).filter((id) => !keptProducts.has(id)),
    );
    const children = new Map();
    for (const goal of this.instGoals) {
      const bucket = children.get(goal.parent_goal_id) || [];
      bucket.push(goal);
      children.set(goal.parent_goal_id, bucket);
    }

    const verdict = new Map();
    const check = (goal) => {
      if (verdict.has(goal.id)) return verdict.get(goal.id);
      const reasons = [];
      for (const child of children.get(goal.id) || []) {
        if (!matchedGoalIds.has(child.id)) reasons.push(`child goal ${JSON.stringify(child.title)} is not in the seed`);
        else if (!check(child)) reasons.push(`child goal ${JSON.stringify(child.title)} is kept`);
      }
      const foreignProducts = this.instProducts.filter(
        (product) => product.goal_id === goal.id && !matchedProductIds.has(product.id),
      );
      for (const product of foreignProducts) {
        reasons.push(`product ${JSON.stringify(product.name)} outside the seed points at it`);
      }
      const ok = reasons.length === 0;
      verdict.set(goal.id, ok);
      if (!ok) this.keep("goals", `goal ${JSON.stringify(goal.title)}`, reasons);
      return ok;
    };

    const byId = new Map(this.instGoals.map((goal) => [goal.id, goal]));
    const depth = (goal) => {
      let d = 0;
      let node = goal;
      while (node.parent_goal_id && byId.has(node.parent_goal_id)) {
        d += 1;
        node = byId.get(node.parent_goal_id);
      }
      return d;
    };

    return [...this.goals.values()].filter(check).sort((a, b) => depth(b) - depth(a));
  }

  /** Rows the capability/goal passes will delete, computed once — the
   * deletable* checks record keep-warnings, so they must not run twice. */
  deadRows(kind) {
    this.deadCache ??= {};
    this.deadCache[kind] ??= kind === "caps" ? this.deletableCaps() : this.deletableGoals();
    return this.deadCache[kind];
  }

  dead(kind) {
    return new Set(this.deadRows(kind).map((row) => row.id));
  }

  async removeMotivations() {
    for (const motivation of this.doc.motivations || []) {
      const goal = this.goals.get(motivation.goal_ref);
      const cap = this.caps.get(motivation.capability_ref);
      if (!goal || !cap) {
        this.note("motivations", "absent");
        continue;
      }
      const existing = new Set(
        (await this.api.get(`/api/capabilities/${cap.id}/motivations`)).map((item) => item.id),
      );
      if (!existing.has(goal.id)) {
        this.note("motivations", "absent");
        continue;
      }
      // Both ends survive: the pair is someone else's too (another product's
      // seed motivated the same capability by the same goal).
      if (!this.dead("caps").has(cap.id) && !this.dead("goals").has(goal.id)) {
        this.note("motivations", "kept");
        continue;
      }
      await this.remove(
        "motivations",
        `/api/capabilities/${cap.id}/motivations/${goal.id}`,
        `motivation ${JSON.stringify(goal.title)} -> ${JSON.stringify(cap.name)}`,
      );
    }
  }

  async removeEdges() {
    const byKey = new Map(
      this.instEdges.map((edge) => [`${edge.src_id}:${edge.dst_id}:${edge.kind}`, edge]),
    );
    for (const edge of this.doc.edges || []) {
      const kind = edge.kind || "DEPENDS_ON";
      const src = this.features.get(edge.src_ref);
      const dst = this.features.get(edge.dst_ref);
      const inst = src && dst ? byKey.get(`${src.id}:${dst.id}:${kind}`) : null;
      if (!inst) {
        this.note("edges", "absent");
        continue;
      }
      await this.remove(
        "edges",
        `/api/features/edges/${inst.id}`,
        `edge ${JSON.stringify(src.name)} -${kind}-> ${JSON.stringify(dst.name)}`,
      );
    }
  }

  async removeProducts() {
    const foreign = this.foreignFeatureCounts();
    for (const product of this.products.values()) {
      if (foreign.has(product.id)) {
        this.keep("products", `product ${JSON.stringify(product.name)}`, [
          `${foreign.get(product.id)} feature(s) outside the seed belong to it`,
        ]);
        continue;
      }
      await this.remove(
        "products",
        `/api/products/${product.id}`,
        `product ${JSON.stringify(product.name)} (cascades its PRD and work items)`,
      );
    }
  }

  async removeFeatures() {
    const matchedIds = new Set([...this.features.values()].map((feature) => feature.id));
    const names = new Map(this.instFeatures.map((feature) => [feature.id, feature.name]));
    for (const edge of this.instEdges) {
      const srcIn = matchedIds.has(edge.src_id);
      const dstIn = matchedIds.has(edge.dst_id);
      if (srcIn !== dstIn) {
        this.notes.push(
          `edge ${JSON.stringify(names.get(edge.src_id))} -${edge.kind}-> ${JSON.stringify(names.get(edge.dst_id))} crosses the seed boundary; it goes away with the deleted endpoint`,
        );
      }
    }
    for (const feature of this.features.values()) {
      await this.remove("features", `/api/features/${feature.id}`, `feature ${JSON.stringify(feature.name)}`);
    }
  }

  async removeCaps() {
    for (const cap of this.deadRows("caps")) {
      await this.remove("capabilities", `/api/capabilities/${cap.id}`, `capability ${JSON.stringify(cap.name)}`);
    }
  }

  async removeGoals() {
    for (const goal of this.deadRows("goals")) {
      await this.remove("goals", `/api/goals/${goal.id}`, `goal ${JSON.stringify(goal.title)}`);
    }
  }

  async run() {
    await this.init();
    await this.removeMotivations();
    await this.removeEdges();
    await this.removeProducts();
    await this.removeFeatures();
    await this.removeCaps();
    await this.removeGoals();
    return {
      dryRun: this.dryRun,
      counts: {
        motivations: this.count("motivations"),
        edges: this.count("edges"),
        products: this.count("products"),
        features: this.count("features"),
        capabilities: this.count("capabilities"),
        goals: this.count("goals"),
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

  try {
    const result = await new Unseeder(new UpstreamApi(locals.accessToken), doc, dryRun).run();
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
