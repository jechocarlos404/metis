export const prerender = false;

import { EDGE, andList, count, slugify } from "../../../lib/words.js";
import { checkKeys } from "./import.js";

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

  /** For endpoints an older instance may not have yet: a 404 reads as none.
   * Any other refusal is null, so the caller can say it couldn't tell. */
  async getOptional(route) {
    const { status, body } = await this.request("GET", route);
    if (status === 200) return body;
    return status === 404 ? [] : null;
  }

  async delete(route) {
    return this.request("DELETE", route);
  }
}

/** The importer's technology identity: explicit slug, else the backend's slug
 * rule applied to the name. */
function techSlug(tech) {
  if (tech.slug != null) return tech.slug;
  return slugify(tech.name);
}

/** The importer's capability identity: the explicit slug, then the slug the
 * name derives, then that derived slug against each row's current name (a
 * rename keeps the old slug), preferring the row with exactly that name. */
function capabilityResolver(instance) {
  const bySlug = new Map(instance.map((capability) => [capability.slug, capability]));
  const byName = new Map();
  for (const capability of instance) {
    const key = slugify(capability.name);
    byName.set(key, [...(byName.get(key) || []), capability]);
  }
  return (capability) => {
    if (capability.slug != null && bySlug.has(capability.slug)) return bySlug.get(capability.slug);
    const derived = slugify(capability.name);
    if (bySlug.has(derived)) return bySlug.get(derived);
    const rows = byName.get(derived) || [];
    return rows.find((row) => row.name === capability.name) ?? rows[0];
  };
}

/** "1 feature outside the seed realizes it", "2 features … realize it". */
const agree = (n, one, many) => (n === 1 ? one : many);
/** A cost someone scored on a technology's link. No seed file carries one. */
const hasCost = (sat) => Object.keys(sat.cost || {}).length > 0;
const linkLabel = (src, kind, dst) => `link ${JSON.stringify(src)} ${EDGE[kind] ?? kind} ${JSON.stringify(dst)}`;

class Unseeder {
  constructor(api, doc, dryRun) {
    this.api = api;
    this.doc = doc;
    this.dryRun = dryRun;
    this.counts = {};
    this.notes = [];
    this.warnings = [];
    this.unreadable = [];
  }

  /** A list an older instance may lack (404: none), or this account may not
   * read (guesses are editor-only). Unreadable, it is recorded: a dry run
   * then can't tell what it would keep, and a real run refuses. */
  async optional(route, what) {
    const rows = await this.api.getOptional(route);
    if (rows === null && !this.unreadable.includes(what)) this.unreadable.push(what);
    return rows ?? [];
  }

