// Pure transform: backend /api/graph/layout response -> engine-ready graph.
// No DOM, no d3, no React — easy to unit test and safe to call on every render.

// Card size in svg units; shared with the engine so collision radius and
// edge-trim math (forceGraphEngine.js) always agree with what's drawn.
export const NODE_W = 148;
export const NODE_H = 56;
// Collision radius: the card's half-diagonal, so two cards can never overlap
// regardless of the angle they approach from.
export const NODE_COLLIDE_R = 76;

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
      capabilityId: n.capability_id,
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
