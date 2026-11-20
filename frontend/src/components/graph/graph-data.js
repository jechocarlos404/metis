// Pure transform: backend /api/graph/layout response -> engine-ready graph.
// No DOM, no d3, no React — easy to unit test and safe to call on every render.

// Card size in svg units; shared with the engine so collision radius and
// edge-trim math (forceGraphEngine.js) always agree with what's drawn.
export const NODE_W = 148;
export const NODE_H = 56;

// Keyed by the feature's `layer` facet.
const LAYER_ACCENT = {
  service: "--stage-feature",
  integration: "--stage-spec",
  ui: "--stage-goal",
  infra: "--stage-ticket",
};

// distance/strength tuned so proficiency-style semantics read as spacing:
// a feature and the thing it truly depends on stay close; loose "related"
// edges are allowed to drift, so the layout doesn't read as more coupled
// than it is.
const EDGE_STYLE = {
  DEPENDS_ON: { distance: 130, strength: 0.5, dash: null, colorVar: "--ink-4" },
  BLOCKS: { distance: 150, strength: 0.35, dash: null, colorVar: "--danger-fg" },
  RELATES_TO: { distance: 190, strength: 0.12, dash: "2,4", colorVar: "--ink-4" },
};

export function edgeStyle(kind) {
  return EDGE_STYLE[kind] || EDGE_STYLE.RELATES_TO;
}

export function nodeAccentVar(layer) {
  return LAYER_ACCENT[layer] || "--ink-5";
}

/**
 * Turns the backend's dependency-depth layout into simulation input.
 * Backend x/y already encode true structure — column = dependency depth,
 * row = index within it (see FeatureGraph.layout() in the API) — so they
 * become the "anchor" position each node is weakly, continuously pulled
 * toward. Physics only ever adjusts local spacing around that anchor; it
 * can never make the graph lie about which features depend on which.
 */
export function buildFeatureGraph(layout) {
  const nodesIn = layout?.nodes ?? [];
  const edgesIn = layout?.edges ?? [];

  const degree = new Map();
  const bump = (id, key) => {
    const d = degree.get(id) ?? { in: 0, out: 0 };
    d[key] += 1;
    degree.set(id, d);
  };
  for (const e of edgesIn) {
    bump(e.src, "out");
    bump(e.dst, "in");
  }

  const nodes = nodesIn.map((n) => {
    const d = degree.get(n.id) ?? { in: 0, out: 0 };
    return {
      id: n.id,
      name: n.name,
      layer: n.facets?.layer,
      capabilityIds: n.capability_ids ?? [],
      status: n.status,
      priority: n.priority,
      inDegree: d.in,
      outDegree: d.out,
      anchorX: n.x,
      anchorY: n.y,
    };
  });

  const nodeIds = new Set(nodes.map((n) => n.id));
  const edges = edgesIn
    .filter((e) => nodeIds.has(e.src) && nodeIds.has(e.dst))
    .map((e) => ({ id: `${e.src}>${e.dst}:${e.kind}`, source: e.src, target: e.dst, kind: e.kind }));

  return { nodes, edges };
}

/** Map of node id -> Set of directly-connected node ids, for hover/select focus. */
export function buildAdjacency(edges) {
  const adjacency = new Map();
  const link = (a, b) => {
    if (!adjacency.has(a)) adjacency.set(a, new Set());
    adjacency.get(a).add(b);
  };
  for (const e of edges) {
    link(e.source, e.target);
    link(e.target, e.source);
  }
  return adjacency;
}

/**
 * Splits a name into at most `maxLines` lines of about `maxChars` characters,
 * ending with an ellipsis when it doesn't fit. Graph cards draw labels as SVG
 * text: an HTML label per card (foreignObject) made pan and zoom stutter.
 */
export function wrapLabel(name, maxChars = 19, maxLines = 2) {
  const words = String(name ?? "").split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length <= maxChars || !line) { line = next; continue; }
    lines.push(line);
    line = word;
  }
  if (line) lines.push(line);
  const cut = (s) => `${s.slice(0, maxChars - 1).trimEnd()}…`;
  const out = lines.slice(0, maxLines).map((l) => (l.length > maxChars ? cut(l) : l));
  const last = out.length - 1;
  if (lines.length > maxLines && !out[last].endsWith("…")) out[last] = cut(out[last]);
  return out;
}

