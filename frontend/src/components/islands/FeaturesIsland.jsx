import React from "react";
import { PageHeader } from "../shell/PageHeader.jsx";
import { Button, Checkbox, Dialog, Icon, IconButton, Input, PriorityBadge, Select, StatusBadge, Tabs, Tag, DeleteConfirm } from "../../ds";
import { EDGE, EDGE_INCOMING, LAYER, PRIORITY_HINT, count, plain, priorityLabel, productOptions, statusLabel } from "../../lib/words.js";
import { Term } from "../shared/Term.jsx";
import { CapabilityPicker } from "../shared/CapabilityPicker.jsx";
import { Guesses } from "../shared/Guesses.jsx";
import { api, ApiError } from "../../lib/api.js";
import { FeatureGraphView } from "../graph/FeatureGraphView.jsx";
import { capabilityHubs, goalHubs } from "../graph/graph-data.js";
import { pressable } from "../../lib/pressable.js";
import { useParamRestore, writeParams } from "../../lib/url-state.js";

const TABS = new Set(["directory", "graph", "plan"]);
const EDGE_KINDS = ["DEPENDS_ON", "BLOCKS", "RELATES_TO"];
const GROUPS = [
  { value: "order", label: "Build order" },
  { value: "capability", label: "Capability" },
  { value: "goal", label: "Goal" },
];

