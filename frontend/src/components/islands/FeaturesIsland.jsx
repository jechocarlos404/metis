import React from "react";
import { PageHeader } from "../shell/PageHeader.jsx";
import { Button, Checkbox, Dialog, Icon, IconButton, Input, PriorityBadge, Select, StatusBadge, Tabs, Tag, DeleteConfirm } from "../../ds";
import { EDGE, LAYER, PRIORITY_HINT, count, plain, priorityLabel, productOptions, statusLabel } from "../../lib/words.js";
import { Term } from "../shared/Term.jsx";
import { CapabilityPicker } from "../shared/CapabilityPicker.jsx";
import { api, ApiError } from "../../lib/api.js";
import { FeatureGraphView } from "../graph/FeatureGraphView.jsx";
import { pressable } from "../../lib/pressable.js";
import { useParamRestore, writeParams } from "../../lib/url-state.js";

const TABS = new Set(["directory", "graph", "plan"]);
const EDGE_KINDS = ["DEPENDS_ON", "BLOCKS", "RELATES_TO"];
// The same edges read from the other end: X DEPENDS_ON this → "needed by X".
const EDGE_INCOMING = { DEPENDS_ON: "needed by", BLOCKS: "blocked by", RELATES_TO: "related to" };

export default function FeaturesIsland({ canWrite = true }) {
  const [tab, setTab] = React.useState("directory");
  const [loaded, setLoaded] = React.useState(false);
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

  // ?feature=<id>&tab=graph|plan&product=<id>: linkable, and Back restores the previous view.
  useParamRestore("feature", (v) => v && setSelected(v));
  useParamRestore("tab", (v) => setTab(TABS.has(v) ? v : "directory"));
  useParamRestore("product", (v) => setProductFilter(v ?? ""));
  const selectFeature = React.useCallback((id) => {
    setSelected(id);
    writeParams({ feature: id }, { push: true });
  }, []);
  const changeTab = (t) => { setTab(t); writeParams({ tab: t === "directory" ? "" : t }, { push: true }); };
  const changeProduct = (v) => { setProductFilter(v); writeParams({ product: v }, { push: true }); };
  const [draft, setDraft] = React.useState(EMPTY_DRAFT);
  const [edgeDraft, setEdgeDraft] = React.useState({ kind: "DEPENDS_ON", targetId: "" });
  const [saving, setSaving] = React.useState(false);
  const [confirmingDelete, setConfirmingDelete] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [cutTarget, setCutTarget] = React.useState("");
  const [cut, setCut] = React.useState(null);
  const [cutError, setCutError] = React.useState(null);
  const [cutting, setCutting] = React.useState(false);
  const [showCut, setShowCut] = React.useState(false);
  const [ready, setReady] = React.useState([]);
  const [why, setWhy] = React.useState(null);
  const [cycles, setCycles] = React.useState([]);
  const [topoOrder, setTopoOrder] = React.useState(null);
  const [topoError, setTopoError] = React.useState(null); // null | "cycle" | "failed"

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
    setLoaded(true);
    try {
      const topoData = await api("/graph/topo");
      setTopoOrder(topoData.order ?? []);
      setTopoError(null);
    } catch (e) {
      setTopoOrder(null);
      setTopoError(e instanceof ApiError && e.status === 409 ? "cycle" : "failed");
    }
    setSelected((sel) => sel && data.nodes.some((n) => n.id === sel) ? sel : data.nodes[0]?.id ?? null);
  }, []);

  const capabilityById = React.useMemo(
    () => new Map(capabilities.map((c) => [c.id, c])),
    [capabilities]
  );
  const capabilityByName = React.useMemo(
    () => new Map(capabilities.map((c) => [c.name.toLowerCase(), c])),
    [capabilities]
  );
  const capabilityOptions = React.useMemo(
    () => capabilities.map((c) => ({ id: c.id, name: c.name, slug: c.slug })),
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
  // plan (fading them was invisible at real scale, so the filter looked broken).
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
  // A cycle anywhere stops the build order, so show every cycle when it does.
  const visibleCycles = productFilter && topoError !== "cycle" ? cycles.filter((c) => c.some((f) => matchesProduct(f.id))) : cycles;

  const runImpact = async () => {
    if (!selected) return;
    setError(null);
    try {
      setImpact(await api(`/graph/impact/${selected}`));
    } catch {
      setError("Could not work out what depends on this feature.");
    }
  };

  // A new target invalidates the previous cut: the overlay must never lie.
  const pickCutTarget = (id) => {
    setCutTarget(id);
    setCut(null);
    setCutError(null);
    setShowCut(false);
  };
  const clearCut = () => pickCutTarget("");
  const runCut = async () => {
    if (!cutTarget) return;
    setCutting(true);
    setCutError(null);
    try {
      setCut(await api("/graph/mvp-cut", { method: "POST", body: { features: [cutTarget], capabilities: [] } }));
    } catch (e) {
      setCut(null);
      setCutError(e instanceof ApiError && e.status === 409
        ? "What this feature needs loops back on itself. Break the circular dependency first."
        : "Could not work out the smallest version. Try again.");
    } finally {
      setCutting(false);
    }
  };

  const cutStates = React.useMemo(() => {
    if (!cut || !showCut) return null;
    const states = new Map();
    for (const f of cut.essential) states.set(f.id, f.is_target ? "target" : "essential");
    for (const f of cut.deferrable) states.set(f.id, "deferrable");
    return states;
  }, [cut, showCut]);

  const openNew = () => {
    // Start blank: openEdit leaves the last feature in the draft. Keep only the product, as a create does.
    setDraft((d) => ({ ...EMPTY_DRAFT, productId: d.productId }));
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
    setConfirmingDelete(false);
    setError(null);
    setDialog({ mode: "edit" });
  };

  // The shared picker speaks names; the API takes ids. Names are not unique
  // (only slugs are), so keep the ids already linked and look up only new names.
  const draftCapabilityNames = draft.capabilityIds.map((id) => capabilityById.get(id)?.name).filter(Boolean);
  const setDraftCapabilityNames = (names) => setDraft((d) => {
    const wanted = new Set(names.map((n) => n.toLowerCase()));
    const kept = d.capabilityIds.filter((id) => wanted.has(capabilityById.get(id)?.name.toLowerCase()));
    const keptNames = new Set(kept.map((id) => capabilityById.get(id).name.toLowerCase()));
    const added = names.filter((n) => !keptNames.has(n.toLowerCase()))
      .map((n) => capabilityByName.get(n.toLowerCase())?.id).filter(Boolean);
    return { ...d, capabilityIds: [...kept, ...added] };
  });

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
      setError(e instanceof ApiError && e.status === 422 && String(e.message).includes("cycle")
        ? "That would make a circular dependency, so it was not added."
        : String(e.message));
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

  const noFeatures = loaded && layout.nodes.length === 0;
  const filteredProduct = productById.get(productFilter);
  const cutTargetOptions = visibleLayout.nodes.filter((n) => !n.external);

  return (
    <>
      <PageHeader
        title="Features"
        meta={`${count(visibleLayout.nodes.length, "feature")} · ${visibleReady.length} ready to start${productFilter ? ` · filtered from ${layout.nodes.length}` : ""}`}
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
              onChange={(e) => {
                setQuery(e.target.value);
                if (e.target.value.trim() && tab !== "directory") { setTab("directory"); writeParams({ tab: "" }); }
              }} />
            {canWrite && (
              <Button size="sm" variant="accent" style={{ gap: 6 }} onClick={openNew}>
                <Icon name="plus" size={13} />New feature
              </Button>
            )}
          </>
        }
      />
      <div style={{ padding: "12px 24px 0", flex: "none" }}>
        <Tabs tabs={[{ value: "directory", label: "Directory", count: directory.length }, { value: "graph", label: "Graph" }, { value: "plan", label: "Plan" }]} value={tab} onChange={changeTab} />
      </div>
      {error && !dialog && <div role="alert" style={{ padding: "8px 24px", fontSize: "var(--text-sm)", color: "var(--danger-fg)" }}>{error}</div>}

      {noFeatures ? (
        <div style={{ margin: 20, padding: 24, background: "var(--surface-card)", border: "1px solid var(--border-hairline)", borderRadius: "var(--radius-md)", display: "flex", flexDirection: "column", gap: 10, alignItems: "flex-start" }}>
          <div style={{ fontSize: "var(--text-sm)", color: "var(--text-body)" }}>
            No features yet. Features come in with each product's seed file{canWrite ? "." : ", which an editor loads."}
          </div>
          {canWrite && <a href="/settings" style={{ fontSize: "var(--text-sm)", color: "var(--text-accent)", textDecoration: "none" }}>Get started</a>}
        </div>
      ) : (
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        {tab === "graph" ? (
          <div style={{ flex: 1, position: "relative", margin: 20, background: "var(--surface-card)", border: "1px solid var(--border-hairline)", borderRadius: "var(--radius-md)", overflow: "hidden", minWidth: 0 }}>
            <FeatureGraphView layout={visibleLayout} fitKey={productFilter} selectedId={selected} onSelect={selectFeature} impactIds={impactIds} cutStates={cutStates} />
            {cutStates && (
              <div style={{ position: "absolute", bottom: 10, right: 10, display: "flex", alignItems: "center", gap: 8, padding: "6px 8px 6px 12px", background: "var(--surface-card)", border: "1px solid var(--border-hairline)", borderRadius: "var(--radius-sm)", boxShadow: "var(--shadow-card)", fontSize: "var(--text-xs)", color: "var(--text-body)" }}>
                Smallest version that reaches {nodeById.get(cutTarget)?.name ?? "the target"}
                <Button size="sm" variant="ghost" onClick={() => setShowCut(false)}>Hide</Button>
              </div>
            )}
          </div>
        ) : tab === "plan" ? (
          <PlanView
            hasFeatures={visibleLayout.nodes.length > 0}
            externalProduct={filteredProduct?.external ? filteredProduct.name : null}
            ready={visibleReady}
            cycles={visibleCycles}
            topoOrder={visibleTopo}
            topoError={topoError}
            selectedId={selected}
            onSelect={selectFeature}
            canCut
            cutTargetOptions={cutTargetOptions}
            cutTarget={cutTarget}
            onPickCutTarget={pickCutTarget}
            onRunCut={runCut}
            onClearCut={clearCut}
            onShowCut={() => { setShowCut(true); changeTab("graph"); }}
            cut={cut}
            cutError={cutError}
            cutting={cutting}
            matchesProduct={matchesProduct}
            productFilter={productFilter}
          />
        ) : (
        <div style={{ flex: 1, minWidth: 0, overflowY: "auto", padding: 20 }}>
          <div style={{ background: "var(--surface-card)", border: "1px solid var(--border-hairline)", borderRadius: "var(--radius-md)", overflow: "hidden" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 160px 110px 110px 120px", padding: "8px 16px", borderBottom: "1px solid var(--border-hairline)", fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "var(--tracking-caps)", textTransform: "uppercase", color: "var(--text-secondary)" }}>
              <span>Feature</span><span>What it does</span><span>Product</span><span>Priority</span><span>Status</span>
            </div>
            {directory.map((n, i) => (
              <div key={n.id} {...pressable(() => selectFeature(n.id))} aria-pressed={selected === n.id} style={{ display: "grid", gridTemplateColumns: "1fr 160px 110px 110px 120px", alignItems: "center", padding: "10px 16px", borderBottom: i < directory.length - 1 ? "1px solid var(--border-hairline)" : "none", cursor: "pointer", fontSize: "var(--text-sm)", background: selected === n.id ? "var(--surface-hover)" : undefined }}>
                <span style={{ color: "var(--text-heading)", fontWeight: "var(--weight-medium)" }}>{n.name}</span>
                <span title={(n.capability_ids ?? []).map((c) => capabilityById.get(c)?.name).join(", ")} style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)", ...ELLIPSIS }}>{capabilityNames(n.capability_ids, capabilityById)}</span>
                <span style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)", ...ELLIPSIS }}>{(nodeById.get(n.id)?.product_ids ?? []).map((pid) => productById.get(pid)?.name ?? "").filter(Boolean).join(", ") || "none"}</span>
                <span>{n.priority != null ? <PriorityBadge priority={n.priority} /> : <span style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>none</span>}</span>
                <span><StatusBadge status={n.status} /></span>
              </div>
            ))}
            {loaded && directory.length === 0 && (
              <div style={{ padding: "16px", fontSize: "var(--text-sm)", color: "var(--text-secondary)" }}>
                {query.trim() ? `No feature matches "${query.trim()}".`
                  : productFilter === "unattributed" ? "Every feature has a product."
                  : "This product has no features yet."}
              </div>
            )}
          </div>
        </div>
        )}
          <aside style={{ width: 300, flex: "none", margin: "20px 20px 20px 0", background: "var(--surface-card)", border: "1px solid var(--border-hairline)", borderRadius: "var(--radius-md)", padding: 16, display: "flex", flexDirection: "column", gap: 14, overflowY: "auto" }}>
            {detail ? (
              <FeaturePanel
                detail={detail}
                canWrite={canWrite}
                onEdit={openEdit}
                onSelect={selectFeature}
                productIds={nodeById.get(detail.id)?.product_ids ?? []}
                productById={productById}
                capabilityById={capabilityById}
                journeys={inJourneys}
                why={why}
                goalParent={goalParent}
                ownGoalRoots={ownGoalRoots}
                allNodes={layout.nodes}
                edgeDraft={edgeDraft}
                onEdgeDraft={setEdgeDraft}
                onAddEdge={addEdge}
                onRemoveEdge={removeEdge}
                impact={impact}
                onImpact={runImpact}
              />
            ) : (
              <div style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)" }}>{loaded ? "Select a feature to see what it does and why." : error ? "" : "Loading…"}</div>
            )}
          </aside>
      </div>
      )}

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
            options={[{ value: "", label: "No product" }, ...productOptions(products)]} />
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span aria-hidden="true" style={{ fontSize: "var(--text-xs)", fontWeight: "var(--weight-medium)", color: "var(--text-heading)" }}>What it does</span>
            <CapabilityPicker id="feature-capabilities" label="What it does" options={capabilityOptions} value={draftCapabilityNames}
              onChange={setDraftCapabilityNames} allowNew={false} placeholder="Type a capability…" />
            <Checkbox label="Some capabilities are unknown. Link only the ones you can name."
              checked={draft.unknownCapabilities} onChange={(on) => setDraft({ ...draft, unknownCapabilities: on })} />
          </div>
          <Select label={`Priority (${PRIORITY_HINT})`} value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: e.target.value })}
            options={[{ value: "", label: "No priority" }, ...[1, 2, 3, 4, 5].map((p) => ({ value: String(p), label: priorityLabel(p) }))]} />
          <Select label="Layer" value={draft.layer} onChange={(e) => setDraft({ ...draft, layer: e.target.value })}
            options={Object.keys(LAYER).map((v) => ({ value: v, label: plain(LAYER, v) }))} />
          {dialog?.mode === "edit" && (
            <Select label="Status" value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value })}
              options={["pending", "in_progress", "done"].map((s) => ({ value: s, label: statusLabel(s) }))} />
          )}
        </div>
      </Dialog>
    </>
  );
}

