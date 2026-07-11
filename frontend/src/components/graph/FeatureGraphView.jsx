import React from "react";
import { Icon, IconButton } from "../../ds";
import { createForceGraph } from "./forceGraphEngine.js";
import { buildFeatureGraph, buildAdjacency, edgeStyle, nodeAccentVar, NODE_W, NODE_H, NODE_COLLIDE_R } from "./graph-data.js";

// useLayoutEffect must win in the browser (it runs before paint, so a
// freshly-mounted node is positioned before the user ever sees a frame at
// the origin) but SSR has no paint to block and warns on useLayoutEffect —
// this is the standard escape hatch.
const useIsomorphicLayoutEffect = typeof window !== "undefined" ? React.useLayoutEffect : React.useEffect;

const EDGE_KINDS = ["DEPENDS_ON", "BLOCKS", "PART_OF", "RELATES_TO"];
const STATUS_DOT = { pending: "var(--text-secondary)", in_progress: "var(--warn-fg)", done: "var(--ok-fg)" };

export function FeatureGraphView({ layout, selectedId, onSelect, impactIds, style }) {
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
      nodeRadius: () => NODE_COLLIDE_R,
      linkDistance: (e) => edgeStyle(e.kind).distance,
      linkStrength: (e) => edgeStyle(e.kind).strength,
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
    }
  }, [graphData]);

  const focusId = hoveredId ?? selectedId ?? null;
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
              const dim = focusId != null && e.source !== focusId && e.target !== focusId;
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
                isHovered={hoveredId === n.id}
                isDimmed={focusId != null && focusId !== n.id && !focusNeighbors?.has(n.id)}
                isImpacted={impactIds ? impactIds.has(n.id) : false}
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
      <GraphLegend />

      <div style={{
        position: "absolute", bottom: 10, left: 12, pointerEvents: "none",
        fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-disabled)",
      }}>
        drag to move · double-click to release · scroll to zoom
      </div>

      {graphData.nodes.length === 0 && (
        <div style={{
          position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: "var(--text-sm)", color: "var(--text-disabled)", pointerEvents: "none",
        }}>
          No features yet.
        </div>
      )}
    </div>
  );
}

function FeatureNode({ node, isSelected, isHovered, isDimmed, isImpacted, isPinned, onSelect, onHoverChange, registerEl }) {
  const accent = `var(${nodeAccentVar(node.type)})`;
  const ring = isSelected ? "var(--accent)" : isImpacted ? "var(--danger-fg)" : isHovered ? "var(--border-default)" : "var(--border-hairline)";
  return (
    <g
      ref={registerEl}
      data-node-id={node.id}
      tabIndex={0}
      role="button"
      aria-label={`${node.displayId} ${node.name}`}
      aria-pressed={isSelected}
      onMouseEnter={() => onHoverChange(node.id)}
      onMouseLeave={() => onHoverChange(null)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect && onSelect(node.id);
        }
      }}
      style={{ opacity: isDimmed ? 0.25 : 1, transition: "opacity var(--dur-med) var(--ease-out)", cursor: "grab", outline: "none" }}
    >
      <rect
        x={-NODE_W / 2} y={-NODE_H / 2} width={NODE_W} height={NODE_H} rx={8}
        fill="var(--surface-card)" stroke={ring} strokeWidth={isSelected ? 1.5 : 1}
        style={{
          filter: isHovered || isSelected ? "drop-shadow(var(--shadow-raised))" : "drop-shadow(var(--shadow-card))",
          transition: "stroke var(--dur-fast) var(--ease-out), filter var(--dur-fast) var(--ease-out)",
        }}
      />
      <circle cx={-NODE_W / 2 + 14} cy={-NODE_H / 2 + 14} r={3.5} fill={accent} />
      <circle cx={NODE_W / 2 - 12} cy={-NODE_H / 2 + 12} r={3} fill={STATUS_DOT[node.status] || STATUS_DOT.pending} />
      {isPinned && (
        <g transform={`translate(${NODE_W / 2 - 22},${NODE_H / 2 - 22})`}>
          <circle cx="9" cy="9" r="9" fill="var(--surface-card)" stroke="var(--border-hairline)" />
          <g transform="translate(2,2)" color="var(--text-disabled)">
            <Icon name="pin" size={14} />
          </g>
        </g>
      )}
      <foreignObject x={-NODE_W / 2 + 8} y={-NODE_H / 2 + 6} width={NODE_W - 16} height={NODE_H - 10} style={{ pointerEvents: "none" }}>
        <div xmlns="http://www.w3.org/1999/xhtml" style={{ fontFamily: "var(--font-body)" }}>
          <div style={{
            fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--text-secondary)",
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>
            {node.displayId}
          </div>
          <div style={{
            fontSize: 11.5, fontWeight: 500, color: "var(--text-heading)", lineHeight: 1.25, marginTop: 2,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>
            {node.name}
          </div>
        </div>
      </foreignObject>
    </g>
  );
}

function GraphToolbar({ onZoomIn, onZoomOut, onFit }) {
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

function GraphLegend() {
  return (
    <div style={{
      position: "absolute", top: 10, left: 10, display: "flex", flexDirection: "column", gap: 5,
      background: "var(--surface-card)", border: "1px solid var(--border-hairline)",
      borderRadius: "var(--radius-sm)", boxShadow: "var(--shadow-card)", padding: "8px 10px",
      fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-secondary)",
    }}>
      {EDGE_KINDS.map((kind) => {
        const st = edgeStyle(kind);
        return (
          <div key={kind} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <svg width="16" height="6" style={{ flex: "none" }}>
              <line x1="0" y1="3" x2="16" y2="3" stroke={`var(${st.colorVar})`} strokeWidth="1.6" strokeDasharray={st.dash || undefined} />
            </svg>
            {kind}
          </div>
        );
      })}
    </div>
  );
}
