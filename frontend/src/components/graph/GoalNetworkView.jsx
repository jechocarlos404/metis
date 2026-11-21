import React from "react";
import { Select, StatusBadge } from "../../ds";
import { createForceGraph } from "./forceGraphEngine.js";
import { buildGoalNetwork, buildAdjacency, NODE_W, GOAL_H, GOAL_LINES } from "./graph-data.js";
import { CardLabel, GraphCaption, GraphToolbar, controlInsets } from "./FeatureGraphView.jsx";
import { capabilityCount } from "./goal-facts.js";
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
  const canvasPickRef = React.useRef(null); // the goal last pressed on the canvas
  const pickSeenRef = React.useRef(false);
  const hasFitRef = React.useRef(false);
  const keyRef = React.useRef(null);
  const toolbarRef = React.useRef(null);
  const canvasRef = React.useRef(null);
  const [hoveredId, setHoveredId] = React.useState(null);
  const [focusedId, setFocusedId] = React.useState(null); // the goal last focused on the canvas

  const data = React.useMemo(() => buildGoalNetwork(goals, capsByGoal), [goals, capsByGoal]);
  const adjacency = React.useMemo(() => buildAdjacency(data.edges), [data]);

  const adjacencyRef = React.useRef(adjacency);

  useIsomorphicLayoutEffect(() => {
    onSelectRef.current = onSelect;
    adjacencyRef.current = adjacency;
  });

  useIsomorphicLayoutEffect(() => {
    const engine = createForceGraph({
      svgEl: svgRef.current,
      viewportEl: viewportRef.current,
      nodeSize: { width: NODE_W, height: GOAL_H },
      // The packed clusters lead (see buildGoalNetwork): strong anchors, faint
      // repulsion, card-shaped collision, a quick settle.
      collideRect: { width: NODE_W + 16, height: GOAL_H + 16 },
      chargeStrength: -20,
      anchorStrengthX: 0.5,
      anchorStrengthY: 0.5,
      alphaDecay: 0.06,
      linkDistance,
      linkStrength,
      frameInsets: () => controlInsets(keyRef.current, toolbarRef.current, svgRef.current),
      reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      onSelect: (id) => {
        canvasPickRef.current = id;
        onSelectRef.current?.(id);
      },
      // A goal pressed on a view too far out to name it comes in to where its
      // name reads (A49); one already readable stays under the pointer.
      onPress: (id) => {
        if (svgRef.current?.classList.contains("graph-far")) engine.framePick(id, [...(adjacencyRef.current.get(id) ?? [])]);
      },
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
      const focus = selectedId != null ? { pick: selectedId, near: [...(adjacency.get(selectedId) ?? [])] } : null;
      engineRef.current?.openView(focus, 0);
      engineRef.current?.openWhenSettled(focus); // the first frame sees unspread nodes
    }
  }, [data]);

  // A goal picked in the side list (or by keyboard) is framed with the goals
  // it lights, so its lines show (C39), centred when they fit around it
  // (A10); stacked under the list, the canvas then scrolls into view. One
  // pressed on the canvas stays under the pointer.
  useIsomorphicLayoutEffect(() => {
    const pressed = canvasPickRef.current === selectedId;
    canvasPickRef.current = null;
    const opening = !pickSeenRef.current; // the URL's goal: the page opens at its top
    pickSeenRef.current = true;
    setFocusedId(null); // the canvas's tab stop is the picked goal again
    if (selectedId == null || pressed) return;
    engineRef.current?.framePick(selectedId, [...(adjacency.get(selectedId) ?? [])]);
    if (!opening) canvasRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  // Arrow keys move between goals in the goals' order (A46); the one focused
  // last is the canvas's tab stop, and is brought into view.
  const moveFocus = (id, key) => {
    const ids = data.nodes.map((n) => n.id);
    const i = ids.indexOf(id);
    const next = ids[key === "Home" ? 0 : key === "End" ? ids.length - 1
      : key === "ArrowRight" || key === "ArrowDown" ? Math.min(ids.length - 1, i + 1) : Math.max(0, i - 1)];
    engineRef.current?.reveal(next);
    nodeElsRef.current.get(next)?.focus({ preventScroll: true });
  };

  const wantFocus = hoveredId ?? selectedId ?? null;
  // Fade the rest only when the focused card has relationships to show;
  // fading everything around a loner just makes the graph hard to read.
  const focusId = wantFocus != null && adjacency.get(wantFocus)?.size ? wantFocus : null;
  const focusNeighbors = focusId ? adjacency.get(focusId) : null;
  const named = data.nodes.find((n) => n.id === (hoveredId ?? selectedId));
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
    // Side by side, the canvas fills the height and the list scrolls on its
    // own; stacked (.graph-goal-row wraps), the list leads (base.css).
    <div className="graph-goal-network" style={{ flex: 1, display: "flex", minHeight: 0 }}>
      <div className="graph-goal-row" style={{ flex: 1, display: "flex", minHeight: 0, overflowY: "auto" }}>
        <div ref={canvasRef} className="graph-hint-room" style={{ flex: "999 1 420px", minHeight: 420, position: "relative", margin: 20, background: "var(--surface-card)", border: "1px solid var(--border-hairline)", borderRadius: "var(--radius-md)", overflow: "hidden", minWidth: 0 }}>
          <svg ref={svgRef} role="group" aria-label="Goals linked by the capabilities they share. Arrow keys move between goals."
            style={{ width: "100%", height: "100%", display: "block", cursor: "grab", touchAction: "none" }}>
            <g ref={viewportRef}>
              <g>
                {data.edges.map((e) => {
                  const touches = e.source === focusId || e.target === focusId;
                  const shares = e.kind === "SHARES";
                  // Shares lines only for the goal pointed at or picked (C38, A44):
                  // drawn for every pair at rest, they crossed unrelated cards.
                  if (shares && !touches) return null;
                  const dim = focusId != null && !touches;
                  return (
                    <line key={e.id} ref={ref(edgeElsRef.current, e.id, "registerEdge", "unregisterEdge")}
                      stroke={shares ? "var(--accent)" : "var(--ink-4)"}
                      strokeWidth={(shares ? sharesWidth(e.weight) : 1.2) + (touches ? 1 : 0)}
                      strokeLinecap="round"
                      opacity={dim ? 0.06 : shares ? 0.7 : 0.6}
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
                    isTabStop={n.id === (focusedId ?? selectedId ?? data.nodes[0]?.id)}
                    isDimmed={focusId != null && focusId !== n.id && !focusNeighbors?.has(n.id)}
                    onSelect={onSelect} onHoverChange={setHoveredId}
                    onFocusNode={setFocusedId} onMove={moveFocus}
                    registerEl={ref(nodeElsRef.current, n.id, "registerNode", "unregisterNode")} />
                ))}
              </g>
            </g>
          </svg>
          <GraphToolbar
            onZoomIn={() => engineRef.current?.zoomBy(1.4)}
            onZoomOut={() => engineRef.current?.zoomBy(1 / 1.4)}
            onFit={() => engineRef.current?.fitToView()}
            toolbarRef={toolbarRef} />
          <NetworkKey keyRef={keyRef} onToggle={() => engineRef.current?.refit()} />
          <GraphCaption name={named?.goal.title} />
        </div>
        <GoalPanel goals={goals} edges={data.edges} capsByGoal={capsByGoal} selectedId={selectedId} onSelect={onSelect} />
      </div>
    </div>
  );
}

function GoalNode({ node, isSelected, isTabStop, isDimmed, onSelect, onHoverChange, onFocusNode, onMove, registerEl }) {
  const { goal, isOrg } = node;
  // A product goal's edge is the control border (3:1 or more on the card), so
  // at Fit, where names are hidden, every box still reads (C29).
  const ring = isSelected ? "var(--accent)" : isOrg ? "var(--surface-inverse)" : "var(--border-control)";
  return (
    <g ref={registerEl} data-node-id={node.id} tabIndex={isTabStop ? 0 : -1} role="button"
      aria-label={`${isOrg ? "Org goal" : "Product goal"}: ${goal.title}`} aria-pressed={isSelected}
      className={isDimmed ? "graph-node is-dim" : "graph-node"}
      onMouseEnter={() => onHoverChange(node.id)} onMouseLeave={() => onHoverChange(null)}
      onFocus={() => { onHoverChange(node.id); onFocusNode(node.id); }} onBlur={() => onHoverChange(null)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(node.id);
        } else if (["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"].includes(e.key)) {
          e.preventDefault();
          onMove(node.id, e.key);
        }
      }}
      style={{ cursor: "grab" }}>
      <title>{goal.title}</title>
      <rect x={-NODE_W / 2} y={-GOAL_H / 2} width={NODE_W} height={GOAL_H} rx={8}
        fill={isOrg ? "var(--surface-inverse)" : "var(--surface-card)"}
        stroke={ring} strokeWidth={isSelected ? 2 : 1}
        strokeDasharray={!isOrg && node.capCount === 0 ? "3,3" : undefined} />
      <circle cx={NODE_W / 2 - 10} cy={-GOAL_H / 2 + 10} r={3} fill={STATUS_DOT[goal.status] || STATUS_DOT.pending} />
      {/* Faded, the box fades but the name stays readable (base.css): dark on a faded org box, grey on a product's. */}
      <CardLabel name={goal.title} x={-NODE_W / 2 + 12} maxLines={GOAL_LINES}
        fill={isDimmed ? (isOrg ? "var(--text-heading)" : "var(--text-secondary)") : isOrg ? "var(--text-inverse)" : "var(--text-heading)"} />
    </g>
  );
}