const EMPTY_DRAFT = { name: "", description: "", capabilityIds: [], unknownCapabilities: false, productId: "", layer: "service", priority: "3", status: "pending" };

function capabilityNames(ids, capabilityById) {
  const names = (ids ?? []).map((c) => capabilityById.get(c)?.name).filter(Boolean);
  return names.length ? names.join(", ") : "none";
}

const CAPS_HEADER = {
  fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "var(--tracking-caps)",
  textTransform: "uppercase", color: "var(--text-secondary)",
};
const MONO_ROW = { fontFamily: "var(--font-mono)", fontSize: 11 };
const ELLIPSIS = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const NOTE = { fontSize: "var(--text-xs)", color: "var(--text-secondary)", lineHeight: "var(--leading-snug)" };
const LINK = { fontSize: "var(--text-xs)", color: "var(--text-accent)", textDecoration: "none" };
const SECTION = { borderTop: "1px solid var(--border-hairline)", paddingTop: 12, display: "flex", flexDirection: "column", gap: 6 };

function Fact({ label, children }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "64px 1fr", gap: 8, alignItems: "baseline" }}>
      <span style={NOTE}>{label}</span>
      <span style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: "var(--text-xs)", color: "var(--text-body)", minWidth: 0 }}>{children}</span>
    </div>
  );
}

