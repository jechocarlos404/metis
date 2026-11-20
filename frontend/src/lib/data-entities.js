/**
 * Per-entity descriptors for the admin data browser.
 *
 * One object per tab, one generic renderer in DataIsland. The point is that the
 * renderer never branches on entity key: `createPath` and `deletePath` are
 * functions, so a link row whose delete needs two ids in the path is the same
 * kind of thing as a normal row whose delete needs one.
 *
 * Create/edit deliberately post to the EXISTING domain endpoints, so every
 * invariant they enforce (capability must exist, edges may not close a cycle,
 * slugs stay unique) applies here too. Only listing and cascade delete are new.
 */

import { STATUS_TONE } from "../ds";
import { EDGE, MATURITY, plain, statusLabel } from "./words.js";

// Plain words on screen; each column's `raw` keeps the stored value one hover away.
const MATURITIES = ["planned", "alpha", "beta", "ga", "deprecated", "retired"]
  .map((v) => ({ value: v, label: plain(MATURITY, v) }));
const WORK_STATUSES = ["pending", "in_progress", "done"].map((v) => ({ value: v, label: statusLabel(v) }));
const GOAL_TYPES = ["org", "product"];
const EDGE_KINDS = ["DEPENDS_ON", "BLOCKS", "RELATES_TO"].map((v) => ({ value: v, label: plain(EDGE, v) }));
const BUDGETS = ["S", "M", "L"];

const MATURITY_TONE = {
  planned: "neutral", alpha: "warn", beta: "warn",
  ga: "ok", deprecated: "danger", retired: "danger",
};

/** A value exists but we can't name it — say so rather than render an empty cell. */
export const shortId = (id) => (id ? String(id).slice(0, 8) : "—");

const nameOf = (refs, key, id) => refs[key]?.byId.get(id)?.name ?? shortId(id);
const titleOf = (refs, key, id) => refs[key]?.byId.get(id)?.title ?? shortId(id);

const GOALS = {
  key: "goals",
  label: "Goals",
  singular: "goal",
  listPath: "/goals",
  editable: true,
  title: (r) => r.title,
  columns: [
    { key: "title", label: "Title", width: "minmax(0,2fr)", render: (r) => r.title },
    { key: "type", label: "Type", width: "90px", mono: true, render: (r) => r.goal_type },
    { key: "parent", label: "Parent", width: "minmax(0,1fr)",
      render: (r, refs) => (r.parent_goal_id ? titleOf(refs, "goals", r.parent_goal_id) : "—") },
    { key: "status", label: "Status", width: "110px",
      render: (r) => statusLabel(r.status), raw: (r) => r.status, tone: (r) => STATUS_TONE[r.status] },
    { key: "priority", label: "Priority", width: "70px", mono: true, render: (r) => r.priority ?? "—" },
  ],
  fields: [
    { key: "title", label: "Title", type: "text", required: true },
    { key: "goal_type", label: "Type", type: "select", options: GOAL_TYPES },
    { key: "parent_goal_id", label: "Parent goal", type: "select",
      optionsFrom: "goals", optionLabel: (g) => g.title, nullable: true },
    { key: "description", label: "Description", type: "textarea" },
    { key: "success_criteria", label: "Success criteria", type: "textarea" },
    { key: "status", label: "Status", type: "select", options: WORK_STATUSES },
    { key: "priority", label: "Priority", type: "number" },
  ],
  emptyDraft: {
    title: "", goal_type: "product", parent_goal_id: "", description: "",
    success_criteria: "", status: "pending", priority: "",
  },
  toDraft: (r) => ({
    title: r.title, goal_type: r.goal_type, parent_goal_id: r.parent_goal_id ?? "",
    description: r.description ?? "", success_criteria: r.success_criteria ?? "",
    status: r.status, priority: r.priority != null ? String(r.priority) : "",
  }),
  createPath: () => "/goals",
  createBody: (d) => ({
    title: d.title.trim(),
    goal_type: d.goal_type,
    parent_goal_id: d.parent_goal_id || null,
    description: d.description.trim() || null,
    success_criteria: d.success_criteria.trim() || null,
    status: d.status,
    priority: d.priority === "" ? null : Number(d.priority),
  }),
  patchPath: (r) => `/goals/${r.id}`,
  patchBody: (d) => GOALS.createBody(d),
  deletePath: (r) => `/goals/${r.id}`,
};

