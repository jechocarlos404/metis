// Framework-agnostic force-directed graph engine.
//
// The split that matters: React renders <g>/<line> elements and owns their
// color, opacity, and text (low-frequency — normal re-renders are fine).
// This module owns *position* — it never creates or removes an element and
// never touches React state. React hands it elements via registerNode /
// registerEdge; from then on every x/y write is a direct DOM mutation from
// one requestAnimationFrame loop, so a 60fps simulation can never trigger a
// React re-render.
//
// Why this needs more than "call simulation.tick() in a rAF loop":
//  - d3-force's own timer drives ticks off rAF too, so naively there's no
//    difference — except we render on the very same loop that steps physics
//    (one batched read-then-write pass), and we fix three concrete jitter
//    sources that a bare tick->paint hookup has: (1) physics speed is
//    display-refresh-rate-dependent unless steps are paced to a fixed
//    interval — see the accumulator below; (2) raw simulation coordinates
//    drawn 1:1 show every bit of high-frequency numerical noise from forces
//    fighting each other — see the render-position smoothing below; (3) the
//    loop never truly goes idle, so a "settled" graph keeps re-painting
//    forever — see the settle/pause logic below.
import { forceSimulation, forceLink, forceManyBody, forceCollide, forceX, forceY } from "d3-force";
import { select } from "d3-selection";
import { zoom as d3zoom, zoomIdentity } from "d3-zoom";
import { drag as d3drag } from "d3-drag";

const DEFAULTS = {
  nodeSize: { width: 148, height: 56 },
  nodeRadius: () => 76,
  linkDistance: () => 140,
  linkStrength: () => 0.3,
  chargeStrength: -220,
  chargeMaxDistance: 460,
  anchorStrengthX: 0.045,
  anchorStrengthY: 0.065,
  alphaDecay: 0.03,
  velocityDecay: 0.44,
  scaleExtent: [0.2, 2.5],
  renderTauMs: 70, // low-pass time constant for the render-position smoothing
  reducedMotion: false,
};

const TICK_MS = 1000 / 60;
const MAX_STEPS_PER_FRAME = 4; // caps the catch-up burst after a stalled/backgrounded tab
const SETTLE_EPS_PX = 0.035; // snap-to-target below this so smoothing doesn't chase forever
const WRITE_EPS_PX = 0.04; // skip a DOM write when the change is imperceptible

function cubicOut(t) {
  const p = t - 1;
  return p * p * p + 1;
}

/** Offset from a rect's center to where a ray toward (dx,dy) exits its boundary. */
function trimToRect(dx, dy, halfW, halfH) {
  if (dx === 0 && dy === 0) return { dx: 0, dy: 0 };
  const tx = dx !== 0 ? halfW / Math.abs(dx) : Infinity;
  const ty = dy !== 0 ? halfH / Math.abs(dy) : Infinity;
  const t = Math.min(tx, ty);
  return { dx: dx * t, dy: dy * t };
}

