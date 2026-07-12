import React from "react";
import { PageHeader } from "../shell/PageHeader.jsx";
import { Badge, Button, Dialog, Icon, Input, PriorityBadge, Select, StatusBadge, Tabs, Tag } from "../../ds";
import { api } from "../../lib/api.js";
import { FeatureGraphView } from "../graph/FeatureGraphView.jsx";

export default function FeaturesIsland() {
  const [tab, setTab] = React.useState("graph");
  const [layout, setLayout] = React.useState({ nodes: [], edges: [] });
  const [selected, setSelected] = React.useState(null);
  const [detail, setDetail] = React.useState(null);
  const [impact, setImpact] = React.useState(null);
  const [query, setQuery] = React.useState("");
  const [results, setResults] = React.useState(null);
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [capabilities, setCapabilities] = React.useState([]);
  const [draft, setDraft] = React.useState({ name: "", description: "", capabilityId: "", layer: "service", priority: "3" });
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [cutTargets, setCutTargets] = React.useState([]); // {kind: "feature"|"capability", id}
  const [cut, setCut] = React.useState(null);
  const [cutting, setCutting] = React.useState(false);

  const load = React.useCallback(async () => {
    const [data, caps] = await Promise.all([api("/graph/layout"), api("/capabilities")]);
    setLayout(data);
    setCapabilities(caps);
    setSelected((sel) => sel && data.nodes.some((n) => n.id === sel) ? sel : data.nodes[0]?.id ?? null);
    setDraft((d) => (d.capabilityId ? d : { ...d, capabilityId: caps[0]?.id ?? "" }));
  }, []);

  const capabilityById = React.useMemo(
    () => new Map(capabilities.map((c) => [c.id, c])),
    [capabilities]
  );

  React.useEffect(() => {
    load().catch((e) => setError(String(e.message)));
  }, [load]);

  React.useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    setImpact(null);
    api(`/features/${selected}`).then(setDetail).catch(() => setDetail(null));
  }, [selected]);

  React.useEffect(() => {
    if (!query.trim()) {
      setResults(null);
      return;
    }
    const timer = setTimeout(() => {
      api(`/features/search?q=${encodeURIComponent(query.trim())}`)
        .then(setResults)
        .catch(() => setResults([]));
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  const impactIds = new Set((impact?.dependents ?? []).map((d) => d.id));
  const directory = results ?? layout.nodes;

  const runImpact = async () => {
    if (!selected) return;
    setImpact(await api(`/graph/impact/${selected}`));
  };

  const nodeById = React.useMemo(() => new Map(layout.nodes.map((n) => [n.id, n])), [layout]);

  // Editing targets invalidates a previous cut — the overlay must never lie.
  const addCutTarget = (kind, id) => {
    setCutTargets((ts) => (ts.some((t) => t.kind === kind && t.id === id) ? ts : [...ts, { kind, id }]));
    setCut(null);
  };
  const removeCutTarget = (kind, id) => {
    setCutTargets((ts) => ts.filter((t) => !(t.kind === kind && t.id === id)));
    setCut(null);
  };
  const clearCut = () => {
    setCutTargets([]);
    setCut(null);
  };
  const runCut = async () => {
    setCutting(true);
    setError(null);
    try {
      setCut(await api("/graph/mvp-cut", {
        method: "POST",
        body: {
          features: cutTargets.filter((t) => t.kind === "feature").map((t) => t.id),
          capabilities: cutTargets.filter((t) => t.kind === "capability").map((t) => t.id),
        },
      }));
    } catch (e) {
      setError(String(e.message));
    } finally {
      setCutting(false);
    }
  };

  const cutStates = React.useMemo(() => {
    if (!cut) return null;
    const states = new Map();
    for (const f of cut.essential) states.set(f.id, f.is_target ? "target" : "essential");
    for (const f of cut.deferrable) states.set(f.id, "deferrable");
    return states;
  }, [cut]);

  const save = async () => {
    if (!draft.name.trim() || !draft.capabilityId) return;
    setSaving(true);
    setError(null);
    try {
      const created = await api("/features", {
        method: "POST",
        body: {
          name: draft.name.trim(),
          description: draft.description.trim() || null,
          capability_id: draft.capabilityId,
          facets: { layer: draft.layer },
          priority: Number(draft.priority),
        },
      });
      setDialogOpen(false);
      setDraft((d) => ({ name: "", description: "", capabilityId: d.capabilityId, layer: "service", priority: "3" }));
      await load();
      setSelected(created.id);
    } catch (e) {
      setError(String(e.message));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Features"
        meta={`${layout.nodes.length} nodes · ${layout.edges.length} edges · in-memory graph`}
        actions={
          <>
            <Input placeholder="Find features like…" style={{ width: 220 }} inputStyle={{ height: 30 }}
              value={query}
              onChange={(e) => { setQuery(e.target.value); if (e.target.value.trim()) setTab("directory"); }} />
            <Button size="sm" variant="accent" style={{ gap: 6 }} onClick={() => setDialogOpen(true)}>
              <Icon name="plus" size={13} />New feature
            </Button>
          </>
        }
      />
      <div style={{ padding: "12px 24px 0", flex: "none" }}>
        <Tabs tabs={[{ value: "graph", label: "Graph" }, { value: "directory", label: "Directory", count: directory.length }]} value={tab} onChange={setTab} />
      </div>
      {error && <div style={{ padding: "8px 24px", fontSize: "var(--text-sm)", color: "var(--danger-fg)" }}>{error}</div>}

      {tab === "graph" ? (
        <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
          <div style={{ flex: 1, position: "relative", margin: 20, background: "var(--surface-card)", border: "1px solid var(--border-hairline)", borderRadius: "var(--radius-md)", overflow: "hidden", minWidth: 0 }}>
            <FeatureGraphView layout={layout} selectedId={selected} onSelect={setSelected} impactIds={impactIds} cutStates={cutStates} />
          </div>
          <aside style={{ width: 280, flex: "none", margin: "20px 20px 20px 0", background: "var(--surface-card)", border: "1px solid var(--border-hairline)", borderRadius: "var(--radius-md)", padding: 16, display: "flex", flexDirection: "column", gap: 12, overflowY: "auto" }}>
            <MVPCutPanel
              capabilities={capabilities}
              nodeById={nodeById}
              capabilityById={capabilityById}
              selectedId={selected}
              targets={cutTargets}
              onAddTarget={addCutTarget}
              onRemoveTarget={removeCutTarget}
              onRun={runCut}
              onClear={clearCut}
              cut={cut}
              cutting={cutting}
            />
            <div style={{ borderTop: "1px solid var(--border-hairline)" }} />
            {detail ? (
              <>
                <div style={{ fontSize: "var(--text-md)", fontWeight: "var(--weight-semibold)", color: "var(--text-heading)" }}>{detail.name}</div>
                {detail.description && <div style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)", lineHeight: "var(--leading-snug)" }}>{detail.description}</div>}
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {detail.facets?.layer && <Tag type={detail.facets.layer}>{detail.facets.layer}</Tag>}
                  <StatusBadge status={detail.status} />
                </div>
                {capabilityById.get(detail.capability_id) && (
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-secondary)" }}>
                    REALIZES → {capabilityById.get(detail.capability_id).name}
                  </div>
                )}
                {detail.priority != null && <PriorityBadge priority={detail.priority} rationale={detail.priority_rationale} />}
                <div style={{ borderTop: "1px solid var(--border-hairline)", paddingTop: 12, display: "flex", flexDirection: "column", gap: 6 }}>
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "var(--tracking-caps)", textTransform: "uppercase", color: "var(--text-disabled)" }}>Relationships</div>
                  {detail.outgoing.map((r, i) => (
                    <div key={`o${i}`} style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-body)" }}>{r.kind} → {r.feature.name}</div>
                  ))}
                  {detail.incoming.map((r, i) => (
                    <div key={`i${i}`} style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-body)" }}>{r.feature.name} → {r.kind}</div>
                  ))}
                  {detail.outgoing.length + detail.incoming.length === 0 && (
                    <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-disabled)" }}>no edges</div>
                  )}
                </div>
                {impact && (
                  <div style={{ borderTop: "1px solid var(--border-hairline)", paddingTop: 12, display: "flex", flexDirection: "column", gap: 6 }}>
                    <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "var(--tracking-caps)", textTransform: "uppercase", color: "var(--text-disabled)" }}>Impact</div>
                    <div style={{ fontSize: "var(--text-xs)", color: "var(--text-body)" }}>
                      {impact.dependents.length} dependent{impact.dependents.length === 1 ? "" : "s"} break if this changes; needs {impact.dependencies.length}.
                    </div>
                    {impact.dependents.map((d) => (
                      <div key={d.id} style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--danger-fg)" }}>{d.name}</div>
                    ))}
                  </div>
                )}
                <Button size="sm" variant="secondary" style={{ marginTop: "auto", gap: 6 }} onClick={runImpact}>
                  <Icon name="git-branch" size={13} />Impact query
                </Button>
              </>
            ) : (
              <div style={{ fontSize: "var(--text-sm)", color: "var(--text-disabled)" }}>Select a feature.</div>
            )}
          </aside>
        </div>
      ) : (
        <div style={{ flex: 1, overflowY: "auto", padding: 20 }}>
          <div style={{ background: "var(--surface-card)", border: "1px solid var(--border-hairline)", borderRadius: "var(--radius-md)", overflow: "hidden" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 160px 110px 110px 120px", padding: "8px 16px", borderBottom: "1px solid var(--border-hairline)", fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "var(--tracking-caps)", textTransform: "uppercase", color: "var(--text-disabled)" }}>
              <span>Feature</span><span>Capability</span><span>Layer</span><span>Priority</span><span>Status</span>
            </div>
            {directory.map((n, i) => (
              <div key={n.id} onClick={() => { setSelected(n.id); setTab("graph"); }} style={{ display: "grid", gridTemplateColumns: "1fr 160px 110px 110px 120px", alignItems: "center", padding: "10px 16px", borderBottom: i < directory.length - 1 ? "1px solid var(--border-hairline)" : "none", cursor: "pointer", fontSize: "var(--text-sm)" }}>
                <span style={{ color: "var(--text-heading)", fontWeight: "var(--weight-medium)" }}>{n.name}</span>
                <span style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>{capabilityById.get(n.capability_id)?.name ?? "—"}</span>
                <span>{n.facets?.layer ? <Tag type={n.facets.layer}>{n.facets.layer}</Tag> : <span style={{ color: "var(--text-disabled)" }}>—</span>}</span>
                <span>{n.priority != null ? <PriorityBadge priority={n.priority} /> : <span style={{ color: "var(--text-disabled)" }}>—</span>}</span>
                <span><StatusBadge status={n.status} /></span>
              </div>
            ))}
            {directory.length === 0 && (
              <div style={{ padding: "16px", fontSize: "var(--text-sm)", color: "var(--text-disabled)" }}>
                0 features match{query ? ` "${query}"` : ""}.
              </div>
            )}
          </div>
        </div>
      )}

      <Dialog
        open={dialogOpen}
        title="New feature"
        onClose={() => setDialogOpen(false)}
        footer={
          <>
            <Button size="sm" variant="secondary" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button size="sm" variant="accent" disabled={saving || !draft.name.trim()} onClick={save}>Create feature</Button>
          </>
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Input label="Name (a change, verb phrase)" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Add Notion export backend" />
          <Input label="Description" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
          <Select label="Realizes capability" value={draft.capabilityId} onChange={(e) => setDraft({ ...draft, capabilityId: e.target.value })}
            options={capabilities.map((c) => ({ value: c.id, label: c.name }))} />
          <Select label="Layer" value={draft.layer} onChange={(e) => setDraft({ ...draft, layer: e.target.value })} options={["ui", "service", "integration", "infra"]} />
          <Select label="Priority (1 hottest)" value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: e.target.value })} options={["1", "2", "3", "4", "5"]} />
        </div>
      </Dialog>
    </>
  );
}

