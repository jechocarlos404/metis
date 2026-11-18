import React from "react";
import { PageHeader } from "../shell/PageHeader.jsx";
import { Button, Checkbox, Dialog, Icon, IconButton, Input, PriorityBadge, Select, StatusBadge, Tabs, Tag, DeleteConfirm } from "../../ds";
import { productOptions } from "../../lib/words.js";
import { api, ApiError } from "../../lib/api.js";
import { FeatureGraphView } from "../graph/FeatureGraphView.jsx";
import { pressable } from "../../lib/pressable.js";
import { useParamRestore, writeParams } from "../../lib/url-state.js";

export default function FeaturesIsland({ canWrite = true }) {
  const [tab, setTab] = React.useState("directory");
  const [layout, setLayout] = React.useState({ nodes: [], edges: [] });
  const [selected, setSelected] = React.useState(null);
  const [detail, setDetail] = React.useState(null);
  const [inJourneys, setInJourneys] = React.useState([]);
  const [impact, setImpact] = React.useState(null);
  const [query, setQuery] = React.useState("");
  const [results, setResults] = React.useState(null);
  const [dialog, setDialog] = React.useState(null); // null | {mode:"new"} | {mode:"edit"}
  const [capabilities, setCapabilities] = React.useState([]);
  const [edgeList, setEdgeList] = React.useState([]);
  const [products, setProducts] = React.useState([]);
  const [goalParent, setGoalParent] = React.useState(new Map()); // goal id -> parent goal id
  const [productFilter, setProductFilter] = React.useState(""); // "" | "unattributed" | product id

  // ?feature=<id>&tab=graph&product=<id>: linkable, and Back restores the previous view.
  useParamRestore("feature", (v) => v && setSelected(v));
  useParamRestore("tab", (v) => setTab(v === "graph" ? "graph" : "directory"));
  useParamRestore("product", (v) => setProductFilter(v ?? ""));
  const selectFeature = React.useCallback((id) => {
    setSelected(id);
    writeParams({ feature: id }, { push: true });
  }, []);
  const changeTab = (t) => { setTab(t); writeParams({ tab: t === "graph" ? "graph" : "" }, { push: true }); };
  const changeProduct = (v) => { setProductFilter(v); writeParams({ product: v }, { push: true }); };
  const [draft, setDraft] = React.useState(EMPTY_DRAFT);
  const [capQuery, setCapQuery] = React.useState("");
  const [edgeDraft, setEdgeDraft] = React.useState({ kind: "DEPENDS_ON", targetId: "" });
  const [saving, setSaving] = React.useState(false);
  const [confirmingDelete, setConfirmingDelete] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [cutTargets, setCutTargets] = React.useState([]); // {kind: "feature"|"capability", id}
  const [cut, setCut] = React.useState(null);
  const [cutting, setCutting] = React.useState(false);
  const [ready, setReady] = React.useState([]);
  const [why, setWhy] = React.useState(null);
  const [cycles, setCycles] = React.useState([]);
  const [topoOrder, setTopoOrder] = React.useState(null);
  const [topoError, setTopoError] = React.useState(null);

  const load = React.useCallback(async () => {
    const [data, caps, edges, productList, readyData, cyclesData] = await Promise.all([
      api("/graph/layout"),
      api("/capabilities"),
      api("/features/edges"),
      api("/products"),
      api("/graph/ready"),
      api("/graph/cycles"),
    ]);
    api("/goals").then((gs) => setGoalParent(new Map(gs.map((g) => [g.id, g.parent_goal_id])))).catch(() => {});
    setLayout(data);
    setCapabilities(caps);
    setEdgeList(edges);
    setProducts(productList);
    setReady(readyData.ready ?? []);
    setCycles(cyclesData.cycles ?? []);
    try {
      const topoData = await api("/graph/topo");
      setTopoOrder(topoData.order ?? []);
      setTopoError(null);
    } catch (e) {
      setTopoOrder(null);
      if (e instanceof ApiError && e.status === 409 && typeof e.detail === "object" && e.detail?.message) {
        setTopoError(e.detail.message);
      } else {
        setTopoError(String(e.message));
      }
    }
    setSelected((sel) => sel && data.nodes.some((n) => n.id === sel) ? sel : data.nodes[0]?.id ?? null);
  }, []);

  const capabilityById = React.useMemo(
    () => new Map(capabilities.map((c) => [c.id, c])),
    [capabilities]
  );

  React.useEffect(() => {
    load().catch((e) => setError(String(e.message)));
  }, [load]);

  const refreshDetail = React.useCallback(async (id) => {
    if (!id) {
      setDetail(null);
      setWhy(null);
      return;
    }
    try {
      const [feature, whyChain, journeys] = await Promise.all([
        api(`/features/${id}`),
        api(`/features/${id}/why`),
        api(`/journeys?feature_id=${id}`),
      ]);
      setDetail(feature);
      setWhy(whyChain);
      setInJourneys(journeys);
    } catch {
      setDetail(null);
      setWhy(null);
      setInJourneys([]);
    }
  }, []);

  React.useEffect(() => {
    setImpact(null);
    refreshDetail(selected);
  }, [selected, refreshDetail]);

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

  const nodeById = React.useMemo(() => new Map(layout.nodes.map((n) => [n.id, n])), [layout]);
  const productById = React.useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  // A feature's product is its own (features.product_id); search results lack
  // it, so always read it off the layout node.
  const matchesProduct = React.useCallback((id) => {
    if (!productFilter) return true;
    const ids = nodeById.get(id)?.product_ids ?? [];
    return productFilter === "unattributed" ? ids.length === 0 : ids.includes(productFilter);
  }, [productFilter, nodeById]);

  const directory = (results ?? layout.nodes).filter((n) => matchesProduct(n.id));

  // The product filter removes other products' features from the graph and the
  // panels (fading them was invisible at real scale, so the filter looked broken).
  const visibleLayout = React.useMemo(() => {
    if (!productFilter) return layout;
    const keep = new Set(layout.nodes.filter((n) => matchesProduct(n.id)).map((n) => n.id));
    return {
      ...layout,
      nodes: layout.nodes.filter((n) => keep.has(n.id)),
      edges: layout.edges.filter((e) => keep.has(e.src) && keep.has(e.dst)),
    };
  }, [productFilter, layout, matchesProduct]);
  // Org goals the selected feature's own products sit under.
  const ownGoalRoots = React.useMemo(() => {
    const roots = new Set();
    if (!detail) return roots;
    for (const pid of nodeById.get(detail.id)?.product_ids ?? []) {
      let cur = productById.get(pid)?.goal_id;
      for (let i = 0; i < 20 && cur && goalParent.get(cur); i++) cur = goalParent.get(cur);
      if (cur) roots.add(cur);
    }
    return roots;
  }, [detail, nodeById, productById, goalParent]);
  const visibleReady = productFilter ? ready.filter((f) => matchesProduct(f.id)) : ready;
  const visibleTopo = productFilter && topoOrder ? topoOrder.filter((f) => matchesProduct(f.id)) : topoOrder;

  const runImpact = async () => {
    if (!selected) return;
    setImpact(await api(`/graph/impact/${selected}`));
  };

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

  const openNew = () => {
    // Start blank: openEdit leaves the last feature in the draft. Keep only the product, as a create does.
    setDraft((d) => ({ ...EMPTY_DRAFT, productId: d.productId }));
    setCapQuery("");
    setConfirmingDelete(false);
    setError(null);
    setDialog({ mode: "new" });
  };

  const openEdit = () => {
    if (!detail) return;
    setDraft({
      name: detail.name,
      description: detail.description ?? "",
      capabilityIds: detail.capability_ids,
      unknownCapabilities: detail.unknown_capabilities,
      productId: detail.product_id ?? "",
      layer: detail.facets?.layer ?? "service",
      priority: detail.priority != null ? String(detail.priority) : "",
      status: detail.status,
    });
    setCapQuery("");
    setConfirmingDelete(false);
    setError(null);
    setDialog({ mode: "edit" });
  };

  // At least one capability, unless the rest are declared unknown.
  const canSave = Boolean(draft.name.trim()) && (draft.capabilityIds.length > 0 || draft.unknownCapabilities);
  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      const body = {
        name: draft.name.trim(),
        description: draft.description.trim() || null,
        capability_ids: draft.capabilityIds,
        unknown_capabilities: draft.unknownCapabilities,
        product_id: draft.productId || null,
        priority: draft.priority === "" ? null : Number(draft.priority),
      };
      if (dialog.mode === "new") {
        const created = await api("/features", {
          method: "POST",
          body: { ...body, facets: { layer: draft.layer } },
        });
        setDraft((d) => ({ ...EMPTY_DRAFT, productId: d.productId }));
        await load();
        selectFeature(created.id);
      } else {
        await api(`/features/${detail.id}`, {
          method: "PATCH",
          body: { ...body, facets: { ...detail.facets, layer: draft.layer }, status: draft.status },
        });
        await load();
        await refreshDetail(detail.id);
      }
      setDialog(null);
    } catch (e) {
      setError(String(e.message));
    } finally {
      setSaving(false);
    }
  };

  const removeFeature = async () => {
    setSaving(true);
    setError(null);
    try {
      await api(`/features/${detail.id}`, { method: "DELETE" });
      setDialog(null);
      setSelected(null);
      await load();
    } catch (e) {
      setError(String(e.message));
      setConfirmingDelete(false);
    } finally {
      setSaving(false);
    }
  };

  const addEdge = async () => {
    if (!selected || !edgeDraft.targetId) return;
    setError(null);
    try {
      await api("/features/edges", {
        method: "POST",
        body: { src_id: selected, dst_id: edgeDraft.targetId, kind: edgeDraft.kind },
      });
      setEdgeDraft((d) => ({ ...d, targetId: "" }));
      await load();
      await refreshDetail(selected);
    } catch (e) {
      setError(String(e.message));
    }
  };

  const removeEdge = async (srcId, dstId, kind) => {
    const edge = edgeList.find((e) => e.src_id === srcId && e.dst_id === dstId && e.kind === kind);
    if (!edge) return;
    setError(null);
    try {
      await api(`/features/edges/${edge.id}`, { method: "DELETE" });
      await load();
      await refreshDetail(selected);
    } catch (e) {
      setError(String(e.message));
    }
  };

  return (
    <>
      <PageHeader
        title="Features"
        meta={`${visibleLayout.nodes.length} features · ${visibleLayout.edges.length} edges · ${visibleReady.length} ready${productFilter ? ` · filtered from ${layout.nodes.length}` : ""}`}
        actions={
          <>
            {products.length > 0 && (
              <Select value={productFilter} onChange={(e) => changeProduct(e.target.value)} style={{ width: 200 }}
                options={[{ value: "", label: "All products" },
                  ...productOptions(products),
                  { value: "unattributed", label: "No product" }]} />
            )}
            <Input placeholder="Find features like…" style={{ width: 220 }} inputStyle={{ height: 30 }}
              value={query}
              onChange={(e) => { setQuery(e.target.value); if (e.target.value.trim()) setTab("directory"); }} />
            {canWrite && (
              <Button size="sm" variant="accent" style={{ gap: 6 }} onClick={openNew}>
                <Icon name="plus" size={13} />New feature
              </Button>
            )}
          </>
        }
      />
      <div style={{ padding: "12px 24px 0", flex: "none" }}>
        <Tabs tabs={[{ value: "directory", label: "Directory", count: directory.length }, { value: "graph", label: "Graph" }]} value={tab} onChange={changeTab} />
      </div>
      {error && !dialog && <div style={{ padding: "8px 24px", fontSize: "var(--text-sm)", color: "var(--danger-fg)" }}>{error}</div>}

      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        {tab === "graph" ? (
          <div style={{ flex: 1, position: "relative", margin: 20, background: "var(--surface-card)", border: "1px solid var(--border-hairline)", borderRadius: "var(--radius-md)", overflow: "hidden", minWidth: 0 }}>
            <FeatureGraphView layout={visibleLayout} fitKey={productFilter} selectedId={selected} onSelect={selectFeature} impactIds={impactIds} cutStates={cutStates} />
          </div>
        ) : (
        <div style={{ flex: 1, minWidth: 0, overflowY: "auto", padding: 20 }}>
          <div style={{ background: "var(--surface-card)", border: "1px solid var(--border-hairline)", borderRadius: "var(--radius-md)", overflow: "hidden" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 160px 110px 110px 120px", padding: "8px 16px", borderBottom: "1px solid var(--border-hairline)", fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "var(--tracking-caps)", textTransform: "uppercase", color: "var(--text-secondary)" }}>
              <span>Feature</span><span>Capability</span><span>Product</span><span>Priority</span><span>Status</span>
            </div>
            {directory.map((n, i) => (
              <div key={n.id} {...pressable(() => selectFeature(n.id))} aria-pressed={selected === n.id} style={{ display: "grid", gridTemplateColumns: "1fr 160px 110px 110px 120px", alignItems: "center", padding: "10px 16px", borderBottom: i < directory.length - 1 ? "1px solid var(--border-hairline)" : "none", cursor: "pointer", fontSize: "var(--text-sm)", background: selected === n.id ? "var(--surface-hover)" : undefined }}>
                <span style={{ color: "var(--text-heading)", fontWeight: "var(--weight-medium)" }}>{n.name}</span>
                <span title={(n.capability_ids ?? []).map((c) => capabilityById.get(c)?.name).join(", ")} style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)", ...ELLIPSIS }}>{capabilityNames(n.capability_ids, capabilityById)}</span>
                <span style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)", ...ELLIPSIS }}>{(nodeById.get(n.id)?.product_ids ?? []).map((pid) => productById.get(pid)?.name ?? "").filter(Boolean).join(", ") || "—"}</span>
                <span>{n.priority != null ? <PriorityBadge priority={n.priority} /> : <span style={{ color: "var(--text-secondary)" }}>—</span>}</span>
                <span><StatusBadge status={n.status} /></span>
              </div>
            ))}
            {directory.length === 0 && (
              <div style={{ padding: "16px", fontSize: "var(--text-sm)", color: "var(--text-secondary)" }}>
                0 features match{query ? ` "${query}"` : ""}.
              </div>
            )}
          </div>
        </div>
        )}
          <aside style={{ width: 280, flex: "none", margin: "20px 20px 20px 0", background: "var(--surface-card)", border: "1px solid var(--border-hairline)", borderRadius: "var(--radius-md)", padding: 16, display: "flex", flexDirection: "column", gap: 12, overflowY: "auto" }}>
            {detail ? (
              <>
                <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                  <div style={{ flex: 1, fontSize: "var(--text-md)", fontWeight: "var(--weight-semibold)", color: "var(--text-heading)" }}>{detail.name}</div>
                  {canWrite && (
                    <IconButton size="sm" label="Edit feature" onClick={openEdit}><Icon name="pencil" size={13} /></IconButton>
                  )}
                </div>
                {detail.description && <div style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)", lineHeight: "var(--leading-snug)" }}>{detail.description}</div>}
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {detail.facets?.layer && <Tag type={detail.facets.layer}>{detail.facets.layer}</Tag>}
                  <StatusBadge status={detail.status} />
                </div>
                {detail.capability_ids.map((cid) => (
                  <div key={cid} style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-secondary)" }}>
                    does → {capabilityById.get(cid)?.name ?? "unknown capability"}
                  </div>
                ))}
                {detail.unknown_capabilities && (
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-secondary)" }}>
                    does → {detail.capability_ids.length ? "+ " : ""}capabilities not yet identified
                  </div>
                )}
                {products.length > 0 && (
                  (nodeById.get(detail.id)?.product_ids ?? []).length > 0 ? (
                    nodeById.get(detail.id).product_ids.map((pid) => (
                      <div key={pid} style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-secondary)" }}>
                        product → {productById.get(pid)?.name ?? "unknown product"}{productById.get(pid)?.external ? " · external, not our work" : ""}
                      </div>
                    ))
                  ) : (
                    <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-secondary)" }}>
                      no product
                    </div>
                  )
                )}
                {inJourneys.map((j) => (
                  <a key={j.id} href={`/journeys?id=${j.id}`} style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-accent)", textDecoration: "none" }}>
                    in journey → {j.name}
                  </a>
                ))}
                {detail.priority != null && <PriorityBadge priority={detail.priority} rationale={detail.priority_rationale} />}
                <WhyChainPanel chain={why?.chain} goalParent={goalParent} ownRoots={ownGoalRoots} />
                <div style={{ borderTop: "1px solid var(--border-hairline)", paddingTop: 12, display: "flex", flexDirection: "column", gap: 6 }}>
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "var(--tracking-caps)", textTransform: "uppercase", color: "var(--text-secondary)" }}>Relationships</div>
                  {detail.outgoing.map((r, i) => (
                    <div key={`o${i}`} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-body)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.kind} → {r.feature.name}</span>
                      {canWrite && (
                        <IconButton size="sm" label="Remove edge" onClick={() => removeEdge(detail.id, r.feature.id, r.kind)}><Icon name="x" size={12} /></IconButton>
                      )}
                    </div>
                  ))}
                  {detail.incoming.map((r, i) => (
                    <div key={`i${i}`} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-body)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.feature.name} → {r.kind}</span>
                      {canWrite && (
                        <IconButton size="sm" label="Remove edge" onClick={() => removeEdge(r.feature.id, detail.id, r.kind)}><Icon name="x" size={12} /></IconButton>
                      )}
                    </div>
                  ))}
                  {detail.outgoing.length + detail.incoming.length === 0 && (
                    <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-secondary)" }}>no edges</div>
                  )}
                  {canWrite && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 4 }}>
                      <Select value={edgeDraft.kind} onChange={(e) => setEdgeDraft({ ...edgeDraft, kind: e.target.value })}
                        options={["DEPENDS_ON", "BLOCKS", "RELATES_TO"]} />
                      <Select value={edgeDraft.targetId} onChange={(e) => setEdgeDraft({ ...edgeDraft, targetId: e.target.value })}
                        options={[{ value: "", label: "Target feature…" },
                          ...layout.nodes.filter((n) => n.id !== detail.id).map((n) => ({ value: n.id, label: n.name }))]} />
                      <Button size="sm" variant="secondary" disabled={!edgeDraft.targetId} onClick={addEdge} style={{ gap: 6 }}>
                        <Icon name="plus" size={13} />Add edge
                      </Button>
                    </div>
                  )}
                </div>
                {impact && (
                  <div style={{ borderTop: "1px solid var(--border-hairline)", paddingTop: 12, display: "flex", flexDirection: "column", gap: 6 }}>
                    <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "var(--tracking-caps)", textTransform: "uppercase", color: "var(--text-secondary)" }}>Impact</div>
                    <div style={{ fontSize: "var(--text-xs)", color: "var(--text-body)" }}>
                      {impact.dependents.length} dependent{impact.dependents.length === 1 ? "" : "s"} break if this changes; needs {impact.dependencies.length}.
                    </div>
                    {impact.dependents.map((d) => (
                      <div key={d.id} style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--danger-fg)" }}>{d.name}</div>
                    ))}
                  </div>
                )}
                <Button size="sm" variant="secondary" style={{ gap: 6 }} onClick={runImpact}>
                  <Icon name="git-branch" size={13} />Impact query
                </Button>
              </>
            ) : (
              <div style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)" }}>Select a feature.</div>
            )}
            <div style={{ borderTop: "1px solid var(--border-hairline)" }} />
            <ReadyFrontierPanel ready={visibleReady} selectedId={selected} onSelect={selectFeature} />
            <GraphDiagnosticsPanel
              cycles={cycles}
              topoOrder={visibleTopo}
              topoError={topoError}
              selectedId={selected}
              onSelect={selectFeature}
            />
            <div style={{ borderTop: "1px solid var(--border-hairline)" }} />
            {canWrite && (
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
            )}
          </aside>
      </div>

      <Dialog
        open={dialog != null}
        title={dialog?.mode === "new" ? "New feature" : `Edit ${detail?.name ?? ""}`}
        onClose={() => setDialog(null)}
        footer={
          <>
            {dialog?.mode === "edit" && (
              <DeleteConfirm armed={confirmingDelete} onArm={() => setConfirmingDelete(true)} onCancel={() => setConfirmingDelete(false)} onConfirm={removeFeature} disabled={saving}
                label="Delete" confirmLabel={"Delete feature"} style={{ marginRight: "auto" }} />
            )}
            <Button size="sm" variant="secondary" onClick={() => setDialog(null)}>Cancel</Button>
            <Button size="sm" variant="accent" disabled={saving || !canSave} onClick={save}>
              {dialog?.mode === "new" ? "Create feature" : "Save"}
            </Button>
          </>
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {error && <div role="alert" style={{ fontSize: "var(--text-sm)", color: "var(--danger-fg)" }}>{error}</div>}
          <Input label="Name (what the user gets, verb phrase)" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Export tickets to Notion" />
          <Input label="Description" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
          <Select label="Product" value={draft.productId} onChange={(e) => setDraft({ ...draft, productId: e.target.value })}
            options={[{ value: "", label: "— none —" }, ...productOptions(products)]} />
          <CapabilityPicker capabilities={capabilities} selected={draft.capabilityIds} query={capQuery} onQuery={setCapQuery}
            onChange={(ids) => setDraft({ ...draft, capabilityIds: ids })} />
          <Checkbox label="Some capabilities are unknown — link only the ones you can name"
            checked={draft.unknownCapabilities} onChange={(on) => setDraft({ ...draft, unknownCapabilities: on })} />
          <Select label="Layer" value={draft.layer} onChange={(e) => setDraft({ ...draft, layer: e.target.value })} options={["ui", "service", "integration", "infra"]} />
          <Select label="Priority (1 hottest)" value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: e.target.value })}
            options={dialog?.mode === "edit" ? [{ value: "", label: "—" }, "1", "2", "3", "4", "5"] : ["1", "2", "3", "4", "5"]} />
          {dialog?.mode === "edit" && (
            <Select label="Status" value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value })}
              options={[{ value: "pending", label: "planned" }, { value: "in_progress", label: "in progress" }, { value: "done", label: "done" }]} />
          )}
        </div>
      </Dialog>
    </>
  );
}