export function createForceGraph(opts) {
  const o = { ...DEFAULTS, ...opts };
  const { svgEl, viewportEl, onSelect, onPinChange } = o;
  const halfW = o.nodeSize.width / 2;
  const halfH = o.nodeSize.height / 2;

  let reducedMotion = !!o.reducedMotion;

  const simulation = forceSimulation([])
    .alphaDecay(o.alphaDecay)
    .velocityDecay(o.velocityDecay)
    .force(
      "link",
      forceLink([])
        .id((d) => d.id)
        .distance(o.linkDistance)
        .strength(o.linkStrength)
    )
    .force("charge", forceManyBody().strength(o.chargeStrength).distanceMax(o.chargeMaxDistance))
    .force("collide", forceCollide().radius(o.nodeRadius).strength(0.8).iterations(2))
    .force("anchorX", forceX((d) => d.anchorX).strength(o.anchorStrengthX))
    .force("anchorY", forceY((d) => d.anchorY).strength(o.anchorStrengthY))
    .stop(); // we drive every tick ourselves below — letting d3's own timer run too would double-step physics

  const nodeById = new Map(); // id -> sim node {id,anchorX,anchorY,x,y,vx,vy,fx,fy}
  const nodeEls = new Map(); // id -> registered <g>
  const edgeEls = new Map(); // id -> {el, source, target}
  const renderPos = new Map(); // id -> smoothed/drawn {x,y}
  let edgesMeta = [];

  let draggingId = null;
  let rafHandle = null;
  let lastFrameT = null;
  let accumulator = 0;
  // {from,to,start,duration} while animating a programmatic zoom change
  // (fit-to-view or a toolbar zoom button) — one tween at a time, stepped
  // from the same rAF loop that drives physics so there's a single clock
  // driving every visual change instead of a second, independent one.
  let transformAnimation = null;

  let currentTransform = zoomIdentity;

  // ---------------------------------------------------------------- zoom --
  const zoomBehavior = d3zoom()
    .scaleExtent(o.scaleExtent)
    .on("zoom", (event) => {
      if (event.sourceEvent) transformAnimation = null; // a real gesture always wins over a running tween
      currentTransform = event.transform;
      viewportEl.setAttribute("transform", currentTransform.toString());
    });
  select(svgEl).call(zoomBehavior).on("dblclick.zoom", null); // dblclick is reserved for unpinning

  function handleBackgroundDblClick(event) {
    const host = event.target.closest("[data-node-id]");
    if (!host) return;
    const node = nodeById.get(host.dataset.nodeId);
    if (!node || node.fx == null) return;
    node.fx = null;
    node.fy = null;
    onPinChange && onPinChange(node.id, false);
    reheat(0.25);
  }
  svgEl.addEventListener("dblclick", handleBackgroundDblClick);

  // ---------------------------------------------------------------- drag --
  let dragMoved = false;
  const dragBehavior = d3drag()
    .on("start", (event, d) => {
      draggingId = d.id;
      dragMoved = false;
      if (!event.active) simulation.alphaTarget(0.12);
      reheat(0.12);
      onSelect && onSelect(d.id);
    })
    .on("drag", (event, d) => {
      dragMoved = true;
      d.fx = event.x;
      d.fy = event.y;
      renderPos.set(d.id, { x: event.x, y: event.y });
    })
    .on("end", (event, d) => {
      draggingId = null;
      if (!event.active) simulation.alphaTarget(0);
      if (!dragMoved) {
        d.fx = null;
        d.fy = null;
      }
      onPinChange && onPinChange(d.id, dragMoved);
      ensureLoopRunning();
    });

  // ------------------------------------------------------ attach helpers --
  // Registration (React ref) and data (update()) can arrive in either
  // order; both paths call tryAttach so a node is only ever positioned once
  // *both* its element and its simulation data exist.
  function tryAttach(id) {
    const el = nodeEls.get(id);
    const n = nodeById.get(id);
    if (!el || !n) return;
    if (!el.__dragBound) {
      select(el).datum(n).call(dragBehavior);
      el.__dragBound = true;
    }
    if (!renderPos.has(id)) renderPos.set(id, { x: n.anchorX, y: n.anchorY });
    el.__lastPos = null; // force the next paint to actually write, even if position is unchanged
    paintNode(id);
  }

  function syncEdgeMeta(id) {
    const entry = edgeEls.get(id);
    if (!entry) return;
    const meta = edgesMeta.find((e) => e.id === id);
    if (!meta) return;
    entry.source = meta.source;
    entry.target = meta.target;
    entry.el.__lastLine = null;
    paintEdge(id);
  }

  // ------------------------------------------------------------ painting --
  function paintNode(id) {
    const el = nodeEls.get(id);
    const p = renderPos.get(id);
    if (!el || !p) return;
    const last = el.__lastPos;
    if (last && Math.abs(last.x - p.x) < WRITE_EPS_PX && Math.abs(last.y - p.y) < WRITE_EPS_PX) return;
    el.setAttribute("transform", `translate(${p.x.toFixed(2)},${p.y.toFixed(2)})`);
    el.__lastPos = { x: p.x, y: p.y };
  }

  function paintEdge(id) {
    const entry = edgeEls.get(id);
    if (!entry) return;
    const s = nodeById.get(entry.source);
    const t = nodeById.get(entry.target);
    if (!s || !t) return;
    const sp = renderPos.get(s.id) ?? { x: s.x, y: s.y };
    const tp = renderPos.get(t.id) ?? { x: t.x, y: t.y };
    let dx = tp.x - sp.x;
    let dy = tp.y - sp.y;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) dy = 0.5; // degenerate same-spot edge: draw a hairline, not NaN
    const a = trimToRect(dx, dy, halfW, halfH);
    const b = trimToRect(-dx, -dy, halfW, halfH);
    const x1 = sp.x + a.dx;
    const y1 = sp.y + a.dy;
    // b is the offset from the target's center to its near boundary (facing
    // the source) — add it, don't subtract, or the endpoint lands on the
    // rect's far side and the line is drawn straight through the card.
    const x2 = tp.x + b.dx;
    const y2 = tp.y + b.dy;
    const { el } = entry;
    const last = el.__lastLine;
    if (
      last &&
      Math.abs(last.x1 - x1) < WRITE_EPS_PX &&
      Math.abs(last.y1 - y1) < WRITE_EPS_PX &&
      Math.abs(last.x2 - x2) < WRITE_EPS_PX &&
      Math.abs(last.y2 - y2) < WRITE_EPS_PX
    )
      return;
    el.setAttribute("x1", x1.toFixed(2));
    el.setAttribute("y1", y1.toFixed(2));
    el.setAttribute("x2", x2.toFixed(2));
    el.setAttribute("y2", y2.toFixed(2));
    el.__lastLine = { x1, y1, x2, y2 };
  }

  // ------------------------------------------------------------- the loop --
  function frame(t) {
    rafHandle = null;
    if (lastFrameT == null) lastFrameT = t;
    let dt = t - lastFrameT;
    lastFrameT = t;
    if (dt > 100) dt = 100; // clamp the catch-up after a stalled/backgrounded tab

    if (transformAnimation) stepTransformAnimation(t);

    if (reducedMotion) {
      if (simulation.alpha() > simulation.alphaMin()) simulation.tick();
    } else {
      accumulator += dt;
      let steps = 0;
      while (accumulator >= TICK_MS && steps < MAX_STEPS_PER_FRAME) {
        simulation.tick();
        accumulator -= TICK_MS;
        steps++;
      }
    }

    let settled = simulation.alpha() <= simulation.alphaMin();
    for (const n of nodeById.values()) {
      const target = n.fx != null ? { x: n.fx, y: n.fy } : { x: n.x, y: n.y };
      let p = renderPos.get(n.id);
      if (!p) {
        p = { ...target };
        renderPos.set(n.id, p);
      }
      if (n.id === draggingId || reducedMotion) {
        p.x = target.x;
        p.y = target.y;
      } else {
        const dx = target.x - p.x;
        const dy = target.y - p.y;
        if (Math.abs(dx) < SETTLE_EPS_PX && Math.abs(dy) < SETTLE_EPS_PX) {
          p.x = target.x;
          p.y = target.y;
        } else {
          const k = 1 - Math.exp(-dt / o.renderTauMs);
          p.x += dx * k;
          p.y += dy * k;
          settled = false; // still easing toward target — keep the loop alive
        }
      }
      paintNode(n.id);
    }
    for (const id of edgeEls.keys()) paintEdge(id);

    if (!settled || draggingId != null || transformAnimation) {
      rafHandle = requestAnimationFrame(frame);
    }
  }

  function ensureLoopRunning() {
    if (rafHandle == null) {
      lastFrameT = null;
      rafHandle = requestAnimationFrame(frame);
    }
  }

  function reheat(minAlpha) {
    if (simulation.alpha() < minAlpha) simulation.alpha(minAlpha);
    ensureLoopRunning();
  }

  // ---------------------------------------------------- programmatic zoom --
  // Applying the transform directly (not via d3-zoom's own .transform()
  // convenience + d3-transition) keeps every animated visual change on the
  // one rAF clock this module already drives for physics.
  function animateTransform(target, duration) {
    if (reducedMotion || duration <= 0) {
      transformAnimation = null;
      zoomBehavior.transform(select(svgEl), target);
      return;
    }
    transformAnimation = { from: currentTransform, to: target, start: null, duration };
    ensureLoopRunning();
  }

  function stepTransformAnimation(t) {
    if (transformAnimation.start == null) transformAnimation.start = t;
    const p = Math.min(1, (t - transformAnimation.start) / transformAnimation.duration);
    const e = cubicOut(p);
    const { from, to } = transformAnimation;
    const k = from.k + (to.k - from.k) * e;
    const x = from.x + (to.x - from.x) * e;
    const y = from.y + (to.y - from.y) * e;
    zoomBehavior.transform(select(svgEl), zoomIdentity.translate(x, y).scale(k));
    if (p >= 1) transformAnimation = null;
  }

  function fitToView(duration = 450) {
    const pts = Array.from(renderPos.values());
    if (!pts.length) return;
    const pad = Math.max(o.nodeSize.width, o.nodeSize.height) / 2 + 32;
    const xMin = Math.min(...pts.map((p) => p.x)) - pad;
    const xMax = Math.max(...pts.map((p) => p.x)) + pad;
    const yMin = Math.min(...pts.map((p) => p.y)) - pad;
    const yMax = Math.max(...pts.map((p) => p.y)) + pad;
    const w = svgEl.clientWidth || 1;
    const h = svgEl.clientHeight || 1;
    const spanX = Math.max(1, xMax - xMin);
    const spanY = Math.max(1, yMax - yMin);
    const k = Math.min(o.scaleExtent[1], Math.max(o.scaleExtent[0], Math.min(w / spanX, h / spanY)));
    const cx = (xMin + xMax) / 2;
    const cy = (yMin + yMax) / 2;
    animateTransform(zoomIdentity.translate(w / 2 - cx * k, h / 2 - cy * k).scale(k), duration);
  }

  function zoomBy(factor) {
    const w = svgEl.clientWidth || 1;
    const h = svgEl.clientHeight || 1;
    const cx = w / 2;
    const cy = h / 2;
    const t0 = currentTransform;
    const k1 = Math.min(o.scaleExtent[1], Math.max(o.scaleExtent[0], t0.k * factor));
    const wx = (cx - t0.x) / t0.k;
    const wy = (cy - t0.y) / t0.k;
    animateTransform(zoomIdentity.translate(cx - wx * k1, cy - wy * k1).scale(k1), 180);
  }

  // ------------------------------------------------------------- public API --
  function registerNode(id, el) {
    nodeEls.set(id, el);
    tryAttach(id);
  }
  function unregisterNode(id, el) {
    if (nodeEls.get(id) === el) nodeEls.delete(id);
  }
  function registerEdge(id, el) {
    edgeEls.set(id, { el, source: null, target: null });
    syncEdgeMeta(id);
  }
  function unregisterEdge(id, el) {
    const cur = edgeEls.get(id);
    if (cur && cur.el === el) edgeEls.delete(id);
  }

  function update(nextNodes, nextEdges) {
    const nextIds = new Set(nextNodes.map((n) => n.id));
    let structuralChange = false;

    for (const id of Array.from(nodeById.keys())) {
      if (!nextIds.has(id)) {
        nodeById.delete(id);
        renderPos.delete(id);
        structuralChange = true;
      }
    }

    let anchorMoved = false;
    for (const meta of nextNodes) {
      const existing = nodeById.get(meta.id);
      if (existing) {
        if (existing.anchorX !== meta.anchorX || existing.anchorY !== meta.anchorY) {
          anchorMoved = true;
          existing.anchorX = meta.anchorX;
          existing.anchorY = meta.anchorY;
        }
      } else {
        nodeById.set(meta.id, {
          id: meta.id,
          anchorX: meta.anchorX,
          anchorY: meta.anchorY,
          x: meta.anchorX,
          y: meta.anchorY,
          vx: 0,
          vy: 0,
          fx: null,
          fy: null,
        });
        structuralChange = true;
      }
    }

    const prevEdgeIds = new Set(edgesMeta.map((e) => e.id));
    const nextEdgeIds = new Set(nextEdges.map((e) => e.id));
    if (
      prevEdgeIds.size !== nextEdgeIds.size ||
      [...prevEdgeIds].some((id) => !nextEdgeIds.has(id))
    ) {
      structuralChange = true;
    }
    edgesMeta = nextEdges.map((e) => ({ ...e }));

    simulation.nodes(Array.from(nodeById.values()));
    simulation.force("link").links(edgesMeta.map((e) => ({ ...e })));

    for (const id of Array.from(edgeEls.keys())) {
      if (!nextEdgeIds.has(id)) edgeEls.delete(id);
      else syncEdgeMeta(id);
    }
    for (const meta of nextNodes) tryAttach(meta.id);

    if (structuralChange) reheat(0.35);
    else if (anchorMoved) reheat(0.18);
  }

  function setReducedMotion(value) {
    reducedMotion = !!value;
    if (reducedMotion) {
      for (const n of nodeById.values()) {
        renderPos.set(n.id, { x: n.fx ?? n.x, y: n.fy ?? n.y });
      }
      ensureLoopRunning();
    }
  }

  function destroy() {
    if (rafHandle != null) cancelAnimationFrame(rafHandle);
    simulation.stop();
    select(svgEl).on(".zoom", null);
    svgEl.removeEventListener("dblclick", handleBackgroundDblClick);
  }

  return {
    registerNode,
    unregisterNode,
    registerEdge,
    unregisterEdge,
    update,
    fitToView,
    zoomBy,
    setReducedMotion,
    destroy,
  };
}