// A feature name that selects it, for lists and relationship rows.
function FeatureLink({ feature, onSelect, active, style }) {
  return (
    <button type="button" onClick={() => onSelect(feature.id)}
      style={{ border: "none", background: active ? "var(--accent-wash)" : "transparent", padding: 0, cursor: "pointer", textAlign: "left", font: "inherit", color: active ? "var(--text-heading)" : "var(--text-body)", minWidth: 0, ...ELLIPSIS, ...style }}>
      {feature.name}
    </button>
  );
}

function FeaturePanel({ detail, canWrite, onEdit, onSelect, productIds, productById, capabilityById, journeys, why, goalParent, ownGoalRoots, allNodes, edgeDraft, onEdgeDraft, onAddEdge, onRemoveEdge, impact, onImpact }) {
  const layer = detail.facets?.layer;
  return (
    <>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
          <div style={{ flex: 1, fontSize: "var(--text-md)", fontWeight: "var(--weight-semibold)", color: "var(--text-heading)" }}>{detail.name}</div>
          {canWrite && (
            <IconButton size="sm" label="Edit feature" onClick={onEdit}><Icon name="pencil" size={13} /></IconButton>
          )}
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <StatusBadge status={detail.status} />
          {detail.priority != null
            ? <PriorityBadge priority={detail.priority} rationale={detail.priority_rationale} />
            : <span style={NOTE}>{priorityLabel(null)}</span>}
          {detail.priority != null && <span style={NOTE}>{PRIORITY_HINT}</span>}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {detail.description && <div style={{ fontSize: "var(--text-xs)", color: "var(--text-body)", lineHeight: "var(--leading-snug)" }}>{detail.description}</div>}
        {layer && (
          <Fact label="Layer"><span><Tag type={layer}><Term dict={LAYER} value={layer} /></Tag></span></Fact>
        )}
        <Fact label="Product">
          {productIds.length > 0 ? productIds.map((pid) => (
            <a key={pid} href={`/products?product=${pid}`} style={LINK}>
              {productById.get(pid)?.name ?? "Unknown product"}{productById.get(pid)?.external ? " (external)" : ""}
            </a>
          )) : <span style={NOTE}>No product</span>}
        </Fact>
        {journeys.length > 0 && (
          <Fact label="Journeys">
            {journeys.map((j) => <a key={j.id} href={`/journeys?id=${j.id}`} style={LINK}>{j.name}</a>)}
          </Fact>
        )}
      </div>

      <div style={SECTION}>
        <div style={CAPS_HEADER}>What it does</div>
        {detail.capability_ids.map((cid) => {
          const c = capabilityById.get(cid);
          return c
            ? <a key={cid} href={`/capabilities/${c.slug}`} style={LINK}>{c.name}</a>
            : <span key={cid} style={NOTE}>Unknown capability</span>;
        })}
        {detail.unknown_capabilities && (
          <div style={NOTE}>{detail.capability_ids.length ? "Some of its capabilities are not named yet." : "Its capabilities are not named yet."}</div>
        )}
        {detail.capability_ids.length === 0 && !detail.unknown_capabilities && (
          <div style={NOTE}>No capability linked yet.</div>
        )}
      </div>

      <WhySection chain={why?.chain} goalParent={goalParent} ownRoots={ownGoalRoots} hasCapabilities={detail.capability_ids.length > 0} />

      <div style={SECTION}>
        <div style={CAPS_HEADER}>Relationships</div>
        {detail.outgoing.map((r, i) => (
          <EdgeRow key={`o${i}`} word={<Term dict={EDGE} value={r.kind} style={{ color: "var(--text-secondary)" }} />}
            feature={r.feature} onSelect={onSelect}
            onRemove={canWrite ? () => onRemoveEdge(detail.id, r.feature.id, r.kind) : null} />
        ))}
        {detail.incoming.map((r, i) => (
          <EdgeRow key={`i${i}`} word={<Term dict={EDGE_INCOMING} value={r.kind} style={{ color: "var(--text-secondary)" }} />}
            feature={r.feature} onSelect={onSelect}
            onRemove={canWrite ? () => onRemoveEdge(r.feature.id, detail.id, r.kind) : null} />
        ))}
        {detail.outgoing.length + detail.incoming.length === 0 && (
          <div style={NOTE}>No relationships yet.</div>
        )}
        {canWrite && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 4 }}>
            <Select label="This feature" value={edgeDraft.kind} onChange={(e) => onEdgeDraft({ ...edgeDraft, kind: e.target.value })}
              options={EDGE_KINDS.map((k) => ({ value: k, label: plain(EDGE, k) }))} />
            <Select value={edgeDraft.targetId} onChange={(e) => onEdgeDraft({ ...edgeDraft, targetId: e.target.value })}
              options={[{ value: "", label: "Pick a feature…" },
                ...allNodes.filter((n) => n.id !== detail.id).map((n) => ({ value: n.id, label: n.name }))]} />
            <Button size="sm" variant="secondary" disabled={!edgeDraft.targetId} onClick={onAddEdge} style={{ gap: 6 }}>
              <Icon name="plus" size={13} />Add relationship
            </Button>
          </div>
        )}
      </div>

      <div style={SECTION}>
        {impact ? (
          <>
            <div style={{ fontSize: "var(--text-xs)", color: "var(--text-body)" }}>
              {count(impact.dependents.length, "feature")} would be affected if this changes; it needs {impact.dependencies.length}.
            </div>
            {impact.dependents.map((d) => (
              <FeatureLink key={d.id} feature={d} onSelect={onSelect} style={{ fontSize: "var(--text-xs)" }} />
            ))}
          </>
        ) : (
          <Button size="sm" variant="ghost" style={{ gap: 6, alignSelf: "flex-start" }} onClick={onImpact}>
            <Icon name="git-branch" size={13} />What depends on this?
          </Button>
        )}
      </div>
    </>
  );
}

