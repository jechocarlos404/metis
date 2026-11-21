import React from "react";
import { Icon, IconButton } from "../../ds";
import { createForceGraph } from "./forceGraphEngine.js";
import { buildFeatureGraph, buildHubGraph, buildAdjacency, edgeStyle, nodeAccentVar, wrapLabel, NODE_W, NODE_H, HUB_W, HUB_H, LABEL_PX } from "./graph-data.js";
import { EDGE, LAYER, count, statusLabel } from "../../lib/words.js";
import { Term } from "../shared/Term.jsx";

// useLayoutEffect must win in the browser (it runs before paint, so a
// freshly-mounted node is positioned before the user ever sees a frame at
// the origin) but SSR has no paint to block and warns on useLayoutEffect —
// this is the standard escape hatch.
const useIsomorphicLayoutEffect = typeof window !== "undefined" ? React.useLayoutEffect : React.useEffect;

const EDGE_KINDS = ["DEPENDS_ON", "BLOCKS", "RELATES_TO"];
// px above the drawing for the controls, which end 44px down (10 above, 34 tall).
const CONTROL_STRIP = 46;
const STATUS_DOT = { pending: "var(--text-secondary)", in_progress: "var(--warn-fg)", done: "var(--ok-fg)" };

// `hubs` (capabilityHubs() or goalHubs() from graph-data.js) groups the
// features around hub pills instead of laying them out in build order.
// Grey lines go near-black when lit; coloured ones (blocks) keep their colour.
const litColor = (kind) => (edgeStyle(kind).colorVar === "--ink-4" ? "--ink-6" : edgeStyle(kind).colorVar);