const CAPS_HEADER = {
  fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "var(--tracking-caps)",
  textTransform: "uppercase", color: "var(--text-disabled)",
};
const MONO_ROW = { fontFamily: "var(--font-mono)", fontSize: 11 };
const ELLIPSIS = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };

// Schedule-free MVP scoping: pick targets, run the prerequisite closure,
// read back essential (build order) vs deferrable (priority order).
function MVPCutPanel({ capabilities, nodeById, capabilityById, selectedId, targets, onAddTarget, onRemoveTarget, onRun, onClear, cut, cutting }) {
  const selectedTargeted = targets.some((t) => t.kind === "feature" && t.id === selectedId);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={CAPS_HEADER}>MVP cut</div>
      {targets.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {targets.map((t) => {
            const label = t.kind === "feature"
              ? nodeById.get(t.id)?.name ?? "unknown feature"
              : capabilityById.get(t.id)?.name ?? "unknown capability";
            return <Tag key={`${t.kind}:${t.id}`} onRemove={() => onRemoveTarget(t.kind, t.id)}>{label}</Tag>;
          })}
        </div>
      )}
      <Select value="" onChange={(e) => e.target.value && onAddTarget("capability", e.target.value)}
        options={[{ value: "", label: "Target a capability…" },
          ...capabilities.map((c) => ({ value: c.id, label: c.name }))]} />
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <Button size="sm" variant="secondary" disabled={!selectedId || selectedTargeted}
          onClick={() => onAddTarget("feature", selectedId)}>Target selected</Button>
        <Button size="sm" variant="accent" disabled={targets.length === 0 || cutting} onClick={onRun}>
          {cutting ? "Cutting…" : "Run cut"}
        </Button>
        {(targets.length > 0 || cut) && (
          <Button size="sm" variant="secondary" onClick={onClear}>Clear</Button>
        )}
      </div>
      {cut && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ fontSize: "var(--text-xs)", color: "var(--text-body)" }}>
            {cut.essential.length} essential · {cut.deferrable.length} deferrable
          </div>
          {cut.capabilities.map((c) => (
            <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 6, ...MONO_ROW }}>
              <span style={{ color: "var(--text-body)", flex: 1, ...ELLIPSIS }}>{c.name}</span>
              <span style={{ color: c.essential ? "var(--ok-fg)" : "var(--text-disabled)", flex: "none" }}>
                {c.required}/{c.total}
              </span>
            </div>
          ))}
          <div style={{ ...CAPS_HEADER, marginTop: 4 }}>Build order (essential)</div>
          {cut.essential.map((f, i) => (
            <div key={f.id} style={{ ...MONO_ROW, ...ELLIPSIS, color: f.is_target ? "var(--text-accent)" : "var(--text-body)" }}>
              {i + 1}. {f.name}
            </div>
          ))}
          <div style={{ ...CAPS_HEADER, marginTop: 4 }}>Nice to have (deferred)</div>
          {cut.deferrable.slice(0, 8).map((f) => (
            <div key={f.id} style={{ display: "flex", alignItems: "center", gap: 6, ...MONO_ROW, color: "var(--text-secondary)" }}>
              <span style={{ flex: 1, ...ELLIPSIS }}>{f.name}</span>
              {f.priority != null && <PriorityBadge priority={f.priority} />}
            </div>
          ))}
          {cut.deferrable.length > 8 && (
            <div style={{ ...MONO_ROW, color: "var(--text-disabled)" }}>+{cut.deferrable.length - 8} more</div>
          )}
          {cut.deferrable.length === 0 && (
            <div style={{ ...MONO_ROW, color: "var(--text-disabled)" }}>nothing deferrable — targets need the whole graph</div>
          )}
        </div>
      )}
    </div>
  );
}