const CAPABILITIES = {
  key: "capabilities",
  label: "Capabilities",
  singular: "capability",
  listPath: "/capabilities",
  editable: true,
  title: (r) => r.name,
  columns: [
    { key: "name", label: "Name", width: "minmax(0,2fr)", render: (r) => r.name },
    { key: "slug", label: "Slug", width: "minmax(0,1fr)", mono: true, render: (r) => r.slug },
    { key: "parent", label: "Parent", width: "minmax(0,1fr)",
      render: (r, refs) => (r.parent_id ? nameOf(refs, "capabilities", r.parent_id) : "—") },
    { key: "maturity", label: "Maturity", width: "110px",
      render: (r) => plain(MATURITY, r.maturity), raw: (r) => r.maturity, tone: (r) => MATURITY_TONE[r.maturity] },
  ],
  fields: [
    { key: "name", label: "Name", type: "text", required: true },
    // Derived from the name when blank; CapabilityUpdate has no slug field, so
    // offering it on edit would silently drop the value.
    { key: "slug", label: "Slug", type: "text", createOnly: true },
    { key: "parent_id", label: "Parent capability", type: "select",
      optionsFrom: "capabilities", optionLabel: (c) => c.name, nullable: true },
    { key: "description", label: "Description", type: "textarea" },
    { key: "maturity", label: "Maturity", type: "select", options: MATURITIES },
  ],
  emptyDraft: { name: "", slug: "", parent_id: "", description: "", maturity: "planned" },
  toDraft: (r) => ({
    name: r.name, slug: r.slug, parent_id: r.parent_id ?? "",
    description: r.description ?? "", maturity: r.maturity,
  }),
  createPath: () => "/capabilities",
  createBody: (d) => ({
    name: d.name.trim(),
    slug: d.slug.trim() || null,
    parent_id: d.parent_id || null,
    description: d.description.trim() || null,
    maturity: d.maturity,
  }),
  patchPath: (r) => `/capabilities/${r.id}`,
  patchBody: (d) => ({
    name: d.name.trim(),
    parent_id: d.parent_id || null,
    description: d.description.trim() || null,
    maturity: d.maturity,
  }),
  deletePath: (r) => `/capabilities/${r.id}`,
};

const FEATURES = {
  key: "features",
  label: "Features",
  singular: "feature",
  listPath: "/features",
  editable: true,
  title: (r) => r.name,
  columns: [
    { key: "name", label: "Name", width: "minmax(0,2fr)", render: (r) => r.name },
    { key: "capabilities", label: "Capabilities", width: "minmax(0,1.5fr)",
      render: (r, refs) =>
        [...(r.capability_ids ?? []).map((id) => nameOf(refs, "capabilities", id)), ...(r.unknown_capabilities ? ["+ unknown"] : [])]
          .join(", ") || "—" },
    { key: "product", label: "Product", width: "minmax(0,1fr)",
      render: (r, refs) => (r.product_id ? nameOf(refs, "products", r.product_id) : "—") },
    { key: "status", label: "Status", width: "110px",
      render: (r) => statusLabel(r.status), raw: (r) => r.status, tone: (r) => STATUS_TONE[r.status] },
    { key: "priority", label: "Priority", width: "70px", mono: true, render: (r) => r.priority ?? "—" },
  ],
  fields: [
    { key: "name", label: "Name", type: "text", required: true },
    { key: "product_id", label: "Product", type: "select",
      optionsFrom: "products", optionLabel: (p) => p.name, nullable: true },
    // At least one, unless the rest are declared unknown.
    { key: "capability_ids", label: "Realizes capabilities", type: "multiselect", required: true,
      requiredUnless: "unknown_capabilities",
      optionsFrom: "capabilities", optionLabel: (c) => c.name },
    { key: "unknown_capabilities", label: "Some capabilities are unknown", type: "checkbox" },
    { key: "description", label: "Description", type: "textarea" },
    { key: "status", label: "Status", type: "select", options: WORK_STATUSES },
    { key: "priority", label: "Priority", type: "number" },
    { key: "priority_rationale", label: "Priority rationale", type: "textarea" },
  ],
  emptyDraft: {
    capability_ids: [], unknown_capabilities: false, product_id: "", name: "", description: "", status: "pending",
    priority: "", priority_rationale: "",
  },
  toDraft: (r) => ({
    capability_ids: r.capability_ids ?? [], unknown_capabilities: !!r.unknown_capabilities,
    product_id: r.product_id ?? "",
    name: r.name, description: r.description ?? "",
    status: r.status, priority: r.priority != null ? String(r.priority) : "",
    priority_rationale: r.priority_rationale ?? "",
  }),
  createPath: () => "/features",
  createBody: (d) => ({
    capability_ids: d.capability_ids,
    unknown_capabilities: d.unknown_capabilities,
    product_id: d.product_id || null,
    name: d.name.trim(),
    description: d.description.trim() || null,
    status: d.status,
    priority: d.priority === "" ? null : Number(d.priority),
    priority_rationale: d.priority_rationale.trim() || null,
  }),
  patchPath: (r) => `/features/${r.id}`,
  // Re-pointing capability_ids here is the cheapest way to merge a duplicate
  // capability without losing the features that realize it.
  patchBody: (d) => FEATURES.createBody(d),
  deletePath: (r) => `/features/${r.id}`,
};