const EMPTY_DRAFT = { name: "", description: "", capabilityIds: [], unknownCapabilities: false, productId: "", layer: "service", priority: "3", status: "pending" };

function capabilityNames(ids, capabilityById) {
  const names = (ids ?? []).map((c) => capabilityById.get(c)?.name).filter(Boolean);
  return names.length ? names.join(", ") : "—";
}

// Every capability the feature REALIZES. Exact picks only: the inventory is only
// as accurate as these links, so there is no free-text entry here.
function CapabilityPicker({ capabilities, selected, query, onQuery, onChange }) {
  const chosen = new Set(selected);
  const q = query.trim().toLowerCase();
  const shown = capabilities.filter((c) => chosen.has(c.id) || !q || c.name.toLowerCase().includes(q));
  const toggle = (id, on) => onChange(on ? [...selected, id] : selected.filter((x) => x !== id));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ ...CAPS_HEADER, color: "var(--text-secondary)" }}>
        Realizes capabilities · {selected.length} selected
      </div>
      <Input value={query} onChange={(e) => onQuery(e.target.value)} placeholder="Filter capabilities" />
      <div style={{ maxHeight: 180, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6, padding: "8px 10px", border: "1px solid var(--border-hairline)", borderRadius: "var(--radius-sm)" }}>
        {shown.map((c) => (
          <Checkbox key={c.id} label={c.name} checked={chosen.has(c.id)} onChange={(on) => toggle(c.id, on)} />
        ))}
        {shown.length === 0 && <span style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>0 capabilities match.</span>}
      </div>
    </div>
  );
}

