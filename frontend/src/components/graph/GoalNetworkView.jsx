import React from "react";
import { StatusBadge } from "../../ds";
import { createForceGraph } from "./forceGraphEngine.js";
import { buildGoalNetwork, buildAdjacency, NODE_W, NODE_H } from "./graph-data.js";
import { CardLabel, GraphToolbar } from "./FeatureGraphView.jsx";
import { count } from "../../lib/words.js";

const useIsomorphicLayoutEffect = typeof window !== "undefined" ? React.useLayoutEffect : React.useEffect;

const STATUS_DOT = { pending: "var(--text-secondary)", in_progress: "var(--warn-fg)", done: "var(--ok-fg)" };

// Part-of lines hold a cluster together. Shares lines barely pull: with any
// real strength, 77 of them drag every cluster into one tangle.
const linkDistance = (e) => (e.kind === "PART_OF" ? 170 : 320);
const linkStrength = (e) => (e.kind === "PART_OF" ? 0.05 : 0.002);
const sharesWidth = (w) => 0.6 + Math.min(w, 6) * 0.5;

/** Goals linked by the capabilities they share, with a side panel for the selected goal. */
export function GoalNetworkView({ goals, capsByGoal, selectedId, onSelect }) {
  const svgRef = React.useRef(null);
  const viewportRef = React.useRef(null);
  const engineRef = React.useRef(null);
  const nodeElsRef = React.useRef(new Map());
  const edgeElsRef = React.useRef(new Map());
  const onSelectRef = React.useRef(onSelect);
  const hasFitRef = React.useRef(false);
  const [hoveredId, setHoveredId] = React.useState(null);

  const data = React.useMemo(() => buildGoalNetwork(goals, capsByGoal), [goals, capsByGoal]);
  const adjacency = React.useMemo(() => buildAdjacency(data.edges), [data]);

  useIsomorphicLayoutEffect(() => {
    onSelectRef.current = onSelect;
  });

  useIsomorphicLayoutEffect(() => {
    const engine = createForceGraph({
      svgEl: svgRef.current,
      viewportEl: viewportRef.current,
      nodeSize: { width: NODE_W, height: NODE_H },
      // The packed clusters lead (see buildGoalNetwork): strong anchors, faint
      // repulsion, card-shaped collision, a quick settle.
      collideRect: { width: NODE_W + 16, height: NODE_H + 16 },
      chargeStrength: -20,
      anchorStrengthX: 0.5,
      anchorStrengthY: 0.5,
      alphaDecay: 0.06,
      linkDistance,
      linkStrength,
      reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      onSelect: (id) => onSelectRef.current?.(id),
    });
    engineRef.current = engine;
    for (const [id, el] of nodeElsRef.current) engine.registerNode(id, el);
    for (const [id, el] of edgeElsRef.current) engine.registerEdge(id, el);
    return () => {
      engine.destroy();
      engineRef.current = null;
    };
  }, []);

  useIsomorphicLayoutEffect(() => {
    engineRef.current?.update(data.nodes, data.edges);
    if (!hasFitRef.current && data.nodes.length) {
      hasFitRef.current = true;
      engineRef.current?.fitToView(0);
      engineRef.current?.fitWhenSettled(); // the first fit sees unspread nodes
    }
  }, [data]);

  const wantFocus = hoveredId ?? selectedId ?? null;
  // Fade the rest only when the focused card has relationships to show;
  // fading everything around a loner just makes the graph hard to read.
  const focusId = wantFocus != null && adjacency.get(wantFocus)?.size ? wantFocus : null;
  const focusNeighbors = focusId ? adjacency.get(focusId) : null;
  const ref = (map, id, register, unregister) => (el) => {
    if (!el) return;
    map.set(id, el);
    engineRef.current?.[register](id, el);
    return () => {
      map.delete(id);
      engineRef.current?.[unregister](id, el);
    };
  };

  return (
    <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
      <div style={{ flex: 1, position: "relative", margin: 20, background: "var(--surface-card)", border: "1px solid var(--border-hairline)", borderRadius: "var(--radius-md)", overflow: "hidden", minWidth: 0 }}>
        <svg ref={svgRef} role="img" aria-label="Goals linked by the capabilities they share"
          style={{ width: "100%", height: "100%", display: "block", cursor: "grab", touchAction: "none" }}>
          <g ref={viewportRef}>
            <g>
              {data.edges.map((e) => {
                const dim = focusId != null && e.source !== focusId && e.target !== focusId;
                const shares = e.kind === "SHARES";
                return (
                  <line key={e.id} ref={ref(edgeElsRef.current, e.id, "registerEdge", "unregisterEdge")}
                    stroke={shares ? "var(--accent)" : "var(--ink-4)"}
                    strokeWidth={shares ? sharesWidth(e.weight) : 1.2}
                    strokeLinecap="round"
                    opacity={dim ? 0.06 : shares ? (focusId != null ? 0.7 : 0.22) : 0.6}
                    style={{ transition: "opacity var(--dur-med) var(--ease-out)" }}>
                    {shares && <title>{`Shares ${count(e.weight, "capability", "capabilities")}: ${e.capabilities.map((c) => c.name).join(", ")}`}</title>}
                  </line>
                );
              })}
            </g>
            <g>
              {data.nodes.map((n) => (
                <GoalNode key={n.id} node={n}
                  isSelected={selectedId === n.id}
                  isTabStop={selectedId ? selectedId === n.id : n.id === data.nodes[0]?.id}
                  isDimmed={focusId != null && focusId !== n.id && !focusNeighbors?.has(n.id)}
                  onSelect={onSelect} onHoverChange={setHoveredId}
                  registerEl={ref(nodeElsRef.current, n.id, "registerNode", "unregisterNode")} />
              ))}
            </g>
          </g>
        </svg>
        <GraphToolbar
          onZoomIn={() => engineRef.current?.zoomBy(1.4)}
          onZoomOut={() => engineRef.current?.zoomBy(1 / 1.4)}
          onFit={() => engineRef.current?.fitToView()} />
        <NetworkKey />
        <div style={{ position: "absolute", bottom: 10, left: 12, pointerEvents: "none", fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-secondary)" }}>
          drag to move · double-click to release · scroll to zoom
        </div>
      </div>
      <GoalPanel goals={goals} edges={data.edges} capsByGoal={capsByGoal} selectedId={selectedId} onSelect={onSelect} />
    </div>
  );
}

function GoalNode({ node, isSelected, isTabStop, isDimmed, onSelect, onHoverChange, registerEl }) {
  const { goal, isOrg } = node;
  const ring = isSelected ? "var(--accent)" : isOrg ? "var(--surface-inverse)" : "var(--border-hairline)";
  return (
    <g ref={registerEl} data-node-id={node.id} tabIndex={isTabStop ? 0 : -1} role="button"
      aria-label={`${isOrg ? "Org goal" : "Product goal"}: ${goal.title}`} aria-pressed={isSelected}
      className={isDimmed ? "graph-node is-dim" : "graph-node"}
      onMouseEnter={() => onHoverChange(node.id)} onMouseLeave={() => onHoverChange(null)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(node.id);
        }
      }}
      style={{ cursor: "grab" }}>
      <title>{goal.title}</title>
      <rect x={-NODE_W / 2} y={-NODE_H / 2} width={NODE_W} height={NODE_H} rx={8}
        fill={isOrg ? "var(--surface-inverse)" : "var(--surface-card)"}
        stroke={ring} strokeWidth={isSelected ? 2 : 1}
        strokeDasharray={!isOrg && node.capCount === 0 ? "3,3" : undefined} />
      <circle cx={NODE_W / 2 - 12} cy={-NODE_H / 2 + 12} r={3} fill={STATUS_DOT[goal.status] || STATUS_DOT.pending} />
      <CardLabel name={goal.title} x={-NODE_W / 2 + 12} fill={isOrg ? "var(--text-inverse)" : "var(--text-heading)"} />
    </g>
  );
}

