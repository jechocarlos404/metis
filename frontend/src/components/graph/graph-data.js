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
  USES: { distance: 100, strength: 0, dash: null, colorVar: "--ink-4" }, // feature -> hub: the anchors already place it
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

/** Walks parent links up to the top goal (an org goal, or a loose product goal). */
export function goalRoot(goalParent, id) {
  let cur = id;
  for (let i = 0; i < 20 && goalParent.get(cur); i++) cur = goalParent.get(cur);
  return cur;
}

// Hub views (Group by capability or goal) draw a small pill per hub and a
// line from each feature to each of its hubs.
export const HUB_W = NODE_W;
export const HUB_H = 40;
const CELL_W = NODE_W + 16; // the engine's collision box, so anchors already clear it
const CELL_H = NODE_H + 16;
const UNIT_W = CELL_W / 2; // blocks sit on a grid of half cells
const UNIT_H = CELL_H / 2;
const ASPECT = 1.6; // about the graph's frame

/** Hubs for Group by capability. `features` are /graph/layout nodes. */
export function capabilityHubs(features, capabilityById) {
  const hubs = new Map();
  const byFeature = new Map();
  for (const f of features) {
    const ids = [];
    for (const cid of f.capability_ids ?? []) {
      const c = capabilityById.get(cid);
      if (!c) continue;
      const id = `cap:${cid}`;
      ids.push(id);
      if (!hubs.has(id)) hubs.set(id, { id, name: c.name, tone: "capability", kindLabel: "Capability" });
    }
    byFeature.set(f.id, ids);
  }
  return {
    hubs: [...hubs.values()],
    byFeature,
    empty: { id: "cap:none", name: "No capability yet", tone: "empty" },
    legend: { shapes: [["capability", "Capability"]], line: "Uses this capability" },
  };
}

/**
 * Hubs for Group by goal: feature -> its capabilities -> the goals they
 * motivate. Only goals under `ownRoot` (the product goal's top goal) count,
 * the same rule as the feature panel's Why: another product's goal reaches a
 * feature through a shared capability, which is reuse, not motivation. With
 * no `ownRoot` every goal counts.
 */
export function goalHubs(features, motivations, goals, ownRoot) {
  const goalById = new Map(goals.map((g) => [g.id, g]));
  const goalParent = new Map(goals.map((g) => [g.id, g.parent_goal_id]));
  const goalsByCap = new Map();
  for (const m of motivations) {
    if (!goalsByCap.has(m.capability_id)) goalsByCap.set(m.capability_id, new Set());
    goalsByCap.get(m.capability_id).add(m.goal_id);
  }
  const hubs = new Map();
  const byFeature = new Map();
  for (const f of features) {
    const ids = new Set();
    for (const cid of f.capability_ids ?? []) {
      for (const gid of goalsByCap.get(cid) ?? []) {
        const g = goalById.get(gid);
        if (!g || (ownRoot && goalRoot(goalParent, gid) !== ownRoot)) continue;
        const id = `goal:${gid}`;
        ids.add(id);
        const org = g.goal_type === "org";
        if (!hubs.has(id)) hubs.set(id, { id, name: g.title, tone: org ? "org" : "product", kindLabel: org ? "Org goal" : "Product goal" });
      }
    }
    byFeature.set(f.id, [...ids]);
  }
  return {
    hubs: [...hubs.values()],
    byFeature,
    empty: { id: "goal:none", name: "No goal of this product yet", tone: "empty" },
    legend: {
      shapes: [["org", "Org goal"], ["product", "Product goal"], ["empty", "No goal of this product yet"]],
      line: "Its capabilities serve this goal",
    },
  };
}

/**
 * Lays features out around hubs. Each feature sits at the mean of its hubs,
 * the most-used hubs in the middle. Two exceptions keep it
 * readable:
 *  - a hub used by more than half the features (User Authentication, say)
 *    still gets its lines, but only places features that have no other hub;
 *    otherwise everything would pile into the middle.
 *  - a hub only one feature uses sits right beside that feature.
 * Features placed by the same hubs form one compact block, and blocks are
 * packed so none overlap: the engine starts from a layout that is already
 * clean (cards piled on one spot get stacked into a tall column by
 * collision).
 *
 * features: buildFeatureGraph() nodes. spec: capabilityHubs() or goalHubs().
 */