export function FeatureGraphView({ layout, hubs, selectedId, onSelect, recheckStates, cutStates, fadedIds, style, fitKey }) {
  const svgRef = React.useRef(null);
  const viewportRef = React.useRef(null);
  const engineRef = React.useRef(null);
  const nodeElsRef = React.useRef(new Map());
  const edgeElsRef = React.useRef(new Map());
  const onSelectRef = React.useRef(onSelect);
  const hasFitRef = React.useRef(false);
  const legendRef = React.useRef(null);
  const toolbarRef = React.useRef(null);

  const [pinned, setPinned] = React.useState(() => new Set());
  const [hoveredId, setHoveredId] = React.useState(null);
  const [reducedMotion, setReducedMotion] = React.useState(
    () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );

  const graphData = React.useMemo(() => {
    const features = buildFeatureGraph(layout);
    return hubs ? buildHubGraph(features.nodes, hubs) : features;
  }, [layout, hubs]);
  const adjacency = React.useMemo(() => buildAdjacency(graphData.edges), [graphData]);
  const hubIds = React.useMemo(() => new Set(graphData.nodes.filter((n) => n.hub).map((n) => n.id)), [graphData]);

  useIsomorphicLayoutEffect(() => {
    // Dragging any node reports it; a hub is not a feature, so it selects nothing.
    onSelectRef.current = (id) => {
      if (onSelect && !hubIds.has(id)) onSelect(id);
    };
  });

  React.useEffect(() => {
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReducedMotion(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  // Engine lifecycle: created exactly once. Recreating it on every data
  // change would throw away simulation state (positions/velocities) and
  // defeat the entire point of smooth transitions between data updates.
  useIsomorphicLayoutEffect(() => {
    // The key starts folded; folded or open, it and the zoom buttons are
    // framed around, never drawn over.
    const engine = createForceGraph({
      frameInsets: () => controlInsets(legendRef.current, toolbarRef.current, svgRef.current),
      svgEl: svgRef.current,
      viewportEl: viewportRef.current,
      nodeSize: { width: NODE_W, height: NODE_H },
      // The server already places each product on a tidy grid (200 x 96 per
      // card, dependencies left). Let that grid lead: strong anchors, faint
      // repulsion and lines, card-shaped collision, a quick settle. Free
      // forces spread big products until they fit too small to read.
      collideRect: { width: NODE_W + 16, height: NODE_H + 16 },
      chargeStrength: -20,
      anchorStrengthX: 0.5,
      anchorStrengthY: 0.5,
      alphaDecay: 0.06,
      linkDistance: (e) => edgeStyle(e.kind).distance,
      linkStrength: (e) => edgeStyle(e.kind).strength * 0.1,
      reducedMotion,
      onSelect: (id) => onSelectRef.current && onSelectRef.current(id),
      onPinChange: (id, isPinned) => {
        setPinned((prev) => {
          if (isPinned === prev.has(id)) return prev;
          const next = new Set(prev);
          isPinned ? next.add(id) : next.delete(id);
          return next;
        });
      },
    });
    engineRef.current = engine;
    for (const [id, el] of nodeElsRef.current) engine.registerNode(id, el);
    for (const [id, el] of edgeElsRef.current) engine.registerEdge(id, el);
    return () => {
      engine.destroy();
      engineRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useIsomorphicLayoutEffect(() => {
    engineRef.current?.setReducedMotion(reducedMotion);
  }, [reducedMotion]);

  // Grouped, a graph opens on what it is grouped by: its hubs centred, the
  // biggest group first and as many more as fit with it, "linked to none"
  // counted like the rest (B35). In build order, on the selected feature.
  const openFocus = () => {
    const hubs = graphData.nodes.filter((n) => n.hub).sort((a, b) => b.count - a.count);
    return hubs.length ? { ids: hubs.map((n) => n.id), centre: true } : selectedId;
  };

  useIsomorphicLayoutEffect(() => {
    engineRef.current?.update(graphData.nodes, graphData.edges);
    if (!hasFitRef.current && graphData.nodes.length) {
      hasFitRef.current = true;
      engineRef.current?.openView(openFocus(), 0);
      engineRef.current?.openWhenSettled(openFocus()); // the first frame sees unspread nodes
    }
  }, [graphData]);

  // A new filter shows a different set of nodes: frame them.
  const lastFitKey = React.useRef(fitKey);
  useIsomorphicLayoutEffect(() => {
    if (lastFitKey.current === fitKey) return;
    lastFitKey.current = fitKey;
    engineRef.current?.openWhenSettled(openFocus());
  }, [fitKey]);

  // A feature picked outside the canvas is brought into view.
  useIsomorphicLayoutEffect(() => {
    if (selectedId != null) engineRef.current?.reveal(selectedId);
  }, [selectedId]);

  // With a cut overlay active, tier coloring owns the canvas — selection no
  // longer dims non-neighbors (hover still focuses transiently). Same when
  // grouped by hubs: every feature has a hub line, so selection would fade
  // the whole graph; the selected ring is enough there.
  const wantFocus = hoveredId ?? (cutStates != null || recheckStates != null || hubs ? null : selectedId) ?? null;
  // Fade the rest only when the focused card has relationships to show;
  // fading everything around a loner just makes the graph hard to read.
  const focusId = wantFocus != null && adjacency.get(wantFocus)?.size ? wantFocus : null;
  const focusNeighbors = focusId ? adjacency.get(focusId) : null;
  // Zoomed out, names are hidden on the cards; the caption names this one.
  const nameId = hoveredId ?? selectedId;
  const named = nameId != null ? graphData.nodes.find((n) => n.id === nameId) : null;

  const edgeRef = (id) => (el) => {
    if (!el) return;
    edgeElsRef.current.set(id, el);
    engineRef.current?.registerEdge(id, el);
    return () => {
      edgeElsRef.current.delete(id);
      engineRef.current?.unregisterEdge(id, el);
    };
  };
  const nodeRef = (id) => (el) => {
    if (!el) return;
    nodeElsRef.current.set(id, el);
    engineRef.current?.registerNode(id, el);
    return () => {
      nodeElsRef.current.delete(id);
      engineRef.current?.unregisterNode(id, el);
    };
  };

  return (
    // The drawing starts under the strip the Key and zoom buttons (and a wide
    // screen's Group by bar) sit in, so no card is ever drawn under them (C30).
    <div className="graph-hint-room" style={{ position: "relative", width: "100%", height: "100%", paddingTop: CONTROL_STRIP, boxSizing: "border-box", ...style }}>
      <svg
        ref={svgRef}
        style={{ width: "100%", height: "100%", display: "block", cursor: "grab", touchAction: "none" }}
      >
        <defs>
          {EDGE_KINDS.flatMap((kind) => [false, true].map((lit) => (
            // markerUnits is strokeWidth, so the lit (wider) arrow is drawn smaller to match.
            <marker key={`${kind}${lit ? "-lit" : ""}`} id={`graph-arrow-${kind}${lit ? "-lit" : ""}`} viewBox="0 0 10 10" refX="9" refY="5"
              markerWidth={lit ? 4.5 : 7} markerHeight={lit ? 4.5 : 7} orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill={`var(${lit ? litColor(kind) : edgeStyle(kind).colorVar})`} />
            </marker>
          )))}
        </defs>
        <g ref={viewportRef}>
          <g>
            {graphData.edges.map((e) => {
              const st = edgeStyle(e.kind);
              const cutDim = cutStates != null &&
                (cutStates.get(e.source) === "deferrable" || cutStates.get(e.target) === "deferrable");
              const fadeDim = fadedIds != null && (fadedIds.has(e.source) || fadedIds.has(e.target));
              const dim = cutDim || fadeDim || (focusId != null && e.source !== focusId && e.target !== focusId);
              // The focused card's own lines stand out: darker, wider, opaque.
              const lit = !dim && focusId != null;
              if (e.kind === "USES") {
                return (
                  <line key={e.id} ref={edgeRef(e.id)} stroke={`var(${st.colorVar})`} strokeWidth={lit ? 2 : 1}
                    opacity={dim ? 0.06 : lit ? 0.9 : e.faint ? 0.12 : 0.35}
                    style={{ transition: "opacity var(--dur-med) var(--ease-out)" }} />
                );
              }
              return (
                <line
                  key={e.id}
                  ref={edgeRef(e.id)}
                  stroke={`var(${lit ? litColor(e.kind) : st.colorVar})`}
                  strokeWidth={(e.kind === "DEPENDS_ON" || e.kind === "BLOCKS" ? 1.6 : 1.2) + (lit ? 1 : 0)}
                  strokeDasharray={st.dash || undefined}
                  markerEnd={`url(#graph-arrow-${e.kind}${lit ? "-lit" : ""})`}
                  opacity={dim ? 0.08 : lit ? 1 : e.kind === "RELATES_TO" ? 0.4 : 0.6}
                  style={{ transition: "opacity var(--dur-med) var(--ease-out)" }}
                />
              );
            })}
          </g>
          <g>
            {graphData.nodes.map((n) => n.hub ? (
              <HubNode
                key={n.id}
                node={n}
                isDimmed={focusId != null && focusId !== n.id && !focusNeighbors?.has(n.id)}
                onHoverChange={setHoveredId}
                registerEl={nodeRef(n.id)}
              />
            ) : (
              <FeatureNode
                key={n.id}
                node={n}
                isSelected={selectedId === n.id}
                isTabStop={selectedId ? selectedId === n.id : n.id === graphData.nodes[0]?.id}
                isHovered={hoveredId === n.id}
                isDimmed={focusId != null && focusId !== n.id && !focusNeighbors?.has(n.id)}
                isFaded={fadedIds ? fadedIds.has(n.id) : false}
                recheck={recheckStates ? recheckStates.get(n.id) : null}
                cutState={cutStates ? cutStates.get(n.id) : null}
                isPinned={pinned.has(n.id)}
                onSelect={onSelect}
                onHoverChange={setHoveredId}
                registerEl={nodeRef(n.id)}
              />
            ))}
          </g>
        </g>
      </svg>

      <GraphToolbar
        onZoomIn={() => engineRef.current?.zoomBy(1.4)}
        onZoomOut={() => engineRef.current?.zoomBy(1 / 1.4)}
        onFit={() => engineRef.current?.fitToView()}
        toolbarRef={toolbarRef}
      />
      <GraphLegend legendRef={legendRef} cutActive={cutStates != null} recheckActive={recheckStates != null} hubs={hubs} graphData={graphData} />

      <GraphCaption name={named?.hub ? `${named.name} · ${count(named.count, "feature")}` : named?.name} />

      {graphData.nodes.length === 0 && (
        <div style={{
          position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: "var(--text-sm)", color: "var(--text-secondary)", pointerEvents: "none",
        }}>
          No features to show.
        </div>
      )}
    </div>
  );
}

function FeatureNode({ node, isSelected, isTabStop, isHovered, isDimmed, isFaded, recheck, cutState, isPinned, onSelect, onHoverChange, registerEl }) {
  const accent = `var(${nodeAccentVar(node.layer)})`;
  const ring = isSelected ? "var(--accent)"
    : recheck === "breaks" ? "var(--danger-fg)"
    : recheck === "retest" ? "var(--warn-fg)"
    : cutState === "target" ? "var(--accent)"
    : cutState === "essential" ? "var(--ok-fg)"
    : isHovered ? "var(--text-secondary)" : "var(--border-control)"; // 3:1 on the card, like a goal box
  const ringWide = isSelected || recheck != null || cutState === "target" || cutState === "essential";
  // Deferrable and filtered-out nodes fade like focus-dimming does, but stay
  // readable on hover/select.
  const isDeferred = (cutState === "deferrable" || isFaded) && !isHovered && !isSelected;
  return (
    <g
      ref={registerEl}
      data-node-id={node.id}
      // One tab stop for the whole graph (the selected node, else the first);
      // the Directory tab is the keyboard route through every feature.
      tabIndex={isTabStop ? 0 : -1}
      className={isDimmed || isDeferred ? "graph-node is-dim" : "graph-node"}
      role="button"
      aria-label={node.name}
      aria-pressed={isSelected}
      onMouseEnter={() => onHoverChange(node.id)}
      onMouseLeave={() => onHoverChange(null)}
      onFocus={() => onHoverChange(node.id)}
      onBlur={() => onHoverChange(null)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect && onSelect(node.id);
        }
      }}
      style={{ cursor: "grab" }}
    >
      <title>{node.name}</title>
      <rect
        x={-NODE_W / 2} y={-NODE_H / 2} width={NODE_W} height={NODE_H} rx={8}
        fill="var(--surface-card)" stroke={ring} strokeWidth={ringWide ? 1.5 : 1}
        style={{
          // A shadow on every card made each zoom step redraw all labels; only the focused card gets one.
          filter: isHovered || isSelected ? "drop-shadow(var(--shadow-raised))" : "none",
          transition: "stroke var(--dur-fast) var(--ease-out), filter var(--dur-fast) var(--ease-out)",
        }}
      />
      <circle cx={NODE_W / 2 - 12} cy={-NODE_H / 2 + 12} r={3} fill={STATUS_DOT[node.status] || STATUS_DOT.pending} />
      {isPinned && (
        <g transform={`translate(${NODE_W / 2 - 22},${NODE_H / 2 - 22})`}>
          <circle cx="9" cy="9" r="9" fill="var(--surface-card)" stroke="var(--border-hairline)" />
          <g transform="translate(2,2)" color="var(--text-secondary)">
            <Icon name="pin" size={14} />
          </g>
        </g>
      )}
      {node.layer && <circle cx={-NODE_W / 2 + 11} cy={0} r={3} fill={accent} />}
      <CardLabel name={node.name} x={-NODE_W / 2 + 19} />
    </g>
  );
}

const HUB_TONE = {
  capability: { fill: "var(--accent-wash)", stroke: "var(--accent)", text: "var(--text-accent)" },
  product: { fill: "var(--accent-wash)", stroke: "var(--accent)", text: "var(--text-accent)" },
  org: { fill: "var(--surface-inverse)", stroke: "var(--surface-inverse)", text: "var(--text-inverse)" },
  empty: { fill: "var(--surface-card)", stroke: "var(--border-control)", text: "var(--text-secondary)", dash: "4,3" },
};

// A capability or goal the features are grouped by. Not a feature, so it is
// not a tab stop and clicking it selects nothing; hover shows its features.
function HubNode({ node, isDimmed, onHoverChange, registerEl }) {
  const tone = HUB_TONE[node.tone] ?? HUB_TONE.capability;
  const label = `${node.kindLabel ? `${node.kindLabel}: ` : ""}${node.name}, ${count(node.count, "feature")}`;
  return (
    <g ref={registerEl} data-node-id={node.id} role="img" aria-label={label}
      className={isDimmed ? "graph-node is-dim" : "graph-node"}
      onMouseEnter={() => onHoverChange(node.id)} onMouseLeave={() => onHoverChange(null)}
      style={{ cursor: "grab" }}>
      <title>{label}</title>
      <HubPill tone={tone} />
      <CardLabel name={node.name} x={0} anchor="middle" fill={tone.text} after={count(node.count, "feature")} />
    </g>
  );
}

function HubPill({ tone, w = HUB_W, h = HUB_H }) {
  return <rect x={-w / 2} y={-h / 2} width={w} height={h} rx={h / 2} fill={tone.fill} stroke={tone.stroke} strokeDasharray={tone.dash} />;
}

// SVG text, not an HTML foreignObject: 462 HTML labels made pan and zoom
// drop to about 29fps. Hidden when zoomed out too far to read (.graph-far).
// `after`: one more line under the name, such as a hub's feature count.
export function CardLabel({ name, x, fill = "var(--text-heading)", anchor, maxLines = 2, after }) {
  const lines = after ? [...wrapLabel(name, 19, maxLines), after] : wrapLabel(name, 19, maxLines);
  const lineH = 14;
  return (
    <text x={x} y={-((lines.length - 1) * lineH) / 2} dominantBaseline="central" fill={fill} textAnchor={anchor}
      style={{ fontFamily: "var(--font-body)", fontSize: LABEL_PX, fontWeight: 500, pointerEvents: "none" }}>
      {lines.map((l, i) => <tspan key={i} x={x} dy={i === 0 ? 0 : lineH}>{l}</tspan>)}
    </text>
  );
}

// Zoomed out (.graph-far) the cards drop their names, so the card pointed at,
// focused or selected is named here, at text size, in place of the line on
// how to move things (shown only on a wide screen with a mouse). base.css
// switches between them; render after the <svg>.
export function GraphCaption({ name }) {
  const chip = {
    position: "absolute", bottom: 10, left: 10, maxWidth: "calc(100% - 20px)", pointerEvents: "none",
    background: "var(--surface-card)", border: "1px solid var(--border-hairline)", borderRadius: "var(--radius-sm)",
    boxShadow: "var(--shadow-card)", padding: "4px 10px",
  };
  return (
    <>
      {/* One line: a corner chip, never a block over the drawing. */}
      {name && <div className="graph-caption" style={{ ...chip, fontSize: "var(--text-sm)", color: "var(--text-heading)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{name}</div>}
      <div className="graph-hint" style={{ ...chip, fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", color: "var(--text-secondary)" }}>
        drag to move · double-click to release · scroll to zoom
      </div>
    </>
  );
}

/**
 * The px a graph keeps clear of the controls drawn over its canvas when it
 * frames itself (Fit, open, centring a pick): the strip along the top that
 * the folded key, the zoom buttons and a wide screen's Group by bar share;
 * and, with the key open, beside it or under it, whichever leaves more of the
 * canvas (a tall key: beside; the goals' wide one: under); and the strip along
 * the bottom the corner chip sits in (the hint, or the caption naming a card
 * when zoomed out), whenever one is there (C40, C41).
 */
export function controlInsets(key, toolbar, svg) {
  const GAP = 8;
  const CHIP_STRIP = 10 + 28 + GAP; // GraphCaption's corner chip: 10 from the edge, one line at text size
  const bottom = (el) => (el ? el.offsetTop + el.offsetHeight + GAP : 0);
  // From the drawing's own top: none, once it starts below the controls' strip.
  const svgTop = svg ? svg.getBoundingClientRect().top - svg.parentElement.getBoundingClientRect().top : 0; // an svg has no offsetTop
  const w = svg?.clientWidth || 1;
  const h = svg?.clientHeight || 1;
  const beside = key?.open ? key.offsetLeft + key.offsetWidth + GAP : 0;
  const under = key?.open && (w - beside) / w < (h - bottom(key)) / h;
  const top = Math.max(0, Math.max(key?.open && !under ? 0 : bottom(key), bottom(toolbar)) - svgTop);
  const host = svg?.parentElement;
  const hint = host?.querySelector(".graph-hint");
  const chip = host?.querySelector(".graph-caption") || (hint && getComputedStyle(hint).display !== "none");
  // From the drawing's own bottom: none where it ends above the chip's strip (.graph-hint-room).
  const svgBottom = svg ? host.getBoundingClientRect().bottom - svg.getBoundingClientRect().bottom : 0;
  return { top, right: 0, bottom: chip ? Math.max(0, CHIP_STRIP - svgBottom) : 0, left: key?.open && !under ? beside : 0 };
}

// A row, so it shares the key's strip along the top and the drawing keeps the
// canvas's full width (controlInsets()).
export function GraphToolbar({ onZoomIn, onZoomOut, onFit, toolbarRef }) {
  return (
    <div ref={toolbarRef} style={{
      position: "absolute", top: 10, right: 10, display: "flex", gap: 2,
      background: "var(--surface-card)", border: "1px solid var(--border-hairline)",
      borderRadius: "var(--radius-sm)", boxShadow: "var(--shadow-card)", padding: 2,
    }}>
      <IconButton label="Zoom in" size="sm" onClick={onZoomIn}><Icon name="zoom-in" size={14} /></IconButton>
      <IconButton label="Zoom out" size="sm" onClick={onZoomOut}><Icon name="zoom-out" size={14} /></IconButton>
      <IconButton label="Fit to screen" size="sm" onClick={onFit}><Icon name="maximize" size={14} /></IconButton>
    </div>
  );
}

function LegendRow({ mark, children, style }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, ...style }}>
      <span style={{ flex: "none", width: 16, display: "flex", justifyContent: "center" }}>{mark}</span>
      {children}
    </div>
  );
}

const LEGEND_HEAD = { color: "var(--text-heading)", marginTop: 2 };
const dot = (color) => <span style={{ width: 6, height: 6, borderRadius: "50%", background: color }} />;

const lineMark = (opacity) => (
  <svg width="16" height="6"><line x1="0" y1="3" x2="16" y2="3" stroke="var(--ink-4)" strokeWidth="1" opacity={opacity} /></svg>
);

function GraphLegend({ legendRef, cutActive, recheckActive, hubs, graphData }) {
  const CUT_TIERS = [
    ["target", "var(--accent)", 1],
    ["needed", "var(--ok-fg)", 1],
    ["can wait", "var(--text-secondary)", 0.3],
  ];
  const shown = new Set(graphData.nodes.map((n) => n.layer));
  const layers = Object.keys(LAYER).filter((l) => shown.has(l));
  return (
    <details ref={legendRef} style={{
      position: "absolute", top: 10, left: 10,
      background: "var(--surface-card)", border: "1px solid var(--border-hairline)",
      borderRadius: "var(--radius-sm)", boxShadow: "var(--shadow-card)", padding: "6px 10px",
      fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", color: "var(--text-secondary)",
    }}>
      <summary style={{ cursor: "pointer", color: "var(--text-heading)" }}>Key</summary>
      <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 6 }}>
        {hubs ? (
          <>
            <div style={LEGEND_HEAD}>Shapes</div>
            {hubs.legend.shapes.filter(([tone]) => graphData.nodes.some((n) => n.hub && n.tone === tone)).map(([tone, label]) => (
              <LegendRow key={tone} mark={<svg width="16" height="10"><g transform="translate(8,5)"><HubPill tone={HUB_TONE[tone]} w={14} h={8} /></g></svg>}>
                {label}
              </LegendRow>
            ))}
            <LegendRow mark={
              <svg width="16" height="10"><rect x="1" y="1" width="14" height="8" rx="2" fill="var(--surface-card)" stroke="var(--border-control)" /></svg>
            }>Feature</LegendRow>
            <div style={LEGEND_HEAD}>Lines</div>
            <LegendRow mark={lineMark(0.7)}>{hubs.legend.line}</LegendRow>
            {graphData.edges.some((e) => e.faint) && (
              <LegendRow mark={lineMark(0.25)}>Fainter: shared by over half</LegendRow>
            )}
            <div>Dependencies show in Build order.</div>
          </>
        ) : (
          <>
            <div style={LEGEND_HEAD}>Lines</div>
            {EDGE_KINDS.map((kind) => {
              const st = edgeStyle(kind);
              return (
                <LegendRow key={kind} mark={
                  <svg width="16" height="6">
                    <line x1="0" y1="3" x2="16" y2="3" stroke={`var(${st.colorVar})`} strokeWidth="1.6" strokeDasharray={st.dash || undefined} />
                  </svg>
                }>
                  <Term dict={EDGE} value={kind} />
                </LegendRow>
              );
            })}
          </>
        )}
        <div style={LEGEND_HEAD}>Corner dot: status</div>
        {Object.keys(STATUS_DOT).map((status) => (
          <LegendRow key={status} mark={dot(STATUS_DOT[status])}><span title={status}>{statusLabel(status)}</span></LegendRow>
        ))}
        {layers.length > 0 && <div style={LEGEND_HEAD}>Left dot: layer</div>}
        {layers.map((layer) => (
          <LegendRow key={layer} mark={dot(`var(${nodeAccentVar(layer)})`)}><Term dict={LAYER} value={layer} /></LegendRow>
        ))}
        {recheckActive && (
          <>
            <div style={LEGEND_HEAD}>If this changes</div>
            {[["breaks", "var(--danger-fg)"], ["retest", "var(--warn-fg)"]].map(([label, color]) => (
              <LegendRow key={label} mark={
                <svg width="16" height="10">
                  <rect x="2" y="1" width="12" height="8" rx="2" fill="none" stroke={color} strokeWidth="1.5" />
                </svg>
              }>
                {label}
              </LegendRow>
            ))}
          </>
        )}
        {cutActive && (
          <>
            <div style={LEGEND_HEAD}>Smallest version</div>
            {CUT_TIERS.map(([label, color, opacity]) => (
              <LegendRow key={label} style={{ opacity }} mark={
                <svg width="16" height="10">
                  <rect x="2" y="1" width="12" height="8" rx="2" fill="none" stroke={color} strokeWidth="1.5" />
                </svg>
              }>
                {label}
              </LegendRow>
            ))}
          </>
        )}
      </div>
    </details>
  );
}