export default function FeaturesIsland({ canWrite = true }) {
  const [tab, setTab] = React.useState("directory");
  const [loaded, setLoaded] = React.useState(false);
  const [layout, setLayout] = React.useState({ nodes: [], edges: [] });
  const [selected, setSelected] = React.useState(null);
  const [panelOpen, setPanelOpen] = React.useState(false); // phones: the panel replaces the list until Back
  const [detail, setDetail] = React.useState(null);
  const [inJourneys, setInJourneys] = React.useState([]);
  const [recheck, setRecheck] = React.useState(null);
  const [query, setQuery] = React.useState("");
  const [results, setResults] = React.useState(null);
  const [dialog, setDialog] = React.useState(null); // null | {mode:"new"} | {mode:"edit"}
  const [capabilities, setCapabilities] = React.useState([]);
  const [edgeList, setEdgeList] = React.useState([]);
  const [products, setProducts] = React.useState([]);
  const [goals, setGoals] = React.useState(null); // null loading | false failed | rows
  const [motivations, setMotivations] = React.useState(null); // null loading | false failed | rows
  const [productFilter, setProductFilter] = React.useState(""); // "" | "unattributed" | product id
  const [group, setGroup] = React.useState("order"); // graph: order | capability | goal

  // ?feature=<id>&tab=graph|plan&product=<id>&group=capability|goal: linkable, and Back restores the previous view.
  useParamRestore("feature", (v) => { if (v) setSelected(v); setPanelOpen(Boolean(v)); });
  useParamRestore("tab", (v) => setTab(TABS.has(v) ? v : "directory"));
  useParamRestore("product", (v) => setProductFilter(v ?? ""));
  useParamRestore("group", (v) => setGroup(GROUPS.some((g) => g.value === v) ? v : "order"));
  const changeGroup = (g) => { setGroup(g); writeParams({ group: g === "order" ? "" : g }, { push: true }); };
  const selectFeature = React.useCallback((id) => {
    setSelected(id);
    setPanelOpen(true);
    writeParams({ feature: id }, { push: true });
  }, []);
  // Picked from the keyboard, a row hands focus to its details, so they are
  // one Tab away rather than after every row of the list.
  const panelRef = React.useRef(null);
  const focusPanelFor = React.useRef(null);
  React.useEffect(() => {
    if (!detail || focusPanelFor.current !== detail.id) return;
    focusPanelFor.current = null;
    panelRef.current?.focus();
  }, [detail]);
  // On a phone, changing the view closes the panel so the change shows.
  const changeTab = (t) => { setTab(t); setPanelOpen(false); writeParams({ tab: t === "directory" ? "" : t }, { push: true }); };
  const changeProduct = (v) => { setProductFilter(v); setPanelOpen(false); writeParams({ product: v }, { push: true }); };
  const [draft, setDraft] = React.useState(EMPTY_DRAFT);
  const [edgeDraft, setEdgeDraft] = React.useState({ kind: "DEPENDS_ON", targetId: "" });
  const [edgeError, setEdgeError] = React.useState(null); // shown under the relationship picker

  // Layout follows the width this page really has (the sidebar folds at
  // 960px), measured after mount: the island is server-rendered.
  const [widthEl, setWidthEl] = React.useState(null);
  const [pageWidth, setPageWidth] = React.useState(null);
  React.useEffect(() => {
    if (!widthEl) return;
    const observer = new ResizeObserver(() => setPageWidth(widthEl.offsetWidth));
    observer.observe(widthEl);
    return () => observer.disconnect();
  }, [widthEl]);
  const phone = pageWidth != null && pageWidth < 640;
  // The table needs about 760px beside the 300px panel; narrower, each row stacks.
  const compactRows = phone || (pageWidth != null && pageWidth - 360 < 760);
  // A narrow graph folds its key (FeatureGraphView); the group buttons sit
  // beside it, or at the foot of a phone's graph, where the top has no room.
  const narrowGraph = pageWidth != null && pageWidth - (phone ? 40 : 360) < 560;
  const [saving, setSaving] = React.useState(false);
  const [confirmingDelete, setConfirmingDelete] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [notice, setNotice] = React.useState(null); // what the last write did, said in place
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
    api("/goals").then(setGoals).catch(() => setGoals(false));
    api("/motivations").then(setMotivations).catch(() => setMotivations(false));
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
    setSelected((sel) => sel && data.nodes.some((n) => n.id === sel) ? sel : null);
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
    setRecheck(null);
    setEdgeError(null);
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

  // While a recheck shows, ring what breaks and what to retest, fade the rest.
  const recheckStates = React.useMemo(() => recheck && new Map([
    ...recheck.retest.map((f) => [f.id, "retest"]),
    ...recheck.breaks.map((f) => [f.id, "breaks"]),
  ]), [recheck]);

  const nodeById = React.useMemo(() => new Map(layout.nodes.map((n) => [n.id, n])), [layout]);
  const productById = React.useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  // The graph never draws every product at once: hundreds of cards are
  // unreadable and slow. With no product picked it shows the open feature's
  // product, else the first product. Derived, never written to the URL, so
  // Back is not trapped and an explicit pick always wins.
  const graphProduct = productFilter
    || (nodeById.has(selected) ? nodeById.get(selected).product_ids[0] ?? "unattributed" : productOptions(products)[0]?.value ?? "");
  const activeProduct = tab === "graph" ? graphProduct : productFilter;

  // A feature's product is its own (features.product_id); search results lack
  // it, so always read it off the layout node.
  const matchesProduct = React.useCallback((id) => {
    if (!activeProduct) return true;
    const ids = nodeById.get(id)?.product_ids ?? [];
    return activeProduct === "unattributed" ? ids.length === 0 : ids.includes(activeProduct);
  }, [activeProduct, nodeById]);

  const directory = (results ?? layout.nodes).filter((n) => matchesProduct(n.id));

  // The product filter removes other products' features from the graph and the
  // plan (fading them was invisible at real scale, so the filter looked broken).
  const visibleLayout = React.useMemo(() => {
    if (!activeProduct) return layout;
    const keep = new Set(layout.nodes.filter((n) => matchesProduct(n.id)).map((n) => n.id));
    return {
      ...layout,
      nodes: layout.nodes.filter((n) => keep.has(n.id)),
      edges: layout.edges.filter((e) => keep.has(e.src) && keep.has(e.dst)),
    };
  }, [activeProduct, layout, matchesProduct]);
  // Group by capability or goal: hubs for the graph's one product. Goals use
  // the same rule as the panel's Why: a goal is the product's own when the
  // goals API says it belongs to it (product_id).
  const hubs = React.useMemo(() => {
    if (tab !== "graph" || group === "order") return null;
    if (group === "capability") return capabilityHubs(visibleLayout.nodes, capabilityById);
    if (!goals || !motivations) return null;
    return goalHubs(visibleLayout.nodes, motivations, goals, productById.has(activeProduct) ? activeProduct : null);
  }, [tab, group, visibleLayout, capabilityById, goals, motivations, productById, activeProduct]);
  const visibleReady = activeProduct ? ready.filter((f) => matchesProduct(f.id)) : ready;
  // Planning is on demand: ready to start, build order and the smallest
  // version say nothing true until one of our features is planned. The header
  // judges the features on screen; the Plan tab judges its own product filter.
  const hasPlanned = (nodes) => nodes.some((n) => n.status === "pending" && !n.external);
  const plannedShown = hasPlanned(visibleLayout.nodes);
  const canPlan = productFilter ? plannedShown : hasPlanned(layout.nodes);
  const shownTab = tab === "plan" && !canPlan ? "directory" : tab;
  // Build order answers "what to build next", so finished work stays out; the
  // note under it says how much was left out.
  const shownTopo = activeProduct && topoOrder ? topoOrder.filter((f) => matchesProduct(f.id)) : topoOrder;
  const visibleTopo = shownTopo && shownTopo.filter((f) => f.status !== "done");
  const topoDone = shownTopo ? shownTopo.length - visibleTopo.length : 0;
  // A cycle anywhere stops the build order, so show every cycle when it does.
  const visibleCycles = activeProduct && topoError !== "cycle" ? cycles.filter((c) => c.some((f) => matchesProduct(f.id))) : cycles;

  // The panel only shows a feature the current product filter and search
  // show too. Nothing picked yet: open the first one in view.
  const inView = (id) => shownTab === "directory" ? directory.some((n) => n.id === id) : matchesProduct(id);
  const firstInView = (shownTab === "directory" ? directory : visibleLayout.nodes)[0]?.id;
  const panelShown = phone && panelOpen && Boolean(selected) && inView(selected);
  React.useEffect(() => {
    if (loaded && !selected && firstInView) setSelected(firstInView);
  }, [loaded, selected, firstInView]);

  const runRecheck = async () => {
    if (!selected) return;
    setError(null);
    try {
      setRecheck(await api(`/graph/recheck/${selected}`));
    } catch {
      setError("Could not work out what to recheck for this feature.");
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
    // Start blank: openEdit leaves the last feature in the draft. The product
    // is the one on screen; with every product shown, the last one used.
    const onScreen = productById.has(activeProduct) ? activeProduct : "";
    setDraft((d) => ({ ...EMPTY_DRAFT, productId: activeProduct ? onScreen : d.productId }));
    setConfirmingDelete(false);
    setError(null);
    setNotice(null);
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
    setNotice(null);
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
        const product = productById.get(created.product_id);
        setNotice(`Created ${created.name}${product ? ` in ${product.name}` : ""}.`);
      } else {
        // Said in place afterwards, as capabilities and goals do.
        const was = new Set(detail.capability_ids);
        const changes = [
          body.name !== detail.name && `renamed from ${detail.name}`,
          draft.status !== detail.status && `status now ${statusLabel(draft.status)}`,
          body.priority !== (detail.priority ?? null) && `priority now ${priorityLabel(body.priority)}`,
          body.product_id !== (detail.product_id ?? null) && `product now ${productById.get(body.product_id)?.name ?? "none"}`,
          (body.capability_ids.length !== was.size || body.capability_ids.some((id) => !was.has(id))) && "capabilities updated",
          body.unknown_capabilities !== detail.unknown_capabilities && "capabilities updated",
          draft.layer !== (detail.facets?.layer ?? "service") && `layer now ${plain(LAYER, draft.layer)}`,
          body.description !== (detail.description ?? null) && "description updated",
        ].filter(Boolean);
        await api(`/features/${detail.id}`, {
          method: "PATCH",
          body: { ...body, facets: { ...detail.facets, layer: draft.layer }, status: draft.status },
        });
        await load();
        await refreshDetail(detail.id);
        setNotice(changes.length ? `Saved ${body.name}: ${[...new Set(changes)].join(", ")}.` : `Saved ${body.name}. Nothing changed.`);
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
    const name = detail.name; // detail clears with the selection
    try {
      await api(`/features/${detail.id}`, { method: "DELETE" });
      setDialog(null);
      setSelected(null);
      setPanelOpen(false);
      await load();
      setNotice(`Deleted ${name}.`);
    } catch (e) {
      setError(String(e.message));
      setConfirmingDelete(false);
    } finally {
      setSaving(false);
    }
  };

  const addEdge = async () => {
    if (!selected || !edgeDraft.targetId) return;
    setEdgeError(null);
    try {
      await api("/features/edges", {
        method: "POST",
        body: { src_id: selected, dst_id: edgeDraft.targetId, kind: edgeDraft.kind },
      });
      setEdgeDraft((d) => ({ ...d, targetId: "" }));
      await load();
      await refreshDetail(selected);
    } catch (e) {
      // A refused loop says, in plain words, which chain it would close.
      setEdgeError(String(e.message));
    }
  };

  const removeEdge = async (srcId, dstId, kind) => {
    const edge = edgeList.find((e) => e.src_id === srcId && e.dst_id === dstId && e.kind === kind);
    if (!edge) return;
    setEdgeError(null);
    try {
      await api(`/features/edges/${edge.id}`, { method: "DELETE" });
      await load();
      await refreshDetail(selected);
    } catch (e) {
      setEdgeError(String(e.message));
    }
  };

  const noFeatures = loaded && layout.nodes.length === 0;
  // Search narrows the directory only; the header says by how much.
  const searching = results != null && shownTab === "directory";
  const cutTargetOptions = visibleLayout.nodes.filter((n) => !n.external);

  // Beside the title on wider screens, a row of their own on a phone.
  const filters = (
    <>
      {products.length > 0 && (
        <Select aria-label="Product" value={activeProduct} onChange={(e) => changeProduct(e.target.value)} style={phone ? { flex: 1, minWidth: 0 } : { width: 200, minWidth: 160 }}
          options={[tab === "graph" ? { value: "", label: "All products: the graph draws one at a time", disabled: true } : { value: "", label: "All products" },
            ...productOptions(products),
            { value: "unattributed", label: "No product" }]} />
      )}
      <Input aria-label="Find features" placeholder="Find features like…" style={phone ? { flex: 1, minWidth: 0 } : { width: 220 }} inputStyle={{ height: 30 }}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setPanelOpen(false);
          if (e.target.value.trim() && tab !== "directory") { setTab("directory"); writeParams({ tab: "" }); }
        }} />
    </>
  );

  return (
    <>
      <PageHeader
        title="Features"
        meta={`${searching ? `${directory.length} of ` : ""}${count(visibleLayout.nodes.length, "feature")}${searching ? " match" : ""}${plannedShown ? ` · ${visibleReady.length} ready to start` : ""}${shownTab === "graph" && !productFilter ? ` · ${productById.get(graphProduct)?.name ?? "No product"} only: the graph draws one product at a time` : activeProduct ? ` · filtered from ${layout.nodes.length}` : ""}`}
        actions={
          <>
            {!phone && filters}
            {canWrite && (
              <Button size="sm" variant="accent" style={{ gap: 6 }} onClick={openNew}>
                <Icon name="plus" size={13} />New feature
              </Button>
            )}
          </>
        }
      />
      <div ref={setWidthEl} style={{ padding: phone ? "12px 16px 0" : "12px 24px 0", flex: "none" }}>
        {phone && <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>{filters}</div>}
        <Tabs tabs={[{ value: "directory", label: "Directory", count: directory.length }, { value: "graph", label: "Graph" }, ...(canPlan ? [{ value: "plan", label: "Plan" }] : [])]} value={shownTab} onChange={changeTab} />
      </div>
      {error && !dialog && <div role="alert" style={{ padding: "8px 24px", fontSize: "var(--text-sm)", color: "var(--danger-fg)" }}>{error}</div>}
      {notice && !error && <div role="status" style={{ padding: "8px 24px 0", fontSize: "var(--text-sm)", color: "var(--ok-fg)" }}>{notice}</div>}

      {noFeatures ? (
        <div style={{ margin: 20, padding: 24, background: "var(--surface-card)", border: "1px solid var(--border-hairline)", borderRadius: "var(--radius-md)", display: "flex", flexDirection: "column", gap: 10, alignItems: "flex-start" }}>
          <div style={{ fontSize: "var(--text-sm)", color: "var(--text-body)" }}>
            No features yet. Features come in with each product's seed file{canWrite ? "." : ", which an editor loads."}
          </div>
          {canWrite && <a href="/settings" style={{ fontSize: "var(--text-sm)", color: "var(--text-accent)", textDecoration: "none" }}>Get started</a>}
        </div>
      ) : (
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        {panelShown ? null : tab === "graph" ? (
          <div style={{ flex: 1, position: "relative", margin: 20, background: "var(--surface-card)", border: "1px solid var(--border-hairline)", borderRadius: "var(--radius-md)", overflow: "hidden", minWidth: 0 }}>
            {group !== "order" && !hubs ? (
              <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: "var(--text-sm)", color: "var(--text-secondary)" }}>
                {goals === false || motivations === false ? "Could not load the goals behind these features." : "Loading goals…"}
              </div>
            ) : (
              // A fresh graph per grouping and product: pins and hubs from another one would not fit this one.
              <FeatureGraphView key={`${group}:${activeProduct}`}layout={visibleLayout} hubs={hubs} fitKey={activeProduct} selectedId={selected} onSelect={selectFeature} recheckStates={cutStates ? null : recheckStates} fadedIds={!cutStates && recheckStates ? new Set(visibleLayout.nodes.filter((n) => n.id !== selected && !recheckStates.has(n.id)).map((n) => n.id)) : null} cutStates={cutStates} />
            )}
            <div role="group" aria-label="Group by" style={{ position: "absolute", ...(phone ? { bottom: 48, left: 10 } : narrowGraph ? { top: 10, left: 64 } : { top: 10, left: "50%", transform: "translateX(-50%)" }), display: "flex", alignItems: "center", gap: 8, fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", color: "var(--text-secondary)" }}>
              {!narrowGraph && "Group by"}
              <div style={{ display: "inline-flex", border: "1px solid var(--border-control)", borderRadius: "var(--radius-sm)", overflow: "hidden", boxShadow: "var(--shadow-card)" }}>
                {GROUPS.map((g, i) => (
                  <button key={g.value} type="button" aria-pressed={group === g.value} onClick={() => changeGroup(g.value)}
                    style={{ height: 26, padding: narrowGraph ? "0 7px" : "0 10px", whiteSpace: "nowrap", font: "inherit", fontFamily: "var(--font-body)", fontSize: "var(--text-xs)", cursor: "pointer", border: "none",
                      borderLeft: i ? "1px solid var(--border-control)" : "none",
                      background: group === g.value ? "var(--accent-wash)" : "var(--surface-card)",
                      color: group === g.value ? "var(--text-accent)" : "var(--text-body)" }}>
                    {g.label}
                  </button>
                ))}
              </div>
            </div>
            {cutStates && (
              <div style={{ position: "absolute", bottom: 10, right: 10, display: "flex", alignItems: "center", gap: 8, padding: "6px 8px 6px 12px", background: "var(--surface-card)", border: "1px solid var(--border-hairline)", borderRadius: "var(--radius-sm)", boxShadow: "var(--shadow-card)", fontSize: "var(--text-xs)", color: "var(--text-body)" }}>
                Smallest version that reaches {nodeById.get(cutTarget)?.name ?? "the target"}
                <Button size="sm" variant="ghost" onClick={() => setShowCut(false)}>Hide</Button>
              </div>
            )}
          </div>
        ) : shownTab === "plan" ? (
          <PlanView
            ready={visibleReady}
            cycles={visibleCycles}
            topoOrder={visibleTopo}
            topoDone={topoDone}
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
            {!compactRows && <div style={{ display: "grid", gridTemplateColumns: COLUMNS, columnGap: 12, padding: "8px 16px", borderBottom: "1px solid var(--border-hairline)", fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", letterSpacing: "var(--tracking-caps)", textTransform: "uppercase", color: "var(--text-secondary)" }}>
              <span>Feature</span><span>What it does</span><span>Product</span><span>Priority</span><span>Status</span>
            </div>}
            {directory.map((n, i) => {
              const capabilitiesTitle = (n.capability_ids ?? []).map((c) => capabilityById.get(c)?.name).join(", ");
              const productNames = (nodeById.get(n.id)?.product_ids ?? []).map((pid) => productById.get(pid)?.name ?? "").filter(Boolean).join(", ");
              return (
              <div key={n.id} {...pressable((e) => { selectFeature(n.id); if (e.type === "keydown") focusPanelFor.current = n.id; })} aria-pressed={selected === n.id} style={{ display: "grid", gridTemplateColumns: compactRows ? "minmax(0, 1fr) auto" : COLUMNS, columnGap: 12, alignItems: "center", padding: "10px 16px", borderBottom: i < directory.length - 1 ? "1px solid var(--border-hairline)" : "none", cursor: "pointer", fontSize: "var(--text-sm)",
                // Selected: inset surface (muted text 4.98:1, priority bars still show) and an accent edge.
                background: selected === n.id ? "var(--surface-inset)" : undefined, boxShadow: selected === n.id ? "inset 3px 0 0 var(--accent)" : undefined }}>
                {compactRows ? (
                  // Narrow: the name, then product and capabilities on one line; badges on the right.
                  <>
                    <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                      <span style={{ color: "var(--text-heading)", fontWeight: "var(--weight-medium)" }}>{n.name}</span>
                      <span title={capabilitiesTitle} style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)", ...ELLIPSIS }}>
                        {[productNames, capabilitiesTitle].filter(Boolean).join(" · ")}
                      </span>
                    </span>
                    <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
                      <StatusBadge status={n.status} />
                      {n.priority != null && <PriorityBadge priority={n.priority} />}
                    </span>
                  </>
                ) : (
                  <>
                    <span style={{ color: "var(--text-heading)", fontWeight: "var(--weight-medium)" }}>{n.name}</span>
                    <span title={capabilitiesTitle} style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)", ...ELLIPSIS }}>{capabilityNames(n.capability_ids, capabilityById)}</span>
                    <span style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)", ...ELLIPSIS }}>{productNames || "none"}</span>
                    <span>{n.priority != null ? <PriorityBadge priority={n.priority} /> : <span style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>none</span>}</span>
                    <span><StatusBadge status={n.status} /></span>
                  </>
                )}
              </div>
              );
            })}
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
          {(!phone || panelShown) && (
          <aside ref={panelRef} tabIndex={-1} aria-label="Feature details" style={{ ...(phone ? { flex: 1, minWidth: 0, margin: 16 } : { width: 300, flex: "none", margin: "20px 20px 20px 0" }), background: "var(--surface-card)", border: "1px solid var(--border-hairline)", borderRadius: "var(--radius-md)", padding: 16, display: "flex", flexDirection: "column", gap: 14, overflowY: "auto" }}>
            {phone && (
              <Button size="sm" variant="ghost" style={{ alignSelf: "flex-start", gap: 6 }} onClick={() => { setPanelOpen(false); writeParams({ feature: "" }, { push: true }); }}>
                <span style={{ display: "inline-flex", transform: "rotate(180deg)" }}><Icon name="chevron-right" size={13} /></span>Back
              </Button>
            )}
            {detail && inView(detail.id) ? (
              <FeaturePanel
                detail={detail}
                canWrite={canWrite}
                onEdit={openEdit}
                onGuessConfirmed={() => { refreshDetail(detail.id); load(); }}
                onSelect={selectFeature}
                productIds={nodeById.get(detail.id)?.product_ids ?? []}
                productById={productById}
                capabilityById={capabilityById}
                journeys={inJourneys}
                why={why}
                goals={goals}
                allNodes={layout.nodes}
                edgeDraft={edgeDraft}
                onEdgeDraft={(d) => { setEdgeDraft(d); setEdgeError(null); }}
                edgeError={edgeError}
                onAddEdge={addEdge}
                onRemoveEdge={removeEdge}
                recheck={recheck}
                onRecheck={runRecheck}
                onClearRecheck={() => setRecheck(null)}
              />
            ) : (
              <div style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)" }}>{loaded ? "Select a feature to see what it does and why." : error ? "" : "Loading…"}</div>
            )}
          </aside>
          )}
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

// The relationship picker, one group per product: this feature's own first,
// then the rest by name, "No product" last; features by name inside each.
function pickerGroups(nodes, selfId, ownProduct, productById) {
  const groups = new Map();
  for (const n of nodes) {
    if (n.id === selfId) continue;
    const pid = n.product_ids[0] ?? "";
    if (!groups.has(pid)) groups.set(pid, []);
    groups.get(pid).push(n);
  }
  const label = (pid) => {
    const p = productById.get(pid);
    const name = p ? `${p.name}${p.external ? " (external)" : ""}` : "No product";
    return pid === ownProduct && p ? `${name} (this product)` : name;
  };
  const rank = (pid) => (pid === ownProduct ? 0 : pid === "" ? 2 : 1);
  return [...groups]
    .map(([pid, ns]) => [pid, label(pid), ns.sort((a, b) => a.name.localeCompare(b.name))])
    .sort((a, b) => rank(a[0]) - rank(b[0]) || a[1].localeCompare(b[1]));
}

function capabilityNames(ids, capabilityById) {
  const names = (ids ?? []).map((c) => capabilityById.get(c)?.name).filter(Boolean);
  return names.length ? names.join(", ") : "none";
}

const CAPS_HEADER = {
  fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", letterSpacing: "var(--tracking-caps)",
  textTransform: "uppercase", color: "var(--text-secondary)",
};
const MONO_ROW = { fontFamily: "var(--font-mono)", fontSize: 11 };
// Feature, what it does, product, priority, status.
const COLUMNS = "minmax(0, 1fr) 160px 110px 110px 120px";
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

function FeaturePanel({ detail, canWrite, onEdit, onGuessConfirmed, onSelect, productIds, productById, capabilityById, journeys, why, goals, allNodes, edgeDraft, onEdgeDraft, edgeError, onAddEdge, onRemoveEdge, recheck, onRecheck, onClearRecheck }) {
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
        {canWrite && <Guesses query={{ feature_id: detail.id }} title="Guessed to be built on too" onConfirmed={onGuessConfirmed} />}
      </div>

      <WhySection chain={why?.chain} goals={goals} product={productById.get(productIds[0])} hasCapabilities={detail.capability_ids.length > 0} />

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
            <Select aria-label="Other feature" value={edgeDraft.targetId} onChange={(e) => onEdgeDraft({ ...edgeDraft, targetId: e.target.value })}>
              <option value="">Pick a feature…</option>
              {pickerGroups(allNodes, detail.id, productIds[0] ?? "", productById).map(([pid, label, nodes]) => (
                <optgroup key={pid} label={label}>
                  {nodes.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
                </optgroup>
              ))}
            </Select>
            <Button size="sm" variant="secondary" disabled={!edgeDraft.targetId} onClick={onAddEdge} style={{ gap: 6 }}>
              <Icon name="plus" size={13} />Add relationship
            </Button>
            {edgeError && <div role="alert" style={{ ...NOTE, color: "var(--danger-fg)" }}>{edgeError}</div>}
          </div>
        )}
      </div>

      <div style={SECTION}>
        {recheck ? (
          <RecheckList recheck={recheck} onSelect={onSelect} onClear={onClearRecheck} />
        ) : (
          <Button size="sm" variant="ghost" style={{ gap: 6, alignSelf: "flex-start" }} onClick={onRecheck}>
            <Icon name="git-branch" size={13} />If this changes, what to recheck?
          </Button>
        )}
      </div>
    </>
  );
}

const RECHECK_SHOWN = 8;
const SMALL_NOTE = { fontSize: "var(--text-xs)", color: "var(--text-secondary)" };

/** What else to look at when this feature changes (GET /graph/recheck). */
function RecheckList({ recheck, onSelect, onClear }) {
  const { breaks, retest, broad, elsewhere } = recheck;
  const via = (f) => f.via.length === 0 ? null
    : `through ${f.via[f.via.length - 1]}${f.via.length > 1 ? ` and ${count(f.via.length - 1, "more", "more")}` : ""}`;
  const row = (f, note, title) => (
    <div key={f.id} style={{ display: "flex", flexDirection: "column" }}>
      <FeatureLink feature={f} onSelect={onSelect} style={{ fontSize: "var(--text-xs)" }} />
      {note && <span title={title} style={SMALL_NOTE}>{note}</span>}
    </div>
  );
  const retestRow = (f) => row(f, `shares ${f.shared.map((c) => c.name).join(", ")}`);
  const nothing = !breaks.length && !retest.length && !broad.length && !elsewhere.length;
  return (
    <>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
        <div style={CAPS_HEADER}>If this changes</div>
        <button type="button" onClick={onClear} style={{ border: "none", background: "none", padding: 0, cursor: "pointer", font: "inherit", ...SMALL_NOTE }}>Clear</button>
      </div>
      {nothing && <div style={SMALL_NOTE}>Nothing depends on it and it shares no capability, so nothing else needs a recheck.</div>}
      {breaks.length > 0 && (
        <>
          <div style={{ fontSize: "var(--text-xs)", fontWeight: "var(--weight-medium)", color: "var(--danger-fg)" }}>Breaks: {count(breaks.length, "feature")} need it</div>
          {breaks.map((f) => row(f, via(f), f.via.join(" > ")))}
        </>
      )}
      {retest.length > 0 && (
        <>
          <div style={{ fontSize: "var(--text-xs)", fontWeight: "var(--weight-medium)", color: "var(--warn-fg)" }}>Retest: {count(retest.length, "feature")} built on the same capabilities</div>
          {retest.slice(0, RECHECK_SHOWN).map(retestRow)}
          {retest.length > RECHECK_SHOWN && (
            <details>
              <summary style={{ cursor: "pointer", ...SMALL_NOTE }}>{count(retest.length - RECHECK_SHOWN, "more", "more")}, sharing less</summary>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>{retest.slice(RECHECK_SHOWN).map(retestRow)}</div>
            </details>
          )}
        </>
      )}
      {broad.map((c) => (
        <div key={c.id} style={SMALL_NOTE}>
          Also built on {c.name}, used by {count(c.features - 1, "other feature")} here. Retest those only if the change touches it.
        </div>
      ))}
      {elsewhere.length > 0 && (
        <div style={SMALL_NOTE}>
          Same capabilities in other products (only matters if they share code): {elsewhere.map((p) => `${p.name} (${p.capabilities.join(", ")})`).join("; ")}.
        </div>
      )}
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

function WhySection({ chain, goals, product, hasCapabilities }) {
  // Whose each goal is comes from the goals API (product_id), which loads on
  // its own: say nothing about it until it has.
  if (!chain || !Array.isArray(goals)) return null;
  const steps = chain.filter((s) => s.kind === "goal");
  // A goal is this feature's own when it belongs to the feature's product.
  // Everything else arrived through a shared capability: reuse, not motivation.
  const owner = new Map(goals.map((g) => [g.id, g.product_id]));
  const own = product ? steps.filter((s) => owner.get(s.id) === product.id) : [];
  const shared = steps.filter((s) => !own.includes(s));
  const ownsGoals = product != null && goals.some((g) => g.product_id === product.id);
  const theirs = product?.external && !ownsGoals;
  const goal = ownsGoals ? goals.find((g) => g.id === product.goal_id) : null;
  const goalRow = (step, i) => (
    <a key={`goal-${step.id}-${i}`} href={`/goals?goal=${step.id}`} style={{ ...LINK, ...ELLIPSIS, display: "block" }}>
      {step.display_id ? `${step.display_id} ${step.name}` : step.name}
    </a>
  );
  return (
    <div style={SECTION}>
      <div style={CAPS_HEADER}>Why</div>
      {theirs ? (
        <div style={NOTE}>Someone else's product: metis doesn't record its goals.</div>
      ) : !hasCapabilities ? (
        <div style={NOTE}>Goals show up here once it has a capability.</div>
      ) : own.length > 0 ? own.map(goalRow) : goal ? (
        <div style={NOTE}>
          None of {product.name}'s goals links to this feature's capabilities. The product's goal is{" "}
          <a href={`/goals?goal=${goal.id}`} style={LINK}>{goal.display_id} {goal.title}</a>.
        </div>
      ) : (
        <div style={NOTE}>{product ? "No goal of this product yet." : "No product, so no goal of its own."}</div>
      )}
      {shared.length > 0 && !theirs && (
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

// Shown only while a feature of ours is planned (see canPlan).
function PlanView({ ready, cycles, topoOrder, topoDone, topoError, selectedId, onSelect, canCut, cutTargetOptions, cutTarget, onPickCutTarget, onRunCut, onClearCut, onShowCut, cut, cutError, cutting, matchesProduct, productFilter }) {
  const body = (content) => (
    <div style={{ flex: 1, minWidth: 0, overflowY: "auto", padding: 20 }}>{content}</div>
  );
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
            <div style={NOTE}>{topoDone > 0 ? `Nothing left to build: ${count(topoDone, "feature")}, all done.` : "None of these features are ours to build."}</div>
          ) : (
            <>
              <div style={NOTE}>
                What a feature needs comes before it.
                {topoDone > 0 && ` Unfinished work only: ${count(topoDone, "done feature")} left out.`}
              </div>
              <PlanList items={topoOrder} selectedId={selectedId} onSelect={onSelect} numbered limit={50} />
            </>
          )}
        </section>
      </div>

      {canCut && (
        <section style={PLAN_CARD}>
          <div style={PLAN_TITLE}>Smallest version that reaches a feature</div>
          <div style={NOTE}>Pick a feature to see what it needs and what can wait.</div>
          <Select aria-label="Feature to reach" value={cutTarget} onChange={(e) => onPickCutTarget(e.target.value)}
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