function NetworkKey({ keyRef, onToggle }) {
  const row = { display: "flex", alignItems: "center", gap: 6 };
  const card = (fill, stroke, dash) => (
    <svg width="16" height="10"><rect x="1" y="1" width="14" height="8" rx="2" fill={fill} stroke={stroke} strokeDasharray={dash} /></svg>
  );
  const line = (stroke, width) => (
    <svg width="16" height="8"><line x1="0" y1="4" x2="16" y2="4" stroke={stroke} strokeWidth={width} strokeLinecap="round" /></svg>
  );
  return (
    <details ref={keyRef} onToggle={onToggle} style={{ position: "absolute", top: 10, left: 10, background: "var(--surface-card)", border: "1px solid var(--border-hairline)", borderRadius: "var(--radius-sm)", boxShadow: "var(--shadow-card)", padding: "6px 10px", fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", color: "var(--text-secondary)" }}>
      <summary style={{ cursor: "pointer", color: "var(--text-heading)" }}>Key</summary>
      <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 6 }}>
        <div style={row}>{card("var(--surface-inverse)", "var(--surface-inverse)")}org goal</div>
        <div style={row}>{card("var(--surface-card)", "var(--border-control)")}product goal</div>
        <div style={row}>{card("var(--surface-card)", "var(--border-control)", "2,2")}no capabilities linked</div>
        <div style={row}>{line("var(--ink-4)", 1.2)}part of</div>
        <div style={row}>{line("var(--accent)", 3)}share capabilities (thicker: more), shown for the goal you point at or pick</div>
        <div style={row}><span style={{ display: "flex", opacity: 0.25 }}>{card("var(--surface-card)", "var(--border-control)")}</span>faded: shares nothing with the goal you point at</div>
      </div>
    </details>
  );
}

