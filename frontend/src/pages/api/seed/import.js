export const prerender = false;

import { EDGE, statusLabel } from "../../../lib/words.js";

const backend = () =>
  (process.env.API_INTERNAL_URL || "http://localhost:8000").replace(/\/$/, "");

const GOAL_TYPES = new Set(["org", "product"]);
const WORK_STATUSES = new Set(["pending", "in_progress", "done"]);
const MATURITIES = new Set(["planned", "alpha", "beta", "ga", "deprecated", "retired"]);
const EDGE_KINDS = new Set(["DEPENDS_ON", "BLOCKS", "RELATES_TO"]);
const CONTEXT_BUDGETS = new Set(["S", "M", "L"]);
const CONFIDENCES = new Set(["low", "medium", "high"]);
const TECH_KINDS = new Set(["language", "framework", "library", "runtime", "service", "model", "protocol"]);
const TECH_LAYERS = new Set(["data", "api", "web", "agent", "infra", "ops"]);
const TECH_FITS = new Set(["native", "partial", "workaround"]);

/** The backend's slug rule: lowercase kebab, "" when nothing survives. */
function slugify(value) {
  return String(value).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** A technology's identity: its explicit slug, else one derived from its name. */
function techSlug(tech) {
  if (tech.slug != null) return tech.slug;
  return typeof tech.name === "string" ? slugify(tech.name) : "";
}

/** A capability's identity, the same rule: "Keyword search" is "Keyword Search". */
const capSlug = techSlug;

/** Two versions of a text, trimmed to show where they differ:
 * `"Plans." → "Plans in phases."`, or `"…the end of a long one." → "…the end of a longer one."`. */
function textChange(before, after, max = 60) {
  const squash = (text) => String(text ?? "").replace(/\s+/g, " ").trim();
  const [a, b] = [squash(before), squash(after)];
  let same = 0;
  while (same < a.length && same < b.length && a[same] === b[same]) same += 1;
  const from = same > 30 ? a.lastIndexOf(" ", same - 20) + 1 : 0;
  const cut = (text) => {
    if (!text) return "empty";
    const rest = text.slice(from);
    return JSON.stringify(`${from > 0 ? "…" : ""}${rest.length > max ? `${rest.slice(0, max - 1)}…` : rest}`);
  };
  return `${cut(a)} → ${cut(b)}`;
}

/** Finds the instance capability a seed capability names. A slug match wins:
 * the explicit slug, then the one its name derives. A rename keeps the old
 * slug, so last the derived slug is matched against each row's current name,
 * preferring the row with exactly that name. */
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

const sorted = (set) => JSON.stringify([...set].sort());

function checkGuess(errors, where, item) {
  if (!CONFIDENCES.has(item.confidence)) errors.push(`${where}: confidence must be one of ${sorted(CONFIDENCES)}`);
  if (item.basis != null && typeof item.basis !== "string") errors.push(`${where}: basis must be a string`);
}

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
  if (feature.unknown_capabilities === true) return []; // declared unknown: none named yet
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

  const seenCapSlugs = new Set();
  for (const [i, capability] of (doc.capabilities || []).entries()) {
    const where = `capabilities[${i}] (${capability.ref})`;
    if (!capability.name) errors.push(`${where}: 'name' is required`);
    const slug = capSlug(capability);
    if (typeof slug !== "string" || !slug) {
      errors.push(`${where}: slug must be a non-empty string (give one when the name yields none)`);
    } else if (seenCapSlugs.has(slug)) {
      errors.push(`${where}: duplicate capability slug ${JSON.stringify(slug)}`);
    } else {
      seenCapSlugs.add(slug);
    }
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
    const unknown = feature.unknown_capabilities ?? false;
    if (typeof unknown !== "boolean") errors.push(`${where}: unknown_capabilities must be true or false`);
    if (!Array.isArray(refs) || (refs.length === 0 && unknown !== true)) {
      errors.push(`${where}: capability_refs must be a non-empty list of capability refs (or set unknown_capabilities: true)`);
    } else {
      for (const ref of refs) {
        if (!capRefs.has(ref)) errors.push(`${where}: capability ref ${JSON.stringify(ref)} does not match a capability`);
      }
      if (new Set(refs.map(String)).size !== refs.length) {
        errors.push(`${where}: capability_refs lists a capability twice`);
      }
    }
    const guesses = feature.capability_guesses;
    if (guesses != null && !Array.isArray(guesses)) {
      errors.push(`${where}: capability_guesses must be a list`);
    } else if (guesses) {
      const confirmed = new Set(Array.isArray(refs) ? refs.map(String) : []);
      const guessed = new Set();
      for (const [j, guess] of guesses.entries()) {
        const gwhere = `${where}.capability_guesses[${j}]`;
        if (guess === null || typeof guess !== "object" || Array.isArray(guess)) {
          errors.push(`${gwhere}: must be an object`);
          continue;
        }
        const ref = guess.capability_ref;
        if (typeof ref !== "string" || !capRefs.has(ref)) {
          errors.push(`${gwhere}: capability_ref ${JSON.stringify(ref ?? null)} does not match a capability`);
        } else if (confirmed.has(ref)) {
          errors.push(`${gwhere}: ${JSON.stringify(ref)} is also in capability_refs (a link is confirmed or guessed, not both)`);
        } else if (guessed.has(ref)) {
          errors.push(`${gwhere}: ${JSON.stringify(ref)} is guessed twice`);
        }
        guessed.add(ref);
        checkGuess(errors, gwhere, guess);
      }
    }
    if (feature.product_ref != null && !productRefs.has(feature.product_ref)) {
      errors.push(`${where}: unknown product_ref ${JSON.stringify(feature.product_ref)}`);
    }
    checkPriority(errors, where, feature);
    checkStatus(errors, where, feature);
    checkFacets(errors, where, feature);
  }

  checkRefs("technologies");
  const seenSlugs = new Set();
  for (const [i, tech] of (doc.technologies || []).entries()) {
    const where = `technologies[${i}] (${tech.ref})`;
    if (typeof tech.name !== "string" || !tech.name) errors.push(`${where}: 'name' is required`);
    const slug = techSlug(tech);
    if (typeof slug !== "string" || !slug) {
      errors.push(`${where}: slug must be a non-empty string (give one when the name yields none)`);
    } else if (seenSlugs.has(slug)) {
      errors.push(`${where}: duplicate technology slug ${JSON.stringify(slug)}`);
    } else {
      seenSlugs.add(slug);
    }
    if (!TECH_KINDS.has(tech.kind)) errors.push(`${where}: kind must be one of ${sorted(TECH_KINDS)}`);
    if (tech.layer != null && !TECH_LAYERS.has(tech.layer)) errors.push(`${where}: layer must be one of ${sorted(TECH_LAYERS)}`);
    const products = tech.products;
    if (products != null && (!Array.isArray(products) || products.some((ref) => typeof ref !== "string" || !productRefs.has(ref)))) {
      errors.push(`${where}: products must be product refs`);
    }
    const satisfies = tech.satisfies;
    if (satisfies != null && !Array.isArray(satisfies)) {
      errors.push(`${where}: satisfies must be a list`);
      continue;
    }
    const linked = new Set();
    for (const [j, link] of (satisfies || []).entries()) {
      const swhere = `${where}.satisfies[${j}]`;
      if (link === null || typeof link !== "object" || Array.isArray(link)) {
        errors.push(`${swhere}: must be an object`);
        continue;
      }
      const ref = link.capability_ref;
      if (typeof ref !== "string" || !capRefs.has(ref)) {
        errors.push(`${swhere}: capability_ref ${JSON.stringify(ref ?? null)} does not match a capability`);
      } else if (linked.has(ref)) {
        errors.push(`${swhere}: ${JSON.stringify(ref)} is listed twice`);
      }
      linked.add(ref);
      if (link.confidence == null) {
        // Confirmed: observed in code.
        if (!TECH_FITS.has(link.fit)) errors.push(`${swhere}: fit must be one of ${sorted(TECH_FITS)}`);
        if (link.basis != null && typeof link.basis !== "string") errors.push(`${swhere}: basis must be a string`);
      } else {
        checkGuess(errors, swhere, link);
        if (link.fit != null && !TECH_FITS.has(link.fit)) errors.push(`${swhere}: fit must be one of ${sorted(TECH_FITS)}`);
      }
    }
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
    if (typeof (product.external ?? false) !== "boolean") errors.push(`${where}: external must be true or false`);
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

  /** For endpoints an older instance may not have yet: absent reads as []. */
  async getOptional(route) {
    const { status, body } = await this.request("GET", route);
    return status === 200 ? body : [];
  }

  async post(route, payload) {
    return this.request("POST", route, payload);
  }

  async put(route, payload) {
    return this.request("PUT", route, payload);
  }

  async patch(route, payload) {
    return this.request("PATCH", route, payload);
  }
}

const isDry = (id) => String(id).startsWith("dry-run:");

class Loader {
  constructor(api, doc, dryRun) {
    this.api = api;
    this.doc = doc;
    this.dryRun = dryRun;
    this.counts = {};
    this.notes = [];
    // A note whose text is trimmed, with the untrimmed text for its hover.
    this.fullText = {};
    this.warnings = [];
    this.goalIds = new Map();
    this.capIds = new Map();
    this.featureIds = new Map();
    this.productIds = new Map();
    this.techIds = new Map();
    this.featureCaps = new Map(); // feature ref -> capability ids it realizes (confirmed)
    this.existingGuesses = null;
  }

  note(collection, action) {
    const key = `${collection}:${action}`;
    this.counts[key] = (this.counts[key] || 0) + 1;
  }

  /** The name a file's ref stands for, quoted, for a line a person reads. */
  named(collection, ref) {
    const item = (this.doc[collection] || []).find((row) => row.ref === ref);
    return JSON.stringify(item?.name ?? ref);
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
    const resolve = capabilityResolver(await this.api.get("/api/capabilities"));
    const added = [];
    for (const capability of parentsFirst(this.doc.capabilities || [])) {
      const found = resolve(capability);
      if (found) {
        this.reuseCapability(capability, found);
        continue;
      }
      const payload = {
        parent_id: this.capIds.get(capability.parent_ref),
        slug: capability.slug,
        name: capability.name,
        description: capability.description,
        maturity: capability.maturity,
        facets: capability.facets,
        evidence_anchors: capability.evidence_anchors,
      };
      if (this.dryRun) {
        this.capIds.set(capability.ref, await this.create("capabilities", "/api/capabilities", payload, capability.name));
        added.push(capability.name);
        continue;
      }
      const { status, body } = await this.api.post("/api/capabilities", prune(payload));
      if (status === 201) {
        this.capIds.set(capability.ref, body.id);
        this.note("capabilities", "created");
        added.push(capability.name);
      } else if (status === 409 && typeof body?.existing?.slug === "string") {
        // Created since the list was read: the same slug is the same capability.
        const row = (await this.api.get("/api/capabilities")).find((c) => c.slug === body.existing.slug);
        if (!row) throw new Error(`POST /api/capabilities for ${capability.name} returned 409 for a slug no capability has: ${JSON.stringify(body)}`);
        this.reuseCapability(capability, row);
      } else {
        throw new Error(`POST /api/capabilities for ${capability.name} returned ${status}: ${JSON.stringify(body)}`);
      }
    }
    await this.listAddedCapabilities(added);
  }

  reuseCapability(capability, row) {
    this.capIds.set(capability.ref, row.id);
    this.note("capabilities", "reused");
    if (row.name !== capability.name) {
      this.notes.push(`capability ${JSON.stringify(capability.name)} is the existing ${JSON.stringify(row.name)}; reused as it is`);
    }
  }

  /** Every capability the file adds, by name; in a dry run with the closest
   * existing names, so a near-duplicate is caught before the import. */
  async listAddedCapabilities(names) {
    if (names.length === 0) return;
    let nearest = new Map();
    if (this.dryRun) {
      const { status, body } = await this.api.post("/api/capabilities/coverage", {
        features: [{ name: "seed file", capabilities: names }],
      });
      if (status === 200) {
        nearest = new Map(
          (body.features?.[0]?.capabilities || []).map((need) => [need.name, (need.candidates || []).map((c) => c.name)]),
        );
      }
    }
    for (const name of names) {
      const near = nearest.get(name.trim()) || [];
      this.notes.push(
        `new capability ${JSON.stringify(name)}` +
          (near.length > 0 ? `; nearest existing: ${near.map((n) => JSON.stringify(n)).join(", ")}` : ""),
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

  /** A reused feature gains the file's confirmed links it lacks, never losing
   * one. A product's own seed is the authority on its own features, so the
   * `status`, `description` and `unknown_capabilities` the file states replace
   * the feature's; a field the file leaves out is left alone. Each overwrite
   * is listed by feature, in a dry run too, since it may undo a hand edit.
   * Returns the feature's confirmed links afterwards. */
  async updateReusedFeature(feature, current) {
    const have = [...(current.capability_ids || [])];
    const missing = [...new Set(featureCapabilityRefs(feature).map((ref) => this.capIds.get(ref)))]
      .filter((id) => !have.includes(id));
    const payload = {};
    const changes = [];
    let full = null;
    if (missing.length > 0) payload.capability_ids = [...have, ...missing];
    if (feature.status != null && feature.status !== current.status) {
      payload.status = feature.status;
      changes.push(`status ${statusLabel(current.status)} → ${statusLabel(feature.status)}`);
    }
    if (feature.description != null && feature.description !== (current.description ?? null)) {
      payload.description = feature.description;
      changes.push(`description ${textChange(current.description, feature.description)}`);
      full = `Description before:\n${current.description ?? "(empty)"}\n\nAfter:\n${feature.description}`;
    }
    const flag = feature.unknown_capabilities;
    if (typeof flag === "boolean" && flag !== (current.unknown_capabilities === true)) {
      payload.unknown_capabilities = flag;
      changes.push(flag ? "now says some of its capabilities are unknown" : "no longer says some of its capabilities are unknown");
    }
    if (Object.keys(payload).length === 0) return new Set(have);
    const overwrites = changes.length > 0 ? `feature ${JSON.stringify(feature.name)}: ${changes.join("; ")}` : null;
    if (overwrites && full) this.fullText[overwrites] = full;
    if (this.dryRun) {
      this.note("features", missing.length > 0 ? "would link" : "would update");
      if (overwrites) this.notes.push(overwrites);
      return new Set([...have, ...missing]);
    }
    const { status, body } = await this.api.patch(`/api/features/${current.id}`, payload);
    if (status !== 200) {
      this.warnings.push(`feature ${JSON.stringify(feature.name)} rejected (${status}): ${JSON.stringify(body)}`);
      this.note("features", "rejected");
      return new Set(have);
    }
    this.note("features", missing.length > 0 ? "linked" : "updated");
    if (overwrites) this.notes.push(overwrites);
    return new Set(body.capability_ids);
  }

  async loadFeatures() {
    // On reuse, links only grow and the file's stated status, description and
    // unknown_capabilities win (updateReusedFeature). Identity is
    // (product, name): another product's "Sign in" is a different feature.
    const instance = await this.api.get("/api/features");
    const existing = new Map(instance.map((feature) => [featureKey(feature.product_id, feature.name), feature]));
    for (const feature of this.doc.features || []) {
      const key = featureKey(this.productIds.get(feature.product_ref), feature.name);
      if (existing.has(key)) {
        const current = existing.get(key);
        this.featureIds.set(feature.ref, current.id);
        this.note("features", "reused");
        this.featureCaps.set(feature.ref, await this.updateReusedFeature(feature, current));
        continue;
      }
      this.featureCaps.set(feature.ref, new Set(featureCapabilityRefs(feature).map((ref) => this.capIds.get(ref))));
      this.featureIds.set(
        feature.ref,
        await this.create("features", "/api/features", {
          capability_ids: featureCapabilityRefs(feature).map((ref) => this.capIds.get(ref)),
          unknown_capabilities: feature.unknown_capabilities === true,
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

  /** Guesses already in the instance, keyed by (capability, feature or tech). */
  async guesses() {
    if (this.existingGuesses === null) {
      this.existingGuesses = new Map(
        (await this.api.getOptional("/api/guesses")).map((guess) => [
          `${guess.capability_id}:${guess.feature_id || guess.tech_id}`,
          guess,
        ]),
      );
    }
    return this.existingGuesses;
  }

  /** Create or update one guess. The endpoint is idempotent per pair, so a
   * re-import updates confidence and basis instead of stacking rows. */
  async postGuess(payload, label) {
    const other = payload.feature_id || payload.tech_id;
    const current = (await this.guesses()).get(`${payload.capability_id}:${other}`);
    if (current && ["confidence", "basis", "fit"].every((k) => (current[k] ?? null) === (payload[k] ?? null))) {
      this.note("guesses", "reused");
      return;
    }
    if (this.dryRun || isDry(other)) {
      this.note("guesses", current ? "would update" : "would create");
      return;
    }
    const { status, body } = await this.api.post("/api/guesses", prune(payload));
    if (status === 200 || status === 201) {
      this.note("guesses", current ? "updated" : "created");
    } else {
      this.warnings.push(`guess ${label} rejected (${status}): ${JSON.stringify(body)}`);
      this.note("guesses", "rejected");
    }
  }

  async loadFeatureGuesses() {
    // Reused features get their guesses too: guesses arrive gradually, on
    // each product's next export, mostly for features metis already has.
    for (const feature of this.doc.features || []) {
      const featureId = this.featureIds.get(feature.ref);
      for (const guess of feature.capability_guesses || []) {
        const capabilityId = this.capIds.get(guess.capability_ref);
        const label = `${JSON.stringify(feature.name)} → ${this.named("capabilities", guess.capability_ref)}`;
        if ((this.featureCaps.get(feature.ref) || new Set()).has(capabilityId)) {
          this.notes.push(`guess ${label} skipped: the link is already confirmed`);
          this.note("guesses", "skipped");
          continue;
        }
        await this.postGuess({
          capability_id: capabilityId,
          feature_id: featureId,
          confidence: guess.confidence,
          basis: guess.basis,
        }, label);
      }
    }
  }

  async allTechnologies() {
    const rows = [];
    for (let offset = 0; ; offset += 200) {
      const page = await this.api.get(`/api/tech?limit=200&offset=${offset}`);
      rows.push(...page.rows);
      if (offset + 200 >= page.total || page.rows.length === 0) return rows;
    }
  }

  async loadTechnologies() {
    const techs = this.doc.technologies || [];
    if (techs.length === 0) return;
    const existing = new Map((await this.allTechnologies()).map((tech) => [tech.slug, tech.id]));
    for (const tech of techs) {
      const slug = techSlug(tech);
      if (existing.has(slug)) {
        this.techIds.set(tech.ref, existing.get(slug));
        this.note("technologies", "reused");
        continue;
      }
      this.techIds.set(
        tech.ref,
        await this.create("technologies", "/api/tech", { slug, name: tech.name, kind: tech.kind, layer: tech.layer }, tech.name),
      );
    }

    // Observed usage. PUT resets an existing row's slot binding, so pairs
    // already recorded are left alone.
    const usage = new Map();
    for (const tech of techs) {
      const techId = this.techIds.get(tech.ref);
      for (const productRef of tech.products || []) {
        const productId = this.productIds.get(productRef);
        if (isDry(productId) || isDry(techId)) {
          this.note("tech_usage", "would create");
          continue;
        }
        if (!usage.has(productId)) {
          usage.set(productId, new Set((await this.api.get(`/api/stacks/usage?product_id=${productId}`)).map((u) => u.tech_id)));
        }
        if (usage.get(productId).has(techId)) {
          this.note("tech_usage", "reused");
        } else if (this.dryRun) {
          this.note("tech_usage", "would create");
        } else {
          const { status, body } = await this.api.put(`/api/stacks/usage?product_id=${productId}`, { tech_id: techId });
          if (status !== 200 && status !== 201) {
            throw new Error(`usage ${tech.ref} by ${productRef} returned ${status}: ${JSON.stringify(body)}`);
          }
          usage.get(productId).add(techId);
          this.note("tech_usage", "created");
        }
      }
    }

    const confirmed = new Set(
      (await this.api.get("/api/tech/satisfactions")).map((s) => `${s.tech_id}:${s.capability_id}`),
    );
    for (const tech of techs) {
      const techId = this.techIds.get(tech.ref);
      for (const link of tech.satisfies || []) {
        const capabilityId = this.capIds.get(link.capability_ref);
        const label = `${JSON.stringify(tech.name)} satisfies ${this.named("capabilities", link.capability_ref)}`;
        const known = confirmed.has(`${techId}:${capabilityId}`);
        if (link.confidence != null) {
          if (known) {
            this.notes.push(`guess ${label} skipped: the link is already confirmed`);
            this.note("guesses", "skipped");
            continue;
          }
          await this.postGuess({
            capability_id: capabilityId,
            tech_id: techId,
            confidence: link.confidence,
            basis: link.basis,
            fit: link.fit,
          }, label);
          continue;
        }
        if (known) {
          this.note("satisfactions", "reused");
          continue;
        }
        if (this.dryRun) {
          this.note("satisfactions", "would create");
          continue;
        }
        const { status, body } = await this.api.post("/api/tech/satisfactions", prune({
          tech_id: techId,
          capability_id: capabilityId,
          fit: link.fit,
          notes: link.basis,
        }));
        if (status === 201) this.note("satisfactions", "created");
        else if (status === 409) this.note("satisfactions", "reused");
        else throw new Error(`satisfaction ${label} returned ${status}: ${JSON.stringify(body)}`);
      }
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
      const label = `${this.named("features", edge.src_ref)} ${EDGE[kind] ?? kind} ${this.named("features", edge.dst_ref)}`;
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
        this.warnings.push(`link ${label} rejected (${status}): ${JSON.stringify(body)}`);
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
          external: product.external === true,
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
        // A product this dry run would create has no bundles to look up yet.
        const existing = String(productId).startsWith("dry-run:")
          ? []
          : await this.api.get(`/api/products/${productId}/bundles`);
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
          `product "${product.name}" already has a plan document; left as it is (an import never adds a second one)`,
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

  // Last, once everything loaded: record that each product in the file was
  // just refreshed. The server stamps the time.
  async markSeeded() {
    if (this.dryRun) return;
    for (const productId of new Set(this.productIds.values())) {
      const { status, body } = await this.api.post(`/api/products/${productId}/seeded`);
      if (status !== 200) {
        this.notes.push(`could not record when product ${productId} was seeded: ${status} ${JSON.stringify(body)}`);
      }
    }
  }

  async run() {
    await this.loadGoals();
    await this.loadCapabilities();
    await this.loadMotivations();
    await this.loadProductRows();
    await this.loadFeatures();
    await this.loadFeatureGuesses();
    await this.loadEdges();
    await this.loadTechnologies();
    await this.loadProducts();
    await this.markSeeded();
    // Names are identity, so a re-described repo with reworded features adds
    // near-duplicates. Say so before anyone presses Import.
    const products = this.count("products");
    const features = this.count("features");
    const added = (features["would create"] ?? 0) + (features.created ?? 0);
    if ((products.reused ?? 0) > 0 && added > 0) {
      this.warnings.push(
        `This file names a product metis already has and adds ${added === 1 ? "1 feature whose name doesn't" : `${added} features whose names don't`} match its existing ones. ` +
          "If they describe features it already has under new wording, importing creates duplicates: compare with the product's feature list first.",
      );
    }
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
        technologies: this.count("technologies"),
        tech_usage: this.count("tech_usage"),
        satisfactions: this.count("satisfactions"),
        guesses: this.count("guesses"),
      },
      notes: this.notes,
      fullText: this.fullText,
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

export { validateSeed, Loader };