function NetworkKey() {
  const row = { display: "flex", alignItems: "center", gap: 6 };
  const card = (fill, stroke, dash) => (
    <svg width="16" height="10"><rect x="1" y="1" width="14" height="8" rx="2" fill={fill} stroke={stroke} strokeDasharray={dash} /></svg>
  );
  const line = (stroke, width) => (
    <svg width="16" height="8"><line x1="0" y1="4" x2="16" y2="4" stroke={stroke} strokeWidth={width} strokeLinecap="round" /></svg>
  );
  return (
    <details open style={{ position: "absolute", top: 10, left: 10, background: "var(--surface-card)", border: "1px solid var(--border-hairline)", borderRadius: "var(--radius-sm)", boxShadow: "var(--shadow-card)", padding: "6px 10px", fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-secondary)" }}>
      <summary style={{ cursor: "pointer", color: "var(--text-heading)" }}>Key</summary>
      <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 6 }}>
        <div style={row}>{card("var(--surface-inverse)", "var(--surface-inverse)")}org goal</div>
        <div style={row}>{card("var(--surface-card)", "var(--ink-4)")}product goal</div>
        <div style={row}>{card("var(--surface-card)", "var(--ink-4)", "2,2")}no capabilities linked</div>
        <div style={row}>{line("var(--ink-4)", 1.2)}part of</div>
        <div style={row}>{line("var(--accent)", 3)}share capabilities (thicker: more)</div>
      </div>
    </details>
  );
}