  async init() {
    this.instGoals = await this.api.get("/api/goals");
    this.instCaps = await this.api.get("/api/capabilities");
    this.instFeatures = await this.api.get("/api/features");
    this.instEdges = await this.api.get("/api/features/edges");
    this.instProducts = await this.api.get("/api/products");
    // Goal links and hand-added capabilities: a capability's delete cascades
    // both, so each one is either in the file or holds its row back.
    this.instMotivations = await this.api.get("/api/motivations");
    this.instBundles = await this.api.get("/api/product-bundles");
    // Buy-side supply and guesses. A satisfaction or guess the seed did not
    // declare was recorded by someone else: shared state, like a foreign
    // feature.
    this.instSats = await this.optional("/api/tech/satisfactions", "technology links");
    this.instGuesses = await this.optional("/api/guesses", "guesses");
    this.instTechs = [];
    for (let offset = 0; ; offset += 200) {
      const { status, body } = await this.api.request("GET", `/api/tech?limit=200&offset=${offset}`);
      // Absent (404) is none; any other failure is a list this run can't read.
      if (status !== 200 && status !== 404 && !this.unreadable.includes("technologies")) this.unreadable.push("technologies");
      if (status !== 200) break;
      this.instTechs.push(...body.rows);
      if (offset + 200 >= body.total || body.rows.length === 0) break;
    }

    this.goals = this.match(
      "goals",
      (goal) => `${goal.goal_type}:${goal.title}`,
      new Map(this.instGoals.map((goal) => [`${goal.goal_type}:${goal.title}`, goal])),
    );
    const resolveCapability = capabilityResolver(this.instCaps);
    this.caps = this.match(
      "capabilities",
      (capability) => resolveCapability(capability)?.id,
      new Map(this.instCaps.map((capability) => [capability.id, capability])),
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
    this.techs = this.match(
      "technologies",
      techSlug,
      new Map(this.instTechs.map((tech) => [tech.slug, tech])),
    );
    // Usage, read now: deleting a product cascades its usage rows, which its
    // line names, and the technology guard runs after. Every product's, since
    // another product's use can name a slot of a stack that goes.
    this.instUsage = new Map();
    for (const product of this.instProducts) {
      this.instUsage.set(product.id, await this.optional(`/api/stacks/usage?product_id=${product.id}`, "technology use"));
    }
    await this.readAttached();
    // (tech, capability) pairs the seed itself declares, confirmed or
    // guessed: removing those is undoing the seed, not foreign data.
    this.declared = new Set();
    for (const tech of this.doc.technologies || []) {
      const found = this.techs.get(tech.ref);
      for (const link of tech.satisfies || []) {
        const cap = this.caps.get(link.capability_ref);
        if (found && cap) this.declared.add(`${found.id}:${cap.id}`);
      }
    }
    // Goal links the instance has that the file does not declare, on a goal
    // or capability the file names. Someone else made them: each keeps both
    // of its ends, so no delete cascades into one unlisted.
    const declaredLinks = new Set();
    for (const motivation of this.doc.motivations || []) {
      const goal = this.goals.get(motivation.goal_ref);
      const cap = this.caps.get(motivation.capability_ref);
      if (goal && cap) declaredLinks.add(`${goal.id}:${cap.id}`);
    }
    const goalIds = new Set([...this.goals.values()].map((goal) => goal.id));
    const capIds = new Set([...this.caps.values()].map((cap) => cap.id));
    this.foreignLinks = this.instMotivations.filter(
      (link) =>
        !declaredLinks.has(`${link.goal_id}:${link.capability_id}`) &&
        (goalIds.has(link.goal_id) || capIds.has(link.capability_id)),
    );

    if (this.unreadable.length > 0) {
      const what = this.unreadable.join(" or ");
      if (!this.dryRun) {
        throw Object.assign(new Error(
          `This account can't read ${what}, so it can't tell which capabilities and technologies are safe to delete. Nothing was removed.`,
        ), { status: 403 });
      }
      this.notes.push(
        `This account can't read ${what}${this.unreadable.includes("guesses") ? " (guesses need an editor or admin)" : ""}. ` +
          `Those can keep a capability or technology, so where the removal depends on them this preview says "can't tell" instead of "would delete".`,
      );
    }
  }

  /** Rows no seed file carries that hang off what a removal deletes: plans,
   * stacks, journeys, constraints, and what people recorded about a
   * technology. Each one either keeps its row or is named on its line. Read
   * across the whole instance: another product's epic, slot or journey step
   * can point at a row the seed made. */
  async readAttached() {
    this.instStacks = await this.optional("/api/stacks", "stacks");
    this.instSlots = [];
    this.instAnswers = [];
    for (const stack of this.instStacks) {
      const view = await this.api.getOptional(`/api/stacks/${stack.id}`);
      if (view === null && !this.unreadable.includes("stacks")) this.unreadable.push("stacks");
      this.instSlots.push(...(view?.slots || []));
      this.instAnswers.push(...await this.optional(`/api/stacks/${stack.id}/concerns`, "stacks"));
    }
    this.instScopes = [];
    for (const constraint of await this.optional("/api/constraints", "constraints")) {
      const scopes = await this.optional(`/api/constraints/${constraint.id}/scopes`, "constraints");
      this.instScopes.push(...scopes.map((scope) => ({ ...scope, constraint_name: constraint.name })));
    }
    this.instJourneys = await this.optional("/api/journeys", "journeys");
    this.instTickets = await this.optional("/api/tickets", "plans");
    this.instEpics = [];
    for (const product of this.instProducts) {
      this.instEpics.push(...await this.optional(`/api/products/${product.id}/epics`, "plans"));
    }
    this.instPlans = new Map();
    this.instStrategies = new Map();
    for (const product of this.products.values()) {
      this.instPlans.set(product.id, await this.optional(`/api/products/${product.id}/decompositions`, "plans"));
      this.instStrategies.set(product.id, await this.optional(`/api/products/${product.id}/strategies`, "plans"));
    }
    // Who used each technology, its versions and its links to other
    // technologies are on its own page only, so every one is read.
    this.instTechDetail = new Map();
    for (const tech of this.instTechs) {
      const detail = await this.api.getOptional(`/api/tech/${encodeURIComponent(tech.slug)}`);
      if (detail === null && !this.unreadable.includes("technologies")) this.unreadable.push("technologies");
      if (detail && !Array.isArray(detail)) this.instTechDetail.set(tech.id, detail);
    }
  }

  /** Matched products that go: one a feature outside the seed belongs to stays. */
  deadProductIds() {
    const foreign = this.foreignFeatureCounts();
    return new Set([...this.products.values()].map((product) => product.id).filter((id) => !foreign.has(id)));
  }

  productName(productId) {
    return this.instProducts.find((product) => product.id === productId)?.name ?? productId;
  }

  /** Stacks that go with their product. */
  deadStackIds() {
    const deadProducts = this.deadProductIds();
    return new Set(this.instStacks.filter((stack) => deadProducts.has(stack.product_id)).map((stack) => stack.id));
  }

  /** Slots of stacks that stay: each holds its technology and capability. */
  liveSlots() {
    const deadStacks = this.deadStackIds();
    return this.instSlots.filter((slot) => !deadStacks.has(slot.stack_id));
  }

  slotLabel(slot) {
    const stack = this.instStacks.find((row) => row.id === slot.stack_id);
    const owner = stack?.product_id ? ` of product ${JSON.stringify(this.productName(stack.product_id))}` : "";
    return `slot ${JSON.stringify(slot.role)} of stack ${JSON.stringify(stack?.name ?? slot.stack_id)}${owner}`;
  }

  /** Epics that stay: another product's plan, pinned to a capability. */
  liveEpics() {
    const deadProducts = this.deadProductIds();
    return this.instEpics.filter((epic) => !deadProducts.has(epic.product_id));
  }

  note(collection, action, n = 1) {
    const key = `${collection}:${action}`;
    this.counts[key] = (this.counts[key] || 0) + n;
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

  /** Kept is the designed outcome for shared rows: listed with its reasons,
   * not a warning. */
  keep(collection, label, reasons) {
    this.note(collection, "kept");
    this.notes.push(`kept ${label}: ${reasons.join("; ")}`);
  }

  /** `unsure`: the delete depends on a capability or technology that a list
   * this account can't read might keep. A dry run then says so instead of
   * claiming it. `cascades`: rows of other kinds the delete takes with it,
   * already counted on its line, counted under their own kind too, so the
   * summary counts each kind the way the import does. */
  async remove(collection, route, label, unsure = false, cascades = {}) {
    const tally = (action) => {
      this.note(collection, action);
      for (const [kind, n] of Object.entries(cascades)) if (n > 0) this.note(kind, action, n);
    };
    if (this.dryRun) {
      if (unsure && this.unreadable.length > 0) {
        tally("can't tell");
        this.notes.push(`can't tell whether ${label} goes`);
        return;
      }
      tally("would delete");
      this.notes.push(`would delete ${label}`);
      return;
    }
    const { status, body } = await this.api.delete(route);
    if (status === 204) {
      tally("deleted");
      this.notes.push(`deleted ${label}`);
    } else if (status === 404) {
      this.note(collection, "absent");
    } else {
      this.note(collection, "failed");
      this.warnings.push(`${label}: DELETE returned ${status}: ${JSON.stringify(body)}`);
    }
  }

  goalName(goalId) {
    const goal = this.instGoals.find((row) => row.id === goalId);
    return goal ? `${goal.display_id ? `${goal.display_id} ` : ""}${JSON.stringify(goal.title)}` : goalId;
  }

  deletableTechs() {
    const foreign = this.foreignFeatureCounts();
    const seedUsers = new Map(); // tech id -> how many deleted seed products use it
    for (const product of this.products.values()) {
      if (foreign.has(product.id)) continue;
      for (const row of this.instUsage.get(product.id) || []) {
        seedUsers.set(row.tech_id, (seedUsers.get(row.tech_id) || 0) + 1);
      }
    }
    const capNames = new Map(this.instCaps.map((cap) => [cap.id, cap.name]));
    const techNames = new Map(this.instTechs.map((tech) => [tech.id, tech.name]));
    const deletable = [];
    for (const tech of this.techs.values()) {
      const reasons = [];
      const others = (tech.used_by || 0) - (seedUsers.get(tech.id) || 0);
      if (others > 0) reasons.push(`${count(others, "product")} outside the seed ${agree(others, "uses", "use")} it`);
      if (tech.adoption) reasons.push(`it has an adoption stance (${tech.adoption})`);
      const links = [
        ...this.instSats.filter((s) => s.tech_id === tech.id).map((s) => [s.capability_id, "satisfies"]),
        ...this.instGuesses.filter((g) => g.tech_id === tech.id).map((g) => [g.capability_id, "is guessed to satisfy"]),
      ];
      for (const [capabilityId, verb] of links) {
        if (!this.declared.has(`${tech.id}:${capabilityId}`)) {
          reasons.push(`${verb} ${JSON.stringify(capNames.get(capabilityId) ?? capabilityId)}, which the seed does not say`);
        }
      }
      // What people recorded about it, which no seed file carries.
      const detail = this.instTechDetail.get(tech.id) || {};
      const people = [...new Set((detail.encounters || []).map((row) => row.person))];
      if (people.length > 0) reasons.push(`${andList(people)} recorded using it`);
      const versions = (detail.versions || []).map((row) => row.label);
      if (versions.length > 0) reasons.push(`it has ${count(versions.length, "recorded version")} (${versions.join(", ")})`);
      const linked = [...(detail.outgoing || []).map((edge) => edge.dst_id), ...(detail.incoming || []).map((edge) => edge.src_id)];
      if (linked.length > 0) {
        reasons.push(`it is linked to ${andList(linked.map((id) => JSON.stringify(techNames.get(id) ?? id)))}`);
      }
      const described = [
        tech.vendor_id && "a vendor",
        tech.homepage && "a homepage",
        Object.keys(tech.facets || {}).length > 0 && "facets",
        (tech.evidence_anchors || []).length > 0 && "evidence paths",
      ].filter(Boolean);
      if (described.length > 0) reasons.push(`it has ${andList(described)}, which no seed file carries`);
      for (const slot of this.liveSlots().filter((row) => row.tech_id === tech.id)) {
        reasons.push(`${this.slotLabel(slot)} uses it`);
      }
      if (reasons.length > 0) this.keep("technologies", `technology ${JSON.stringify(tech.name)}`, reasons);
      else deletable.push(tech);
    }
    return deletable;
  }

  deletableCaps() {
    const matchedCapIds = new Set([...this.caps.values()].map((cap) => cap.id));
    const matchedFeatureIds = new Set([...this.features.values()].map((feature) => feature.id));
    const deadTechs = this.dead("techs");
    const foreign = this.foreignFeatureCounts();
    const deadProducts = new Set([...this.products.values()].map((product) => product.id).filter((id) => !foreign.has(id)));
    // Gone with its technology, or the seed's own (removed before the
    // capability): neither holds a capability back.
    const holds = (link) =>
      !deadTechs.has(link.tech_id) && !this.declared.has(`${link.tech_id}:${link.capability_id}`);
    // Capability id -> the technologies whose link holds it, by name.
    const techNames = new Map(this.instTechs.map((tech) => [tech.id, tech.name]));
    const satsOf = new Map();
    for (const sat of this.instSats.filter(holds)) {
      satsOf.set(sat.capability_id, [...(satsOf.get(sat.capability_id) || []), techNames.get(sat.tech_id) ?? sat.tech_id]);
    }
    const guessesOf = new Map();
    for (const guess of this.instGuesses) {
      if (guess.feature_id ? matchedFeatureIds.has(guess.feature_id) : !holds(guess)) continue;
      guessesOf.set(guess.capability_id, (guessesOf.get(guess.capability_id) || 0) + 1);
    }
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
        const n = foreignFeatures.length;
        // Direct links, of any product: what deleting the capability would cut.
        reasons.push(`${count(n, "feature")} outside the seed ${agree(n, "realizes", "realize")} it directly`);
      }
      if (satsOf.has(cap.id)) {
        const techs = satsOf.get(cap.id);
        const n = techs.length;
        reasons.push(
          `${agree(n, "technology", "technologies")} ${andList(techs.map((name) => JSON.stringify(name)))} ` +
            `${agree(n, "satisfies", "satisfy")} it, ${agree(n, "a link", "links")} the seed does not have`,
        );
      }
      if (guessesOf.has(cap.id)) {
        const n = guessesOf.get(cap.id);
        reasons.push(`${count(n, "guessed link")} from outside the seed ${agree(n, "points", "point")} at it`);
      }
      const goalLinks = this.foreignLinks.filter((row) => row.capability_id === cap.id);
      if (goalLinks.length > 0) {
        const n = goalLinks.length;
        reasons.push(
          `${agree(n, "goal", "goals")} ${goalLinks.map((link) => this.goalName(link.goal_id)).join(", ")} ` +
            `${agree(n, "links", "link")} to it, ${agree(n, "a link", "links")} the seed does not have`,
        );
      }
      for (const bundle of this.instBundles) {
        if (bundle.capability_id === cap.id && !deadProducts.has(bundle.product_id)) {
          reasons.push(`product ${JSON.stringify(bundle.product_name)} lists it as a capability added by hand`);
        }
      }
      // Another product's plan or stack names it.
      for (const epic of this.liveEpics().filter((row) => row.capability_id === cap.id)) {
        reasons.push(`epic ${JSON.stringify(epic.title)} of product ${JSON.stringify(this.productName(epic.product_id))} is about it`);
      }
      for (const slot of this.liveSlots().filter((row) => row.capability_id === cap.id)) {
        reasons.push(`${this.slotLabel(slot)} answers it`);
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
  // it. Deleting such a product would delete them with it, so it is shared
  // state and kept.
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
      const capLinks = this.foreignLinks.filter((row) => row.goal_id === goal.id);
      if (capLinks.length > 0) {
        const n = capLinks.length;
        reasons.push(
          `it links to ${agree(n, "capability", "capabilities")} ${capLinks.map((link) => JSON.stringify(link.capability_name)).join(", ")}, ` +
            `${agree(n, "a link", "links")} the seed does not have`,
        );
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

  /** Rows the technology/capability/goal passes will delete, computed once:
   * the deletable* checks record keep lines, so they must not run twice. */
  deadRows(kind) {
    this.deadCache ??= {};
    this.deadCache[kind] ??= { techs: () => this.deletableTechs(), caps: () => this.deletableCaps(), goals: () => this.deletableGoals() }[kind]();
    return this.deadCache[kind];
  }

  dead(kind) {
    return new Set(this.deadRows(kind).map((row) => row.id));
  }

  async removeMotivations() {
    const existing = new Set(this.instMotivations.map((link) => `${link.goal_id}:${link.capability_id}`));
    for (const motivation of this.doc.motivations || []) {
      const goal = this.goals.get(motivation.goal_ref);
      const cap = this.caps.get(motivation.capability_ref);
      if (!goal || !cap || !existing.has(`${goal.id}:${cap.id}`)) {
        this.note("motivations", "absent");
        continue;
      }
      const label = `goal link ${JSON.stringify(goal.title)} → ${JSON.stringify(cap.name)}`;
      const goalDies = this.dead("goals").has(goal.id);
      // Both ends survive: the pair is someone else's too (another product's
      // seed motivated the same capability by the same goal).
      if (!this.dead("caps").has(cap.id) && !goalDies) {
        this.keep("motivations", label, ["the goal and the capability both stay"]);
        continue;
      }
      await this.remove("motivations", `/api/capabilities/${cap.id}/motivations/${goal.id}`, label, !goalDies);
    }
  }

  /** The file's own links, then every other link a deleted feature has: those
   * would go with the feature anyway, so each is named here first. */
  async removeEdges() {
    const byKey = new Map(
      this.instEdges.map((edge) => [`${edge.src_id}:${edge.dst_id}:${edge.kind}`, edge]),
    );
    const handled = new Set();
    for (const edge of this.doc.edges || []) {
      const kind = edge.kind || "DEPENDS_ON";
      const src = this.features.get(edge.src_ref);
      const dst = this.features.get(edge.dst_ref);
      const inst = src && dst ? byKey.get(`${src.id}:${dst.id}:${kind}`) : null;
      if (!inst) {
        this.note("edges", "absent");
        continue;
      }
      handled.add(inst.id);
      await this.remove("edges", `/api/features/edges/${inst.id}`, linkLabel(src.name, kind, dst.name));
    }
    const matchedIds = new Set([...this.features.values()].map((feature) => feature.id));
    const names = new Map(this.instFeatures.map((feature) => [feature.id, feature.name]));
    for (const edge of this.instEdges) {
      const srcIn = matchedIds.has(edge.src_id);
      const dstIn = matchedIds.has(edge.dst_id);
      if (handled.has(edge.id) || (!srcIn && !dstIn)) continue;
      const why = srcIn && dstIn
        ? "not in the seed; it goes with its features"
        : `feature ${JSON.stringify(names.get(srcIn ? edge.dst_id : edge.src_id))} is outside the seed; the link goes with the deleted one`;
      await this.remove(
        "edges",
        `/api/features/edges/${edge.id}`,
        `${linkLabel(names.get(edge.src_id), edge.kind, names.get(edge.dst_id))} (${why})`,
      );
    }
  }

  async removeProducts() {
    const foreign = this.foreignFeatureCounts();
    for (const product of this.products.values()) {
      if (foreign.has(product.id)) {
        const n = foreign.get(product.id);
        this.keep("products", `product ${JSON.stringify(product.name)}`, [
          `${count(n, "feature")} outside the seed ${agree(n, "belongs", "belong")} to it`,
        ]);
        continue;
      }
      const { label, cascades } = this.productLine(product);
      await this.remove("products", `/api/products/${product.id}`, label, false, cascades);
    }
  }

  /** A product's delete takes its plan, stacks and the rest of its own rows
   * with it; each is counted here. What only pointed at it stays, and says so.
   * The kinds an import counts come back too, for the summary. */
  productLine(product) {
    const id = product.id;
    const epics = this.instEpics.filter((epic) => epic.product_id === id);
    const epicIds = new Set(epics.map((epic) => epic.id));
    const storyIds = new Set(epics.flatMap((epic) => (epic.stories || []).map((story) => story.id)));
    const tickets = this.instTickets.filter((ticket) => ticket.product_id === id || epicIds.has(ticket.epic_id));
    const loose = this.instTickets.filter((ticket) => !tickets.includes(ticket) && storyIds.has(ticket.story_id));
    const stacks = this.instStacks.filter((stack) => stack.product_id === id);
    const stackIds = new Set(stacks.map((stack) => stack.id));
    const slotIds = new Set(this.instSlots.filter((slot) => stackIds.has(slot.stack_id)).map((slot) => slot.id));
    const uses = (this.instUsage.get(id) || []).length;
    const byHand = this.instBundles.filter((bundle) => bundle.product_id === id).length;
    const plans = (this.instPlans.get(id) || []).length;
    const n = (rows) => rows.length;
    const parts = [
      [plans, "plan document"],
      [n(epics), "epic"],
      [storyIds.size, "story", "stories"],
      [n(tickets), "ticket"],
      [n(this.instStrategies.get(id) || []), "delivery strategy", "delivery strategies"],
    ].filter(([k]) => k > 0).map(([k, one, many]) => count(k, one, many));
    if (uses > 0) parts.push(`its use of ${count(uses, "technology", "technologies")}`);
    if (byHand > 0) parts.push(`${count(byHand, "capability", "capabilities")} added by hand`);
    for (const stack of stacks) {
      const inner = [
        [this.instSlots.filter((slot) => slot.stack_id === stack.id).length, "slot"],
        [this.instAnswers.filter((answer) => answer.stack_id === stack.id).length, "concern answer"],
      ].filter(([k]) => k > 0).map(([k, one]) => count(k, one));
      parts.push(`its stack ${JSON.stringify(stack.name)}${inner.length > 0 ? ` (${andList(inner)})` : ""}`);
    }
    const after = [];
    const scopes = this.instScopes.filter((scope) => scope.product_id === id || stackIds.has(scope.stack_id));
    for (const name of new Set(scopes.map((scope) => scope.constraint_name))) {
      after.push(`constraint ${JSON.stringify(name)} stops applying to it`);
    }
    for (const stack of this.instStacks.filter((row) => stackIds.has(row.parent_id) && !stackIds.has(row.id))) {
      after.push(`stack ${JSON.stringify(stack.name)} of product ${JSON.stringify(this.productName(stack.product_id))} stays, no longer based on its stack`);
    }
    const viaSlot = [...this.instUsage.entries()]
      .filter(([owner]) => owner !== id)
      .flatMap(([, rows]) => rows)
      .filter((row) => slotIds.has(row.via_slot_id)).length;
    if (viaSlot > 0) after.push(`${count(viaSlot, "technology use")} of other products ${agree(viaSlot, "stays", "stay")}, no longer in its slots`);
    const answers = this.instAnswers.filter((answer) => !stackIds.has(answer.stack_id) && slotIds.has(answer.slot_id)).length;
    if (answers > 0) after.push(`${count(answers, "concern answer")} of other stacks ${agree(answers, "stays", "stay")}, no longer naming its slots`);
    if (loose.length > 0) after.push(`${count(loose.length, "ticket")} of other products ${agree(loose.length, "stays", "stay")}, no longer under its stories`);
    const recorded = [...this.instTechDetail.values()].flatMap((detail) =>
      (detail.encounters || []).filter((row) => row.product_id === id).map(() => detail.name));
    if (recorded.length > 0) {
      after.push(
        `${count(recorded.length, "recorded use")} of ${andList([...new Set(recorded)].map((name) => JSON.stringify(name)))} ` +
          `${agree(recorded.length, "stays", "stay")}, no longer naming it`,
      );
    }
    // What a seed file has no place for: an import makes one plan document,
    // as a draft with every ticket pending, and never a stack or a strategy.
    const planDocs = this.instPlans.get(id) || [];
    const strategies = (this.instStrategies.get(id) || []).length;
    // The export writes the latest plan document, not the tickets as they
    // are: one edited since (its status too) or not made from it is lost.
    const fromPlan = new Set(epics.filter((epic) => planDocs[0] && epic.decomposition_id === planDocs[0].id).map((epic) => epic.id));
    const changed = tickets.filter((ticket) => ticket.updated_at !== ticket.created_at || !fromPlan.has(ticket.epic_id)).length;
    const lost = [
      stacks.length > 0 && (stacks.length === 1 ? "its stack" : `its ${stacks.length} stacks`),
      strategies > 0 && (strategies === 1 ? "its delivery strategy" : `its ${strategies} delivery strategies`),
      planDocs.length > 1 && count(planDocs.length - 1, "older plan document"),
      (product.status === "approved" || planDocs.some((doc) => doc.status === "approved")) && "its approval",
      changed > 0 && `${count(changed, "ticket")} as ${agree(changed, "it is", "they are")} now (changed or added since its plan was written)`,
    ].filter(Boolean);
    if (lost.length > 0) after.push(`importing this file again won't bring back ${andList(lost)}`);
    return {
      label: [
        `product ${JSON.stringify(product.name)}${parts.length > 0 ? `, with ${andList(parts)}` : ""}`,
        ...after,
      ].join("; "),
      cascades: { tech_usage: uses, bundles: byHand, decompositions: plans },
    };
  }

  /** A feature's delete takes its capability links and guesses, each
   * counted, and a link the file doesn't declare named. Another product's
   * story and a journey step that pointed at it stay. */
  featureLine(feature) {
    const parts = [];
    const links = feature.capability_ids || [];
    const file = [...this.features.entries()].find(([, row]) => row.id === feature.id)?.[0];
    const declared = new Set(
      ((this.doc.features || []).find((row) => row.ref === file)?.capability_refs || [])
        .map((ref) => this.caps.get(ref)?.id),
    );
    const capNames = new Map(this.instCaps.map((cap) => [cap.id, cap.name]));
    const extra = links.filter((cid) => !declared.has(cid));
    if (links.length > 0) {
      parts.push(
        `its ${count(links.length, "capability link")}` +
          (extra.length > 0
            ? `, including the ${agree(extra.length, "link", "links")} to ` +
              `${andList(extra.map((cid) => JSON.stringify(capNames.get(cid) ?? cid)))} the seed does not have`
            : ""),
      );
    }
    const guesses = this.instGuesses.filter((guess) => guess.feature_id === feature.id).length;
    if (guesses > 0) parts.push(`its ${count(guesses, "guess", "guesses")}`);
    const after = [];
    const deadProducts = this.deadProductIds();
    for (const epic of this.instEpics.filter((row) => !deadProducts.has(row.product_id))) {
      for (const story of (epic.stories || []).filter((row) => row.feature_id === feature.id)) {
        after.push(`story ${JSON.stringify(story.title)} of product ${JSON.stringify(this.productName(epic.product_id))} stays, no longer about it`);
      }
    }
    for (const journey of this.instJourneys) {
      const steps = (journey.steps || []).filter((step) => step.feature_id === feature.id).length;
      if (steps > 0) after.push(`journey ${JSON.stringify(journey.name)} keeps its ${agree(steps, "step", "steps")}, no longer linked to it`);
    }
    return {
      label: [`feature ${JSON.stringify(feature.name)}${parts.length > 0 ? `, with ${andList(parts)}` : ""}`, ...after].join("; "),
      cascades: { guesses },
    };
  }

  async removeFeatures() {
    for (const feature of this.features.values()) {
      const { label, cascades } = this.featureLine(feature);
      await this.remove("features", `/api/features/${feature.id}`, label, false, cascades);
    }
  }

  /** Deletable technologies go, with their links to capabilities, each
   * named. On a kept one, the seed's confirmed satisfactions of a capability
   * about to be deleted go first: the capability foreign key restricts, and
   * the seed is what created them. */
  async removeTechs() {
    const capNames = new Map(this.instCaps.map((cap) => [cap.id, cap.name]));
    const techNames = new Map(this.instTechs.map((tech) => [tech.id, tech.name]));
    const names = (rows) => andList(rows.map((row) => JSON.stringify(capNames.get(row.capability_id) ?? row.capability_id)));
    for (const tech of this.deadRows("techs")) {
      const sats = this.instSats.filter((row) => row.tech_id === tech.id);
      const guesses = this.instGuesses.filter((row) => row.tech_id === tech.id);
      const parts = [
        ...(sats.length > 0 ? [`its ${agree(sats.length, "link", "links")} to ${names(sats)}`] : []),
        ...(guesses.length > 0 ? [`its ${agree(guesses.length, "guessed link", "guessed links")} to ${names(guesses)}`] : []),
      ];
      const costed = sats.filter(hasCost);
      const lost = costed.length > 0
        ? `; importing this file again won't bring back the cost recorded on its ${agree(costed.length, "link", "links")} to ${names(costed)}`
        : "";
      await this.remove(
        "technologies",
        `/api/tech/${encodeURIComponent(tech.slug)}`,
        `technology ${JSON.stringify(tech.name)}${parts.length > 0 ? `, with ${andList(parts)}` : ""}${lost}`,
        true,
        { satisfactions: sats.length, guesses: guesses.length },
      );
    }
    const deadTechs = this.dead("techs");
    const deadCaps = this.dead("caps");
    for (const sat of this.instSats) {
      if (deadTechs.has(sat.tech_id) || !this.declared.has(`${sat.tech_id}:${sat.capability_id}`)) continue;
      const label = `${JSON.stringify(techNames.get(sat.tech_id))} satisfies ${JSON.stringify(capNames.get(sat.capability_id))}`;
      if (!deadCaps.has(sat.capability_id)) {
        this.keep("satisfactions", label, ["the technology and the capability both stay"]);
        continue;
      }
      const lost = hasCost(sat) ? "; importing this file again won't bring back its recorded cost" : "";
      await this.remove("satisfactions", `/api/tech/satisfactions/${sat.id}`, `${label}${lost}`, true);
    }
  }

  /** A seed technology that stays keeps the guesses the seed made for it,
   * except one about a capability that goes: that guess goes with it. */
  async removeCaps() {
    const deadTechs = this.dead("techs");
    const techNames = new Map(this.instTechs.map((tech) => [tech.id, tech.name]));
    for (const cap of this.deadRows("caps")) {
      const guesses = this.instGuesses.filter(
        (guess) => guess.capability_id === cap.id && guess.tech_id && !deadTechs.has(guess.tech_id),
      );
      const tail = guesses.length > 0
        ? `, with the ${agree(guesses.length, "guess", "guesses")} that ${andList(guesses.map((g) => JSON.stringify(techNames.get(g.tech_id) ?? g.tech_id)))} ${agree(guesses.length, "satisfies", "satisfy")} it`
        : "";
      await this.remove(
        "capabilities", `/api/capabilities/${cap.id}`, `capability ${JSON.stringify(cap.name)}${tail}`, true,
        { guesses: guesses.length },
      );
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
    // Features before their product: a product's delete takes its features,
    // so each is deleted, and listed, by itself first.
    await this.removeFeatures();
    await this.removeProducts();
    await this.removeTechs();
    await this.removeCaps();
    await this.removeGoals();
    // Display numbers come from a sequence, so a re-import cannot restore them.
    if (Object.keys(this.counts).some((key) => key.endsWith(":would delete") || key.endsWith(":deleted"))) {
      const example = this.deadRows("goals").findLast((goal) => goal.display_id)?.display_id;
      // First, after any "can't read" note, so it is read before the rows.
      const at = this.notes.findIndex((note) => !note.startsWith("This account can't read"));
      this.notes.splice(
        at === -1 ? this.notes.length : at,
        0,
        `Numbers are not kept: importing this file again adds these rows back under new numbers` +
          `${example ? ` (${example} would not come back as ${example})` : ""}.`,
      );
    }
    return {
      dryRun: this.dryRun,
      counts: {
        motivations: this.count("motivations"),
        edges: this.count("edges"),
        features: this.count("features"),
        products: this.count("products"),
        bundles: this.count("bundles"),
        decompositions: this.count("decompositions"),
        technologies: this.count("technologies"),
        tech_usage: this.count("tech_usage"),
        satisfactions: this.count("satisfactions"),
        guesses: this.count("guesses"),
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

  // A gaps file re-states a product's real features so new links attach to
  // them; removing it would delete those features. Same refusal as the skill.
  if (doc?.source?.generated_by === "metis-fill-gaps") {
    return new Response(JSON.stringify({
      detail: "This is a metis-fill-gaps file. Removing it would delete the product's real features. Remove a single link on the feature instead.",
    }), { status: 400, headers: { "content-type": "application/json" } });
  }

  // The importer's key check: a misspelled collection ("featurse") would
  // otherwise remove the rest and keep what it names, a half removal.
  const keyErrors = [];
  checkKeys(keyErrors, doc);
  if (keyErrors.length > 0) {
    return new Response(JSON.stringify({ detail: keyErrors.join("\n") }), {
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
      status: error.status ?? 500,
      headers: { "content-type": "application/json" },
    });
  }
}