const FEATURE_EDGES = {
  key: "feature_edges",
  label: "Feature edges",
  singular: "edge",
  listPath: "/features/edges",
  // EdgeRead carries only {id, src_id, dst_id, kind} — without the features
  // list every row would read as two uuids.
  editable: false, // no PATCH route exists; delete and recreate
  title: (r, refs) =>
    `${nameOf(refs, "features", r.src_id)} ${plain(EDGE, r.kind)} ${nameOf(refs, "features", r.dst_id)}`,
  columns: [
    { key: "src", label: "Source", width: "minmax(0,1fr)",
      render: (r, refs) => nameOf(refs, "features", r.src_id) },
    { key: "kind", label: "Kind", width: "130px", render: (r) => plain(EDGE, r.kind), raw: (r) => r.kind },
    { key: "dst", label: "Target", width: "minmax(0,1fr)",
      render: (r, refs) => nameOf(refs, "features", r.dst_id) },
  ],
  fields: [
    { key: "src_id", label: "Source feature", type: "select", required: true,
      optionsFrom: "features", optionLabel: (f) => f.name },
    { key: "kind", label: "Kind", type: "select", options: EDGE_KINDS },
    { key: "dst_id", label: "Target feature", type: "select", required: true,
      optionsFrom: "features", optionLabel: (f) => f.name },
  ],
  emptyDraft: { src_id: "", kind: "DEPENDS_ON", dst_id: "" },
  createPath: () => "/features/edges",
  createBody: (d) => ({ src_id: d.src_id, dst_id: d.dst_id, kind: d.kind }),
  deletePath: (r) => `/features/edges/${r.id}`,
};

const MOTIVATIONS = {
  key: "motivations",
  label: "Motivations",
  singular: "motivation",
  listPath: "/motivations",
  editable: false, // the row IS its two ids; editing it means replacing it
  title: (r) => `${r.goal_title} → ${r.capability_name}`,
  columns: [
    { key: "goal", label: "Goal", width: "minmax(0,1fr)", render: (r) => r.goal_title },
    { key: "arrow", label: "", width: "24px", render: () => "→" },
    { key: "capability", label: "Capability", width: "minmax(0,1fr)",
      render: (r) => r.capability_name },
  ],
  fields: [
    { key: "goal_id", label: "Goal", type: "select", required: true,
      optionsFrom: "goals", optionLabel: (g) => g.title },
    { key: "capability_id", label: "Capability", type: "select", required: true,
      optionsFrom: "capabilities", optionLabel: (c) => c.name },
  ],
  emptyDraft: { goal_id: "", capability_id: "" },
  // The capability rides in the path, the goal in the body — verified against
  // POST /api/capabilities/{id}/motivations, which is a body route.
  createPath: (d) => `/capabilities/${d.capability_id}/motivations`,
  createBody: (d) => ({ goal_id: d.goal_id }),
  deletePath: (r) => `/capabilities/${r.capability_id}/motivations/${r.goal_id}`,
  duplicateOf: ["goal_id", "capability_id"],
};

const PRODUCTS = {
  key: "products",
  label: "Products",
  singular: "product",
  listPath: "/products",
  editable: true,
  title: (r) => r.name,
  columns: [
    { key: "name", label: "Name", width: "minmax(0,2fr)", render: (r) => r.name },
    { key: "slug", label: "Slug", width: "minmax(0,1fr)", mono: true, render: (r) => r.slug },
    { key: "goal", label: "Goal", width: "minmax(0,1fr)",
      render: (r, refs) => (r.goal_id ? titleOf(refs, "goals", r.goal_id) : "—") },
    { key: "external", label: "External", width: "80px", render: (r) => (r.external ? "yes" : "—") },
    { key: "status", label: "Status", width: "90px",
      render: (r) => statusLabel(r.status), raw: (r) => r.status, tone: (r) => (r.status === "approved" ? "ok" : "neutral") },
  ],
  fields: [
    { key: "name", label: "Name", type: "text", required: true },
    { key: "slug", label: "Slug", type: "text", createOnly: true },
    { key: "goal_id", label: "Goal", type: "select",
      optionsFrom: "goals", optionLabel: (g) => g.title, nullable: true },
    { key: "summary", label: "Summary", type: "textarea" },
    { key: "body", label: "Body", type: "textarea" },
    { key: "external", label: "External (someone else's product)", type: "checkbox" },
  ],
  emptyDraft: { name: "", slug: "", goal_id: "", summary: "", body: "", external: false },
  toDraft: (r) => ({
    name: r.name, slug: r.slug, goal_id: r.goal_id ?? "",
    summary: r.summary ?? "", body: r.body ?? "", external: !!r.external,
  }),
  createPath: () => "/products",
  createBody: (d) => ({
    name: d.name.trim(),
    slug: d.slug.trim() || null,
    goal_id: d.goal_id || null,
    summary: d.summary.trim() || null,
    body: d.body.trim() || null,
    external: d.external,
  }),
  patchPath: (r) => `/products/${r.id}`,
  patchBody: (d) => ({
    name: d.name.trim(),
    goal_id: d.goal_id || null,
    summary: d.summary.trim() || null,
    body: d.body.trim() || null,
    external: d.external,
  }),
  deletePath: (r) => `/products/${r.id}`,
};

