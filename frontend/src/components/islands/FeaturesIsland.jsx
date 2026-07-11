import React from "react";
import { PageHeader } from "../shell/PageHeader.jsx";
import { Badge, Button, Dialog, Icon, Input, PriorityBadge, Select, StatusBadge, Tabs, Tag } from "../../ds";
import { api } from "../../lib/api.js";

const NODE_W = 140;
const NODE_H = 52;

export default function FeaturesIsland() {
  const [tab, setTab] = React.useState("graph");
  const [layout, setLayout] = React.useState({ nodes: [], edges: [] });
  const [selected, setSelected] = React.useState(null);
  const [detail, setDetail] = React.useState(null);
  const [impact, setImpact] = React.useState(null);
  const [query, setQuery] = React.useState("");
  const [results, setResults] = React.useState(null);
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [draft, setDraft] = React.useState({ name: "", description: "", type: "capability", priority: "3" });
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState(null);

  const load = React.useCallback(async () => {
    const data = await api("/graph/layout");
    setLayout(data);
    setSelected((sel) => sel && data.nodes.some((n) => n.id === sel) ? sel : data.nodes[0]?.id ?? null);
  }, []);

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

  const byId = Object.fromEntries(layout.nodes.map((n) => [n.id, n]));
  const canvasW = Math.max(660, ...layout.nodes.map((n) => n.x + NODE_W + 60));
  const canvasH = Math.max(290, ...layout.nodes.map((n) => n.y + NODE_H + 60));
  const impactIds = new Set((impact?.dependents ?? []).map((d) => d.id));
  const directory = results ?? layout.nodes;

  const runImpact = async () => {
    if (!selected) return;
    setImpact(await api(`/graph/impact/${selected}`));
  };

  const save = async () => {
    if (!draft.name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const created = await api("/features", {
        method: "POST",
        body: {
          name: draft.name.trim(),
          description: draft.description.trim() || null,
          type: draft.type,
          priority: Number(draft.priority),
        },
      });
      setDialogOpen(false);
      setDraft({ name: "", description: "", type: "capability", priority: "3" });
      await load();
      setSelected(created.id);
    } catch (e) {
      setError(String(e.message));
    } finally {
      setSaving(false);
    }
  };

  const nodeCard = (n) => {
    const isSelected = selected === n.id;
    const inImpact = impactIds.has(n.id);
    return (
      <button key={n.id} onClick={() => setSelected(n.id)} style={{
        position: "absolute", left: n.x, top: n.y, width: NODE_W,
        background: "var(--surface-card)", textAlign: "left", cursor: "pointer",
        border: isSelected ? "1.5px solid var(--accent)" : inImpact ? "1.5px solid var(--danger-fg)" : "1px solid var(--border-default)",
        boxShadow: isSelected ? "var(--ring-focus)" : "var(--shadow-card)",
        borderRadius: "var(--radius-md)", padding: "8px 10px", fontFamily: "var(--font-body)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 3 }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: `var(--stage-${{ capability: "feature", integration: "spec", ui: "goal", infra: "ticket" }[n.type]})` }} />
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--text-secondary)" }}>{n.display_id}</span>
        </div>
        <div style={{ fontSize: 12, fontWeight: "var(--weight-medium)", color: "var(--text-heading)", lineHeight: 1.3 }}>{n.name}</div>
      </button>
    );
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
          <div style={{ flex: 1, position: "relative", margin: 20, background: "var(--surface-card)", border: "1px solid var(--border-hairline)", borderRadius: "var(--radius-md)", overflow: "auto", minWidth: 0 }}>
            <div style={{ position: "relative", width: canvasW, height: canvasH }}>
              <svg width={canvasW} height={canvasH} style={{ position: "absolute", inset: 0 }}>
                {layout.edges.map((e, i) => {
                  const src = byId[e.src];
                  const dst = byId[e.dst];
                  if (!src || !dst) return null;
                  return (
                    <line key={i}
                      x1={src.x + NODE_W / 2} y1={src.y + NODE_H / 2}
                      x2={dst.x + NODE_W / 2} y2={dst.y + NODE_H / 2}
                      stroke="var(--ink-3)" strokeWidth="1.5"
                      strokeDasharray={src.status === "pending" ? "4 4" : "none"} />
                  );
                })}
              </svg>
              {layout.nodes.map(nodeCard)}
            </div>
            <div style={{ position: "sticky", bottom: 10, left: 12, padding: "0 12px", fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-disabled)" }}>
              impact(f) → dependents via DEPENDS_ON
            </div>
          </div>
          <aside style={{ width: 280, flex: "none", margin: "20px 20px 20px 0", background: "var(--surface-card)", border: "1px solid var(--border-hairline)", borderRadius: "var(--radius-md)", padding: 16, display: "flex", flexDirection: "column", gap: 12, overflowY: "auto" }}>
            {detail ? (
              <>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", color: "var(--text-secondary)" }}>{detail.display_id}</div>
                <div style={{ fontSize: "var(--text-md)", fontWeight: "var(--weight-semibold)", color: "var(--text-heading)" }}>{detail.name}</div>
                {detail.description && <div style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)", lineHeight: "var(--leading-snug)" }}>{detail.description}</div>}
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <Tag type={detail.type}>{detail.type}</Tag>
                  <StatusBadge status={detail.status} />
                </div>
                {detail.priority != null && <PriorityBadge priority={detail.priority} rationale={detail.priority_rationale} />}
                <div style={{ borderTop: "1px solid var(--border-hairline)", paddingTop: 12, display: "flex", flexDirection: "column", gap: 6 }}>
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "var(--tracking-caps)", textTransform: "uppercase", color: "var(--text-disabled)" }}>Relationships</div>
                  {detail.outgoing.map((r, i) => (
                    <div key={`o${i}`} style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-body)" }}>{r.kind} → {r.feature.display_id} {r.feature.name}</div>
                  ))}
                  {detail.incoming.map((r, i) => (
                    <div key={`i${i}`} style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-body)" }}>{r.feature.display_id} {r.feature.name} → {r.kind}</div>
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
                      <div key={d.id} style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--danger-fg)" }}>{d.display_id} {d.name}</div>
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
            <div style={{ display: "grid", gridTemplateColumns: "90px 1fr 120px 110px 120px", padding: "8px 16px", borderBottom: "1px solid var(--border-hairline)", fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "var(--tracking-caps)", textTransform: "uppercase", color: "var(--text-disabled)" }}>
              <span>ID</span><span>Feature</span><span>Type</span><span>Priority</span><span>Status</span>
            </div>
            {directory.map((n, i) => (
              <div key={n.id} onClick={() => { setSelected(n.id); setTab("graph"); }} style={{ display: "grid", gridTemplateColumns: "90px 1fr 120px 110px 120px", alignItems: "center", padding: "10px 16px", borderBottom: i < directory.length - 1 ? "1px solid var(--border-hairline)" : "none", cursor: "pointer", fontSize: "var(--text-sm)" }}>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-secondary)" }}>{n.display_id}</span>
                <span style={{ color: "var(--text-heading)", fontWeight: "var(--weight-medium)" }}>{n.name}</span>
                <span><Tag type={n.type}>{n.type}</Tag></span>
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
          <Input label="Name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Semantic feature search" />
          <Input label="Description" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
          <Select label="Type" value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value })} options={["capability", "integration", "ui", "infra"]} />
          <Select label="Priority (1 hottest)" value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: e.target.value })} options={["1", "2", "3", "4", "5"]} />
        </div>
      </Dialog>
    </>
  );
}