export function buildHubGraph(features, { hubs, byFeature, empty }) {
  const n = features.length;
  const hubById = new Map(hubs.map((h) => [h.id, h]));
  const hubsOf = new Map();
  for (const f of features) {
    const ids = [...new Set((byFeature.get(f.id) ?? []).filter((id) => hubById.has(id)))];
    hubsOf.set(f.id, ids.length || !empty ? ids : [empty.id]);
  }
  if (empty) hubById.set(empty.id, empty);
  const usage = new Map();
  for (const ids of hubsOf.values()) for (const id of ids) usage.set(id, (usage.get(id) ?? 0) + 1);
  const broad = new Set([...usage].filter(([, k]) => n >= 4 && k > n / 2).map(([id]) => id));

  // Which hubs place each feature (mean) and which sit beside it (side).
  const meanOf = new Map();
  const sideOf = new Map();
  for (const f of features) {
    const ids = hubsOf.get(f.id);
    const specific = ids.filter((id) => !broad.has(id));
    const anchorHubs = specific.length ? specific : ids;
    const shared = anchorHubs.filter((id) => usage.get(id) > 1);
    const mean = shared.length ? shared : anchorHubs.slice(0, 1);
    meanOf.set(f.id, mean);
    sideOf.set(f.id, anchorHubs.filter((id) => !mean.includes(id) && usage.get(id) === 1));
  }
  const sideHubs = new Set([...sideOf.values()].flat());
  const byUse = (a, b) => (a === empty?.id) - (b === empty?.id)
    || usage.get(b) - usage.get(a) || hubById.get(a).name.localeCompare(hubById.get(b).name);
  const placed = [...usage.keys()].filter((id) => !sideHubs.has(id)).sort(byUse);

  // One block per hub (the hub, then the features it places alone) and one
  // per set of two or more hubs that place the same features.
  const blocks = new Map();
  for (const id of placed) blocks.set(id, { hub: id, items: [], hubs: [id] });
  for (const f of features) {
    const mean = meanOf.get(f.id);
    const key = mean.length === 1 ? mean[0] : [...mean].sort().join("|");
    if (!blocks.has(key)) blocks.set(key, { hub: null, items: [], hubs: mean });
    blocks.get(key).items.push(f.id, ...sideOf.get(f.id));
  }
  const list = [...blocks.values()];
  for (const b of list) {
    const k = b.items.length;
    b.cols = k ? Math.ceil(Math.sqrt(k / 1.4)) : 1;
    b.rows = Math.ceil(k / b.cols);
    b.w = b.cols * CELL_W;
    b.h = b.rows * CELL_H + (b.hub ? CELL_H : 0);
  }

  // Place blocks on a grid of half cells, most-used hub first, in the middle.
  // Each hub goes as near as it can to the hubs it shares features with, and
  // each shared block as near as it can to the mean of its hubs, once they
  // are all down. One free half cell around every block keeps groups apart.
  const together = new Map(placed.map((id) => [id, new Map()]));
  for (const mean of meanOf.values()) {
    for (const a of mean) for (const b of mean) {
      if (a !== b) together.get(a).set(b, (together.get(a).get(b) ?? 0) + 1);
    }
  }
  const taken = new Set();
  const free = (gx, gy, fw, fh) => {
    for (let x = gx - 1; x <= gx + fw; x++) for (let y = gy - 1; y <= gy + fh; y++) if (taken.has(`${x},${y}`)) return false;
    return true;
  };
  const hubPos = new Map();
  const put = (b, want) => {
    const fw = b.cols * 2;
    const fh = b.rows * 2 + (b.hub ? 2 : 0);
    const cx = Math.round(want.x / UNIT_W - fw / 2);
    const cy = Math.round(want.y / UNIT_H - fh / 2);
    let best = null;
    for (let r = 4; !best; r *= 2) {
      for (let gx = cx - r; gx <= cx + r; gx++) {
        for (let gy = cy - r; gy <= cy + r; gy++) {
          // Distance in screen terms: sideways is cheaper, the frame is wide.
          const dx = (gx - cx) * UNIT_W / Math.sqrt(ASPECT);
          const dy = (gy - cy) * UNIT_H * Math.sqrt(ASPECT);
          const cost = dx * dx + dy * dy;
          if (best && cost >= best.cost) continue;
          if (free(gx, gy, fw, fh)) best = { gx, gy, cost };
        }
      }
    }
    for (let x = best.gx; x < best.gx + fw; x++) for (let y = best.gy; y < best.gy + fh; y++) taken.add(`${x},${y}`);
    b.x = (best.gx + fw / 2) * UNIT_W;
    b.y = (best.gy + fh / 2) * UNIT_H;
    if (b.hub) hubPos.set(b.hub, { x: b.x, y: b.y - b.h / 2 + CELL_H / 2 });
  };
  const meanAt = (ids, weight = () => 1) => {
    let x = 0;
    let y = 0;
    let w = 0;
    for (const id of ids) {
      const p = hubPos.get(id);
      if (!p) continue;
      x += p.x * weight(id);
      y += p.y * weight(id);
      w += weight(id);
    }
    return w ? { x: x / w, y: y / w } : { x: 0, y: 0 };
  };
  const sharedBlocks = list.filter((b) => !b.hub);
  for (const id of placed) {
    const near = together.get(id);
    put(blocks.get(id), meanAt([...near.keys()], (h) => near.get(h)));
    for (const b of sharedBlocks) {
      if (b.x == null && b.hubs.every((h) => hubPos.has(h))) put(b, meanAt(b.hubs));
    }
  }

  // Blocks -> anchors: the hub on top, then a row-major grid, last row centred.
  const anchor = new Map();
  for (const b of list) {
    const top = b.y - b.h / 2;
    if (b.hub) anchor.set(b.hub, { x: b.x, y: top + CELL_H / 2 });
    const gridTop = top + (b.hub ? CELL_H : 0);
    b.items.forEach((id, i) => {
      const row = Math.floor(i / b.cols);
      const inRow = row === b.rows - 1 ? b.items.length - row * b.cols : b.cols;
      const col = i % b.cols;
      anchor.set(id, { x: b.x + (col - (inRow - 1) / 2) * CELL_W, y: gridTop + (row + 0.5) * CELL_H });
    });
  }

  const nodes = [
    ...features.map((f) => ({ ...f, anchorX: anchor.get(f.id).x, anchorY: anchor.get(f.id).y })),
    ...[...usage.keys()].sort(byUse).map((id) => ({
      ...hubById.get(id), hub: true, count: usage.get(id),
      width: HUB_W, height: HUB_H, anchorX: anchor.get(id).x, anchorY: anchor.get(id).y,
    })),
  ];
  const edges = features.flatMap((f) => hubsOf.get(f.id).map((h) => ({
    id: `${f.id}>${h}`, source: f.id, target: h, kind: "USES",
    faint: broad.has(h) && !meanOf.get(f.id).includes(h),
  })));
  return { nodes, edges };
}