const PRODUCT_BUNDLES = {
  key: "product_bundles", // underscored key, hyphenated URL — different namespaces
  label: "Product bundles",
  singular: "bundle",
  listPath: "/product-bundles",
  editable: false,
  title: (r) => `${r.product_name} includes ${r.capability_name}`,
  columns: [
    { key: "product", label: "Product", width: "minmax(0,1fr)", render: (r) => r.product_name },
    { key: "includes", label: "", width: "80px", render: () => "includes" },
    { key: "capability", label: "Capability", width: "minmax(0,1fr)",
      render: (r) => r.capability_name },
  ],
  fields: [
    { key: "product_id", label: "Product", type: "select", required: true,
      optionsFrom: "products", optionLabel: (p) => p.name },
    { key: "capability_id", label: "Capability", type: "select", required: true,
      optionsFrom: "capabilities", optionLabel: (c) => c.name },
  ],
  emptyDraft: { product_id: "", capability_id: "" },
  createPath: (d) => `/products/${d.product_id}/bundles`,
  createBody: (d) => ({ capability_id: d.capability_id }),
  deletePath: (r) => `/products/${r.product_id}/bundles/${r.capability_id}`,
  duplicateOf: ["product_id", "capability_id"],
};

const TICKETS = {
  key: "tickets",
  label: "Tickets",
  singular: "ticket",
  listPath: "/tickets",
  editable: true,
  title: (r) => r.title,
  columns: [
    { key: "title", label: "Title", width: "minmax(0,2fr)", render: (r) => r.title },
    { key: "product", label: "Product", width: "minmax(0,1fr)",
      render: (r, refs) => nameOf(refs, "products", r.product_id) },
    { key: "status", label: "Status", width: "110px",
      render: (r) => statusLabel(r.status), raw: (r) => r.status, tone: (r) => STATUS_TONE[r.status] },
    { key: "budget", label: "Budget", width: "70px", mono: true, render: (r) => r.context_budget },
  ],
  fields: [
    { key: "product_id", label: "Product", type: "select", required: true,
      optionsFrom: "products", optionLabel: (p) => p.name, createOnly: true },
    { key: "title", label: "Title", type: "text", required: true },
    { key: "description", label: "Description", type: "textarea" },
    { key: "technical_approach", label: "Technical approach", type: "textarea" },
    { key: "acceptance_criteria", label: "Acceptance criteria", type: "textarea" },
    { key: "context_budget", label: "Context budget", type: "select", options: BUDGETS },
    { key: "status", label: "Status", type: "select", options: WORK_STATUSES },
  ],
  emptyDraft: {
    product_id: "", title: "", description: "", technical_approach: "",
    acceptance_criteria: "", context_budget: "M", status: "pending",
  },
  toDraft: (r) => ({
    product_id: r.product_id, title: r.title, description: r.description ?? "",
    technical_approach: r.technical_approach ?? "",
    acceptance_criteria: r.acceptance_criteria ?? "",
    context_budget: r.context_budget, status: r.status,
  }),
  createPath: () => "/tickets",
  createBody: (d) => ({
    product_id: d.product_id,
    title: d.title.trim(),
    description: d.description.trim() || null,
    technical_approach: d.technical_approach.trim() || null,
    acceptance_criteria: d.acceptance_criteria.trim() || null,
    context_budget: d.context_budget,
    status: d.status,
  }),
  patchPath: (r) => `/tickets/${r.id}`,
  patchBody: (d) => {
    const { product_id, ...rest } = TICKETS.createBody(d); // TicketUpdate has no product_id
    return rest;
  },
  deletePath: (r) => `/tickets/${r.id}`,
};

export const ENTITIES = [
  GOALS, CAPABILITIES, FEATURES, FEATURE_EDGES,
  MOTIVATIONS, PRODUCTS, PRODUCT_BUNDLES, TICKETS,
];

/** Lists loaded once and refreshed after every mutation, for FK labels and selects. */
export const REF_SOURCES = {
  goals: "/goals",
  capabilities: "/capabilities",
  features: "/features",
  products: "/products",
};