function EdgeRow({ word, feature, onSelect, onRemove }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "var(--text-xs)" }}>
      <span style={{ flex: "none" }}>{word}</span>
      <FeatureLink feature={feature} onSelect={onSelect} style={{ flex: 1 }} />
      {onRemove && (
        <IconButton size="sm" label={`Remove relationship with ${feature.name}`} onClick={onRemove}><Icon name="x" size={12} /></IconButton>
      )}
    </div>
  );
}

function WhySection({ chain, ownRoots, goalParent, hasCapabilities }) {
  if (!chain) return null;
  const goals = chain.filter((s) => s.kind === "goal");
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
  const goalRow = (step, i) => (
    <a key={`goal-${step.id}-${i}`} href={`/goals?goal=${step.id}`} style={{ ...LINK, ...ELLIPSIS, display: "block" }}>
      {step.display_id ? `${step.display_id} ${step.name}` : step.name}
    </a>
  );
  return (
    <div style={SECTION}>
      <div style={CAPS_HEADER}>Why</div>
      {!hasCapabilities ? (
        <div style={NOTE}>Goals show up here once it has a capability.</div>
      ) : own.length > 0 ? own.map(goalRow) : (
        <div style={NOTE}>No goal of this product yet.</div>
      )}
      {shared.length > 0 && (
        <details>
          <summary style={{ ...NOTE, cursor: "pointer" }}>
            Also serves {count(shared.length, "goal")} of other products
          </summary>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 6 }}>{shared.map(goalRow)}</div>
        </details>
      )}
    </div>
  );
}