const CAPS_HEADER = {
  fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "var(--tracking-caps)",
  textTransform: "uppercase", color: "var(--text-secondary)",
};
const MONO_ROW = { fontFamily: "var(--font-mono)", fontSize: 11 };
const ELLIPSIS = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };

function ReadyFrontierPanel({ ready, selectedId, onSelect }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={CAPS_HEADER}>Ready now · {ready.length}</div>
      {ready.length === 0 ? (
        <div style={{ ...MONO_ROW, color: "var(--text-secondary)" }}>
          Nothing ready — pending work is blocked or already done.
        </div>
      ) : (
        ready.map((f) => {
          const active = f.id === selectedId;
          return (
            <button
              key={f.id}
              type="button"
              onClick={() => onSelect(f.id)}
              style={{
                display: "flex", alignItems: "center", gap: 6, textAlign: "left",
                padding: "4px 6px", margin: "0 -6px", border: "none", borderRadius: "var(--radius-sm)",
                cursor: "pointer", background: active ? "var(--accent-wash)" : "transparent",
                color: active ? "var(--text-heading)" : "var(--text-body)", ...MONO_ROW,
              }}
            >
              <span style={{ flex: 1, ...ELLIPSIS }}>{f.name}</span>
              {f.priority != null && <PriorityBadge priority={f.priority} />}
            </button>
          );
        })
      )}
    </div>
  );
}

