import React from "react";
import { Icon, IconButton } from "../../ds";
import { createForceGraph } from "./forceGraphEngine.js";
import { buildFeatureGraph, buildAdjacency, edgeStyle, nodeAccentVar, wrapLabel, NODE_W, NODE_H } from "./graph-data.js";
import { EDGE, LAYER, statusLabel } from "../../lib/words.js";
import { Term } from "../shared/Term.jsx";

// useLayoutEffect must win in the browser (it runs before paint, so a
// freshly-mounted node is positioned before the user ever sees a frame at
// the origin) but SSR has no paint to block and warns on useLayoutEffect —
// this is the standard escape hatch.
const useIsomorphicLayoutEffect = typeof window !== "undefined" ? React.useLayoutEffect : React.useEffect;

const EDGE_KINDS = ["DEPENDS_ON", "BLOCKS", "RELATES_TO"];
const STATUS_DOT = { pending: "var(--text-secondary)", in_progress: "var(--warn-fg)", done: "var(--ok-fg)" };

export function FeatureGraphView({ layout, selectedId, onSelect, impactIds, cutStates, fadedIds, style, fitKey }) {
  const svgRef = React.useRef(null);
  const viewportRef = React.useRef(null);
  const engineRef = React.useRef(null);
  const nodeElsRef = React.useRef(new Map());
  const edgeElsRef = React.useRef(new Map());
  const onSelectRef = React.useRef(onSelect);
  const hasFitRef = React.useRef(false);

  const [pinned, setPinned] = React.useState(() => new Set());
  const [hoveredId, setHoveredId] = React.useState(null);
  const [reducedMotion, setReducedMotion] = React.useState(
    () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );

  const graphData = React.useMemo(() => buildFeatureGraph(layout), [layout]);
  const adjacency = React.useMemo(() => buildAdjacency(graphData.edges), [graphData]);

  useIsomorphicLayoutEffect(() => {
    onSelectRef.current = onSelect;
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
    const engine = createForceGraph({
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

  useIsomorphicLayoutEffect(() => {
    engineRef.current?.update(graphData.nodes, graphData.edges);
    if (!hasFitRef.current && graphData.nodes.length) {
      hasFitRef.current = true;
      engineRef.current?.fitToView(0);
      engineRef.current?.fitWhenSettled(); // the first fit sees unspread nodes
    }
  }, [graphData]);

  // A new filter shows a different set of nodes: frame them.
  const lastFitKey = React.useRef(fitKey);
  useIsomorphicLayoutEffect(() => {
    if (lastFitKey.current === fitKey) return;
    lastFitKey.current = fitKey;
    engineRef.current?.fitWhenSettled();
  }, [fitKey]);

  // With a cut overlay active, tier coloring owns the canvas — selection no
  // longer dims non-neighbors (hover still focuses transiently).
  const wantFocus = hoveredId ?? (cutStates != null ? null : selectedId) ?? null;
  // Fade the rest only when the focused card has relationships to show;
  // fading everything around a loner just makes the graph hard to read.
  const focusId = wantFocus != null && adjacency.get(wantFocus)?.size ? wantFocus : null;
  const focusNeighbors = focusId ? adjacency.get(focusId) : null;

  return (
    <div style={{ position: "relative", width: "100%", height: "100%", ...style }}>
      <svg
        ref={svgRef}
        style={{ width: "100%", height: "100%", display: "block", cursor: "grab", touchAction: "none" }}
      >
        <defs>
          {EDGE_KINDS.map((kind) => (
            <marker key={kind} id={`graph-arrow-${kind}`} viewBox="0 0 10 10" refX="9" refY="5"
              markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill={`var(${edgeStyle(kind).colorVar})`} />
            </marker>
          ))}
        </defs>
        <g ref={viewportRef}>
          <g>
            {graphData.edges.map((e) => {
              const st = edgeStyle(e.kind);
              const cutDim = cutStates != null &&
                (cutStates.get(e.source) === "deferrable" || cutStates.get(e.target) === "deferrable");
              const fadeDim = fadedIds != null && (fadedIds.has(e.source) || fadedIds.has(e.target));
              const dim = cutDim || fadeDim || (focusId != null && e.source !== focusId && e.target !== focusId);
              return (
                <line
                  key={e.id}
                  ref={(el) => {
                    if (!el) return;
                    edgeElsRef.current.set(e.id, el);
                    engineRef.current?.registerEdge(e.id, el);
                    return () => {
                      edgeElsRef.current.delete(e.id);
                      engineRef.current?.unregisterEdge(e.id, el);
                    };
                  }}
                  stroke={`var(${st.colorVar})`}
                  strokeWidth={e.kind === "DEPENDS_ON" || e.kind === "BLOCKS" ? 1.6 : 1.2}
                  strokeDasharray={st.dash || undefined}
                  markerEnd={`url(#graph-arrow-${e.kind})`}
                  opacity={dim ? 0.08 : e.kind === "RELATES_TO" ? 0.4 : 0.6}
                  style={{ transition: "opacity var(--dur-med) var(--ease-out)" }}
                />
              );
            })}
          </g>
          <g>
            {graphData.nodes.map((n) => (
              <FeatureNode
                key={n.id}
                node={n}
                isSelected={selectedId === n.id}
                isTabStop={selectedId ? selectedId === n.id : n.id === graphData.nodes[0]?.id}
                isHovered={hoveredId === n.id}
                isDimmed={focusId != null && focusId !== n.id && !focusNeighbors?.has(n.id)}
                isFaded={fadedIds ? fadedIds.has(n.id) : false}
                isImpacted={impactIds ? impactIds.has(n.id) : false}
                cutState={cutStates ? cutStates.get(n.id) : null}
                isPinned={pinned.has(n.id)}
                onSelect={onSelect}
                onHoverChange={setHoveredId}
                registerEl={(el) => {
                  if (!el) return;
                  nodeElsRef.current.set(n.id, el);
                  engineRef.current?.registerNode(n.id, el);
                  return () => {
                    nodeElsRef.current.delete(n.id);
                    engineRef.current?.unregisterNode(n.id, el);
                  };
                }}
              />
            ))}
          </g>
        </g>
      </svg>

      <GraphToolbar
        onZoomIn={() => engineRef.current?.zoomBy(1.4)}
        onZoomOut={() => engineRef.current?.zoomBy(1 / 1.4)}
        onFit={() => engineRef.current?.fitToView()}
      />
      <GraphLegend cutActive={cutStates != null} />

      <div style={{
        position: "absolute", bottom: 10, left: 12, pointerEvents: "none",
        fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-secondary)",
      }}>
        drag to move · double-click to release · scroll to zoom
      </div>

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

function FeatureNode({ node, isSelected, isTabStop, isHovered, isDimmed, isFaded, isImpacted, cutState, isPinned, onSelect, onHoverChange, registerEl }) {
  const accent = `var(${nodeAccentVar(node.layer)})`;
  const ring = isSelected ? "var(--accent)"
    : isImpacted ? "var(--danger-fg)"
    : cutState === "target" ? "var(--accent)"
    : cutState === "essential" ? "var(--ok-fg)"
    : isHovered ? "var(--border-default)" : "var(--border-hairline)";
  const ringWide = isSelected || cutState === "target" || cutState === "essential";
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
      <circle cx={-NODE_W / 2 + 11} cy={0} r={3} fill={accent} />
      <CardLabel name={node.name} x={-NODE_W / 2 + 19} />
    </g>
  );
}

// SVG text, not an HTML foreignObject: 462 HTML labels made pan and zoom
// drop to about 29fps. Hidden when zoomed out too far to read (.graph-far).
export function CardLabel({ name, x, fill = "var(--text-heading)" }) {
  const lines = wrapLabel(name);
  const lineH = 14;
  return (
    <text x={x} y={-((lines.length - 1) * lineH) / 2} dominantBaseline="central" fill={fill}
      style={{ fontFamily: "var(--font-body)", fontSize: 11.5, fontWeight: 500, pointerEvents: "none" }}>
      {lines.map((l, i) => <tspan key={i} x={x} dy={i === 0 ? 0 : lineH}>{l}</tspan>)}
    </text>
  );
}

export function GraphToolbar({ onZoomIn, onZoomOut, onFit }) {
  return (
    <div style={{
      position: "absolute", top: 10, right: 10, display: "flex", flexDirection: "column", gap: 2,
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

function GraphLegend({ cutActive }) {
  const CUT_TIERS = [
    ["target", "var(--accent)", 1],
    ["needed", "var(--ok-fg)", 1],
    ["can wait", "var(--text-secondary)", 0.3],
  ];
  return (
    <details open style={{
      position: "absolute", top: 10, left: 10,
      background: "var(--surface-card)", border: "1px solid var(--border-hairline)",
      borderRadius: "var(--radius-sm)", boxShadow: "var(--shadow-card)", padding: "6px 10px",
      fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-secondary)",
    }}>
      <summary style={{ cursor: "pointer", color: "var(--text-heading)" }}>Key</summary>
      <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 6 }}>
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
        <div style={LEGEND_HEAD}>Dot by the name: layer</div>
        {Object.keys(LAYER).map((layer) => (
          <LegendRow key={layer} mark={dot(`var(${nodeAccentVar(layer)})`)}><Term dict={LAYER} value={layer} /></LegendRow>
        ))}
        <div style={LEGEND_HEAD}>Corner dot: status</div>
        {Object.keys(STATUS_DOT).map((status) => (
          <LegendRow key={status} mark={dot(STATUS_DOT[status])}><span title={status}>{statusLabel(status)}</span></LegendRow>
        ))}
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