const PLAN_CARD = {
  background: "var(--surface-card)", border: "1px solid var(--border-hairline)", borderRadius: "var(--radius-md)",
  padding: 16, display: "flex", flexDirection: "column", gap: 8, minWidth: 0,
};
const PLAN_TITLE = { fontSize: "var(--text-sm)", fontWeight: "var(--weight-semibold)", color: "var(--text-heading)" };
const SHOWN = 20;

function PlanList({ items, selectedId, onSelect, numbered, limit }) {
  const [all, setAll] = React.useState(false);
  const shown = limit && !all ? items.slice(0, limit) : items;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      {shown.map((f, i) => (
        <div key={f.id} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "var(--text-xs)" }}>
          {numbered && <span style={{ ...MONO_ROW, color: "var(--text-secondary)", flex: "none", width: 24, textAlign: "right" }}>{i + 1}.</span>}
          <FeatureLink feature={f} onSelect={onSelect} active={f.id === selectedId} style={{ flex: 1, padding: "2px 4px", borderRadius: "var(--radius-sm)" }} />
          {f.is_target && <span style={NOTE}>target</span>}
          {f.priority != null && <PriorityBadge priority={f.priority} />}
        </div>
      ))}
      {limit && items.length > limit && (
        <button type="button" onClick={() => setAll(!all)}
          style={{ ...NOTE, border: "none", background: "transparent", padding: "4px 0", cursor: "pointer", textAlign: "left", color: "var(--text-accent)" }}>
          {all ? "Show fewer" : `Show all ${items.length}`}
        </button>
      )}
    </div>
  );
}