function GraphDiagnosticsPanel({ cycles, topoOrder, topoError, selectedId, onSelect }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={CAPS_HEADER}>Cycles · {cycles.length}</div>
      {cycles.length === 0 ? (
        <div style={{ ...MONO_ROW, color: "var(--text-secondary)" }}>no dependency cycles</div>
      ) : (
        cycles.map((cycle, i) => (
          <div key={i} style={{ ...MONO_ROW, color: "var(--danger-fg)", ...ELLIPSIS }}>
            {cycle.map((f) => f.name).join(" → ")}
          </div>
        ))
      )}
      <div style={{ ...CAPS_HEADER, marginTop: 4 }}>Build order</div>
      {topoError ? (
        <div style={{ ...MONO_ROW, color: "var(--danger-fg)" }}>{topoError}</div>
      ) : topoOrder?.length === 0 ? (
        <div style={{ ...MONO_ROW, color: "var(--text-secondary)" }}>no features in graph</div>
      ) : (
        topoOrder?.slice(0, 12).map((f, i) => {
          const active = f.id === selectedId;
          return (
            <button
              key={f.id}
              type="button"
              onClick={() => onSelect(f.id)}
              style={{
                display: "flex", alignItems: "center", gap: 6, textAlign: "left",
                padding: "2px 6px", margin: "0 -6px", border: "none", borderRadius: "var(--radius-sm)",
                cursor: "pointer", background: active ? "var(--accent-wash)" : "transparent",
                color: active ? "var(--text-heading)" : "var(--text-secondary)", ...MONO_ROW,
              }}
            >
              <span style={{ color: "var(--text-secondary)", flex: "none", width: 16 }}>{i + 1}.</span>
              <span style={{ flex: 1, ...ELLIPSIS }}>{f.name}</span>
            </button>
          );
        })
      )}
      {topoOrder && topoOrder.length > 12 && (
        <div style={{ ...MONO_ROW, color: "var(--text-secondary)" }}>+{topoOrder.length - 12} more</div>
      )}
    </div>
  );
}