/**
 * Goals as a network. One card per goal; a PART_OF line from each org goal
 * to its product goals, and a SHARES line between any two goals that motivate
 * the same capability, weighted by how many they share.
 *
 * Anchors cluster each org goal with its product goals (org in the middle,
 * product goals on a ring), clusters on a grid; product goals with no org
 * goal form their own cluster. SHARES lines are weak, so they cross between
 * clusters instead of pulling them together.
 *
 *   goals:      [{ id, goal_type, parent_goal_id, ... }]
 *   capsByGoal: { goalId: [{ id, name, slug }] }
 */
export function buildGoalNetwork(goals, capsByGoal) {
  const orgs = goals.filter((g) => g.goal_type === "org");
  const orgIds = new Set(orgs.map((o) => o.id));
  const clusters = orgs.map((o) => ({ center: o, members: goals.filter((g) => g.goal_type !== "org" && g.parent_goal_id === o.id) }));
  const loose = goals.filter((g) => g.goal_type !== "org" && !orgIds.has(g.parent_goal_id));
  if (loose.length) clusters.push({ center: null, members: loose });

  const ringR = (n) => Math.max(110, (n * (NODE_W + 24)) / (2 * Math.PI));
  const radius = (c) => (c.center || c.members.length > 1 ? ringR(c.members.length) : 0);
  // Each cluster gets a square of its own size, packed into rows about as
  // wide as a screen (16:9). One cell size for all left small clusters
  // floating in space, so the whole network fit too small to read.
  const side = (c) => 2 * radius(c) + NODE_W + 60;
  const area = clusters.reduce((sum, c) => sum + side(c) ** 2, 0);
  const rowWidth = Math.max(...clusters.map(side), Math.sqrt(area * 1.8));
  const origin = new Map();
  let x = 0;
  let y = 0;
  let rowH = 0;
  for (const c of clusters) {
    const d = side(c);
    if (x > 0 && x + d > rowWidth) {
      x = 0;
      y += rowH;
      rowH = 0;
    }
    origin.set(c, { x: x + d / 2, y: y + d / 2 });
    x += d;
    rowH = Math.max(rowH, d);
  }
  const anchor = new Map();
  clusters.forEach((c) => {
    const { x: cx, y: cy } = origin.get(c);
    if (c.center) anchor.set(c.center.id, { x: cx, y: cy });
    const r = radius(c);
    c.members.forEach((g, j) => {
      const a = (2 * Math.PI * j) / c.members.length - Math.PI / 2;
      anchor.set(g.id, { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
    });
  });

  const nodes = goals.map((g) => ({
    id: g.id,
    goal: g,
    isOrg: g.goal_type === "org",
    capCount: (capsByGoal[g.id] ?? []).length,
    anchorX: anchor.get(g.id).x,
    anchorY: anchor.get(g.id).y,
  }));

  const edges = [];
  for (const g of goals) {
    if (g.goal_type !== "org" && orgIds.has(g.parent_goal_id)) {
      edges.push({ id: `${g.parent_goal_id}>${g.id}`, source: g.parent_goal_id, target: g.id, kind: "PART_OF" });
    }
  }
  // Goals behind each capability, then every pair of them shares it.
  const goalsByCap = new Map();
  const capById = new Map();
  for (const [goalId, caps] of Object.entries(capsByGoal)) {
    for (const c of caps) {
      capById.set(c.id, c);
      if (!goalsByCap.has(c.id)) goalsByCap.set(c.id, new Set());
      goalsByCap.get(c.id).add(goalId);
    }
  }
  const known = new Set(goals.map((g) => g.id));
  const shared = new Map();
  for (const [capId, ids] of goalsByCap) {
    const list = [...ids].filter((id) => known.has(id)).sort();
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const key = `${list[i]}~${list[j]}`;
        if (!shared.has(key)) shared.set(key, { id: key, source: list[i], target: list[j], kind: "SHARES", capabilities: [] });
        shared.get(key).capabilities.push(capById.get(capId));
      }
    }
  }
  for (const e of shared.values()) {
    e.capabilities.sort((a, b) => a.name.localeCompare(b.name));
    e.weight = e.capabilities.length;
    edges.push(e);
  }
  return { nodes, edges };
}