function GoalPanel({ goals, edges, capsByGoal, selectedId, onSelect }) {
  const byId = React.useMemo(() => new Map(goals.map((g) => [g.id, g])), [goals]);
  const goal = selectedId ? byId.get(selectedId) : null;
  const panel = { width: 300, flex: "none", borderLeft: "1px solid var(--border-hairline)", background: "var(--surface-card)", padding: "16px 18px", overflowY: "auto", display: "flex", flexDirection: "column", gap: 14, fontSize: "var(--text-sm)" };
  const head = { fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "var(--tracking-caps)", textTransform: "uppercase", color: "var(--text-secondary)" };
  const goalButton = (g) => (
    <button type="button" onClick={() => onSelect(g.id)}
      style={{ font: "inherit", textAlign: "left", background: "none", border: "none", padding: 0, color: "var(--text-accent)", cursor: "pointer" }}>
      {g.title}
    </button>
  );

  if (!goal) {
    const sharing = new Set(edges.filter((e) => e.kind === "SHARES").flatMap((e) => [e.source, e.target]));
    return (
      <aside style={panel}>
        <div style={{ color: "var(--text-secondary)" }}>Pick a goal to see which other goals rely on the same capabilities.</div>
        <div style={{ color: "var(--text-secondary)" }}>{count(sharing.size, "goal")} of {goals.length} share a capability with another goal.</div>
      </aside>
    );
  }

  const parent = goal.parent_goal_id ? byId.get(goal.parent_goal_id) : null;
  const children = goals.filter((g) => g.parent_goal_id === goal.id);
  const shares = edges
    .filter((e) => e.kind === "SHARES" && (e.source === goal.id || e.target === goal.id))
    .map((e) => ({ other: byId.get(e.source === goal.id ? e.target : e.source), capabilities: e.capabilities }))
    .sort((a, b) => b.capabilities.length - a.capabilities.length || a.other.title.localeCompare(b.other.title));
  const caps = capsByGoal[goal.id] ?? [];

  return (
    <aside style={panel} aria-label="Selected goal">
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={head}>{goal.goal_type === "org" ? "org goal" : "product goal"} · {goal.display_id}</div>
        <div style={{ fontWeight: "var(--weight-semibold)", color: "var(--text-heading)" }}>{goal.title}</div>
        <div><StatusBadge status={goal.status} /></div>
        {parent && <div style={{ color: "var(--text-secondary)" }}>Part of {goalButton(parent)}</div>}
        <a href={`/goals?goal=${goal.id}`} style={{ fontSize: "var(--text-xs)" }}>Show in the list</a>
      </div>

      {children.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={head}>{count(children.length, "product goal")}</div>
          {children.map((g) => <div key={g.id}>{goalButton(g)}</div>)}
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={head}>Shares capabilities with</div>
        {shares.length === 0 ? (
          <div style={{ color: "var(--text-secondary)" }}>
            {caps.length === 0 ? "No capabilities linked, so nothing to share." : "No other goal uses its capabilities."}
          </div>
        ) : (
          shares.map(({ other, capabilities }) => (
            <div key={other.id} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              {goalButton(other)}
              <span style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>
                through{" "}
                {capabilities.map((c, i) => (
                  <React.Fragment key={c.id}>
                    {i > 0 && ", "}
                    <a href={`/capabilities/${c.slug}`}>{c.name}</a>
                  </React.Fragment>
                ))}
              </span>
            </div>
          ))
        )}
      </div>

      {caps.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={head}>{count(caps.length, "capability", "capabilities")} linked</div>
          <div style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>
            {caps.map((c, i) => (
              <React.Fragment key={c.id}>
                {i > 0 && ", "}
                <a href={`/capabilities/${c.slug}`}>{c.name}</a>
              </React.Fragment>
            ))}
          </div>
        </div>
      )}
    </aside>
  );
}