function PlanView({ hasFeatures, externalProduct, ready, cycles, topoOrder, topoError, selectedId, onSelect, canCut, cutTargetOptions, cutTarget, onPickCutTarget, onRunCut, onClearCut, onShowCut, cut, cutError, cutting, matchesProduct, productFilter }) {
  const body = (content) => (
    <div style={{ flex: 1, minWidth: 0, overflowY: "auto", padding: 20 }}>{content}</div>
  );
  if (!hasFeatures) return body(<div style={{ ...PLAN_CARD, ...NOTE }}>{productFilter === "unattributed" ? "Every feature has a product, so there is nothing here to plan." : "This product has no features to plan yet."}</div>);
  if (externalProduct) return body(<div style={{ ...PLAN_CARD, ...NOTE }}>{externalProduct} is an external product, so none of its features are ours to plan.</div>);

  const canWait = cut ? (productFilter ? cut.deferrable.filter((f) => matchesProduct(f.id)) : cut.deferrable) : [];
  const neededCaps = cut ? cut.capabilities.filter((c) => c.essential) : [];
  return body(
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 16, alignItems: "start" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
        <section style={PLAN_CARD}>
          <div style={PLAN_TITLE}>Ready to start now · {ready.length}</div>
          {ready.length === 0
            ? <div style={NOTE}>No planned feature has everything it needs done yet.</div>
            : <PlanList items={ready} selectedId={selectedId} onSelect={onSelect} limit={SHOWN} />}
        </section>

        <section style={PLAN_CARD}>
          {cycles.length === 0 ? (
            <div style={NOTE}>No circular dependencies.</div>
          ) : (
            <>
              <div style={{ ...PLAN_TITLE, color: "var(--danger-fg)" }}>Circular dependencies · {cycles.length}</div>
              {cycles.map((cycle, i) => (
                <div key={i} style={{ fontSize: "var(--text-xs)", color: "var(--text-body)", lineHeight: "var(--leading-snug)" }}>
                  {[...cycle, cycle[0]].map((f, j) => (
                    <React.Fragment key={j}>
                      {j > 0 && <span style={{ color: "var(--text-secondary)" }}> needs </span>}
                      <FeatureLink feature={f} onSelect={onSelect} style={{ display: "inline", whiteSpace: "normal" }} />
                    </React.Fragment>
                  ))}
                </div>
              ))}
            </>
          )}
        </section>

        <section style={PLAN_CARD}>
          <div style={PLAN_TITLE}>Build order</div>
          {topoError === "cycle" ? (
            <div style={NOTE}>There is no build order while features need each other in a loop. Break the circular dependencies first.</div>
          ) : topoError ? (
            <div style={NOTE}>Could not load the build order. Reload the page to try again.</div>
          ) : topoOrder == null ? (
            <div style={NOTE}>Loading…</div>
          ) : topoOrder.length === 0 ? (
            <div style={NOTE}>None of these features are ours to build.</div>
          ) : (
            <>
              <div style={NOTE}>What a feature needs comes before it.</div>
              <PlanList items={topoOrder} selectedId={selectedId} onSelect={onSelect} numbered limit={50} />
            </>
          )}
        </section>
      </div>

      {canCut && (
        <section style={PLAN_CARD}>
          <div style={PLAN_TITLE}>Smallest version that reaches a feature</div>
          <div style={NOTE}>Pick a feature to see what it needs and what can wait.</div>
          <Select value={cutTarget} onChange={(e) => onPickCutTarget(e.target.value)}
            options={[{ value: "", label: "Pick a feature…" }, ...cutTargetOptions.map((n) => ({ value: n.id, label: n.name }))]} />
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <Button size="sm" variant="accent" disabled={!cutTarget || cutting} onClick={onRunCut}>
              {cutting ? "Working…" : "Run"}
            </Button>
            {cut && <Button size="sm" variant="secondary" onClick={onShowCut}>Show on graph</Button>}
            {(cutTarget || cut) && <Button size="sm" variant="ghost" onClick={onClearCut}>Clear</Button>}
          </div>
          {cutError && <div role="alert" style={{ fontSize: "var(--text-xs)", color: "var(--danger-fg)" }}>{cutError}</div>}
          {cut && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 4 }}>
              <div style={{ fontSize: "var(--text-xs)", color: "var(--text-body)" }}>
                {count(cut.essential.length, "feature")} needed · {canWait.length} can wait
              </div>
              <div style={CAPS_HEADER}>Needed, in build order</div>
              <PlanList items={cut.essential} selectedId={selectedId} onSelect={onSelect} numbered />
              {neededCaps.length > 0 && (
                <>
                  <div style={CAPS_HEADER}>Capabilities it uses</div>
                  {neededCaps.map((c) => (
                    <div key={c.id} style={{ display: "flex", alignItems: "baseline", gap: 6, fontSize: "var(--text-xs)" }}>
                      <span style={{ color: "var(--text-body)", flex: 1, ...ELLIPSIS }}>{c.name}</span>
                      <span style={{ ...NOTE, flex: "none" }}>{c.required} of {count(c.total, "feature")} needed</span>
                    </div>
                  ))}
                </>
              )}
              <div style={CAPS_HEADER}>Can wait</div>
              {canWait.length === 0
                ? <div style={NOTE}>{productFilter ? "Nothing else in this product can wait." : "Nothing can wait: it needs every other feature."}</div>
                : <PlanList items={canWait} selectedId={selectedId} onSelect={onSelect} limit={SHOWN} />}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