function WhyChainPanel({ chain, ownRoots, goalParent }) {
  if (!chain) return null;
  const goals = chain.filter((s) => s.kind === "goal");
  const caps = chain.filter((s) => s.kind === "capability");
  // A goal is this feature's own when it sits under the same org goal as the
  // feature's product. Everything else arrived through a shared capability:
  // that is reuse, not motivation.
  const rootOf = (id) => {
    let cur = id;
    for (let i = 0; i < 20 && goalParent.get(cur); i++) cur = goalParent.get(cur);
    return cur;
  };
  const classify = ownRoots.size > 0;
  const own = classify ? goals.filter((g) => ownRoots.has(rootOf(g.id))) : goals;
  const shared = classify ? goals.filter((g) => !ownRoots.has(rootOf(g.id))) : [];
  const steps = chain.filter((s) => s.kind !== "goal");
  const goalRow = (step, i) => (
    <a key={`goal-${step.id}-${i}`} href="/goals" style={{ textDecoration: "none", color: "inherit" }} title="Open goals">
      <span style={{ ...MONO_ROW, color: "var(--text-body)", ...ELLIPSIS, display: "block" }}>
        {step.display_id ? `${step.display_id} ${step.name}` : step.name}
      </span>
    </a>
  );
  return (
    <div style={{ borderTop: "1px solid var(--border-hairline)", paddingTop: 12, display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={CAPS_HEADER}>Why</div>
      {steps.map((step, i) => {
        const prefix = step.relation === "REALIZES" ? "realizes → " : step.relation === "PART_OF" ? "part of → " : "";
        const row = (
          <span style={{ ...MONO_ROW, color: step.kind === "feature" ? "var(--text-heading)" : "var(--text-body)", ...ELLIPSIS, display: "block" }}>
            {prefix}{step.name}
          </span>
        );
        return (
          <div key={`${step.kind}-${step.id}-${i}`}>
            {step.kind === "capability" ? (
              <a href="/capabilities" style={{ textDecoration: "none", color: "inherit" }} title="Open capabilities">{row}</a>
            ) : row}
          </div>
        );
      })}
      {caps.length === 0 && (
        <div style={{ ...MONO_ROW, color: "var(--text-secondary)" }}>no capability linked</div>
      )}
      {caps.length > 0 && (
        <>
          <div style={{ ...CAPS_HEADER, marginTop: 6 }}>Motivated by</div>
          {own.length > 0 ? own.map(goalRow) : (
            <div style={{ ...MONO_ROW, color: "var(--text-secondary)" }}>no goal of this product yet</div>
          )}
        </>
      )}
      {shared.length > 0 && (
        <details>
          <summary style={{ ...MONO_ROW, color: "var(--text-secondary)", cursor: "pointer" }}>
            Capability also serves {shared.length} goal{shared.length === 1 ? "" : "s"} of other products
          </summary>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 6 }}>{shared.map(goalRow)}</div>
        </details>
      )}
    </div>
  );
}

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
              <span style={{ color: c.essential ? "var(--ok-fg)" : "var(--text-secondary)", flex: "none" }}>
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
            <div style={{ ...MONO_ROW, color: "var(--text-secondary)" }}>+{cut.deferrable.length - 8} more</div>
          )}
          {cut.deferrable.length === 0 && (
            <div style={{ ...MONO_ROW, color: "var(--text-secondary)" }}>nothing deferrable — targets need the whole graph</div>
          )}
        </div>
      )}
    </div>
  );
}