function GoalPanel({ goals, edges, capsByGoal, selectedId, onSelect }) {
  const byId = React.useMemo(() => new Map(goals.map((g) => [g.id, g])), [goals]);
  const goal = selectedId ? byId.get(selectedId) : null;
  const panel = { flex: "1 1 300px", borderLeft: "1px solid var(--border-hairline)", background: "var(--surface-card)", padding: "16px 18px", overflowY: "auto", display: "flex", flexDirection: "column", gap: 14, fontSize: "var(--text-sm)" };
  const head = { fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", letterSpacing: "var(--tracking-caps)", textTransform: "uppercase", color: "var(--text-secondary)" };
  const goalButton = (g) => (
    <button type="button" onClick={() => onSelect(g.id)}
      style={{ font: "inherit", textAlign: "left", background: "none", border: "none", padding: 0, color: "var(--text-accent)", cursor: "pointer" }}>
      {g.title}
    </button>
  );
  // Every goal, one target 34px tall: the canvas's boxes are 21x10 at 390
  // after Fit, and the links below reach only goals that share or nest
  // (43 of 48). This is the same pick as pressing a goal on the canvas.
  const picker = (
    <Select aria-label="Goal" value={selectedId ?? ""} onChange={(e) => e.target.value && onSelect(e.target.value)}
      options={[{ value: "", label: "Pick a goal…", disabled: true }, ...goals.map((g) => ({ value: g.id, label: `${g.display_id} · ${g.title}` }))]} />
  );

  if (!goal) {
    const shares = edges.filter((e) => e.kind === "SHARES");
    const sharing = new Set(shares.flatMap((e) => [e.source, e.target]));
    const most = [...shares].sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id)).slice(0, 6);
    return (
      <aside className="graph-goal-panel" style={panel}>
        {picker}
        <div style={{ color: "var(--text-secondary)" }}>Pick a goal to see which other goals rely on the same capabilities.</div>
        <div style={{ color: "var(--text-secondary)" }}>{count(sharing.size, "goal")} of {goals.length} share a capability with another goal.</div>
        {most.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={head}>Share the most</div>
            {most.map((e) => (
              <div key={e.id} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <span>{goalButton(byId.get(e.source))} and {goalButton(byId.get(e.target))}</span>
                <span style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }} title={e.capabilities.map((c) => c.name).join(", ")}>
                  {count(e.weight, "capability", "capabilities")}
                </span>
              </div>
            ))}
          </div>
        )}
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
  // The Goals list's count, word for word (goal-facts.js): an org goal may link
  // nothing itself and still reach capabilities through its product goals.
  const counted = capabilityCount(goal, goals, capsByGoal);

  return (
    <aside className="graph-goal-panel" style={panel} aria-label="Selected goal">
      {picker}
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
            {counted.direct > 0 ? "No other goal uses its capabilities."
              : counted.total > 0 ? "Nothing directly: its product goals link its capabilities. Pick one to see what it shares."
              : "No capabilities linked, so nothing to share."}
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

      {counted.total > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={head}>{counted.text}</div>
          {caps.length > 0 && (
            <div style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>
              {caps.map((c, i) => (
                <React.Fragment key={c.id}>
                  {i > 0 && ", "}
                  <a href={`/capabilities/${c.slug}`}>{c.name}</a>
                </React.Fragment>
              ))}
            </div>
          )}
        </div>
      )}
    </aside>
  );
}
