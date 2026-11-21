import React from "react";
import { PageHeader } from "../shell/PageHeader.jsx";
import { Badge, Button, Card, Checkbox, Dialog, Icon, Input, Select, StatusBadge, Tabs, Toast, DeleteConfirm, tabId } from "../../ds";
import { api } from "../../lib/api.js";
import { andList, count, freshness, productOptions, statusLabel, takenCounts, takenRows, takenWords } from "../../lib/words.js";
import { useParamRestore, writeParams } from "../../lib/url-state.js";
import { exportSeedFile } from "../shared/SeedFiles.jsx";
import { WhatItDoes } from "../products/WhatItDoes.jsx";
import { ProductGoals } from "../products/ProductGoals.jsx";
import { ProductPlan, SIZE_HINT, hasPlan } from "../products/ProductPlan.jsx";
import { downloadSnapshot } from "../products/shareSnapshot.js";

const TABS = ["does", "goals", "plan"];
const SIZES = [
  { value: "S", label: "S: one file" },
  { value: "M", label: "M: 2 to 4 files" },
  { value: "L", label: "L: must be split" },
];
const TICKET_STATUSES = ["pending", "in_progress", "done"].map((s) => ({ value: s, label: statusLabel(s) }));

export default function ProductsIsland({ canWrite = true }) {
  const [products, setProducts] = React.useState(null); // null until loaded
  const [productId, setProductId] = React.useState(null);
  const [goals, setGoals] = React.useState([]);
  const [detailId, setDetailId] = React.useState(null); // the product the plan data below belongs to
  const [epics, setEpics] = React.useState([]);
  const [tickets, setTickets] = React.useState([]);
  const [decompositions, setDecompositions] = React.useState([]);
  const [strategies, setStrategies] = React.useState([]);
  const [capabilities, setCapabilities] = React.useState([]);
  const [bundles, setBundles] = React.useState([]);
  const [journeys, setJourneys] = React.useState(null);
  const [motivations, setMotivations] = React.useState(null); // goal -> capability links
  const [tab, setTab] = React.useState("does");
  const [features, setFeatures] = React.useState(null); // this product's features, from graph layout
  const [score, setScore] = React.useState(null);
  const [toast, setToast] = React.useState(null);
  const [ticketDialog, setTicketDialog] = React.useState(null); // null | {mode:'new'|'edit'|'view', ticket?}
  const [productDialog, setProductDialog] = React.useState(null); // null | {mode:'new'} | {mode:'edit'}
  const [confirmingDelete, setConfirmingDelete] = React.useState(false);
  const [takes, setTakes] = React.useState(undefined); // what a delete takes besides its features: undefined while read, null if unreadable
  const [confirmingTicketDelete, setConfirmingTicketDelete] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const currentId = React.useRef(null);

  const product = products?.find((p) => p.id === productId);
  // ?product=<id>&tab=<tab>: linkable from Goals and Inventory, and Back restores it.
  useParamRestore("product", (v) => v && setProductId(v));
  useParamRestore("tab", (v) => setTab(TABS.includes(v) ? v : "does"));
  const selectProduct = (id) => { setProductId(id); setTab("does"); writeParams({ product: id, tab: null }, { push: true }); };
  const changeTab = (t) => { setTab(t); writeParams({ tab: t === "does" ? null : t }, { push: true }); };
  const prd = decompositions[0];
  const strategy = strategies[0];
  // Planning is on demand, and only for products we build: the tab shows once
  // a plan exists, or to a writer while some of its features aren't done.
  // Until this product's plan and features load, nobody knows yet.
  const planKnown = detailId === productId && features != null;
  const showPlan = planKnown && product != null && !product.external && (
    hasPlan(product, { prd, epics, tickets, strategy }) || (canWrite && features.some((f) => f.status !== "done")));
  const shownTab = tab !== "plan" || showPlan ? tab : planKnown || product?.external ? "does" : "plan";

  const loadProducts = React.useCallback(async () => {
    const [list, goalList] = await Promise.all([api("/products"), api("/goals")]);
    setProducts(list);
    setGoals(goalList);
  }, []);

  // With nothing chosen, or a product that's gone (deleted, then Back), open
  // on the picker's first product.
  React.useEffect(() => {
    if (!products || products.some((p) => p.id === productId)) return;
    const first = productOptions(products)[0]?.value ?? null;
    setProductId(first);
    writeParams({ product: first }); // a reload must not ask for the one that's gone
  }, [products, productId]);

  const loadDetail = React.useCallback(async (id) => {
    if (!id) return;
    const [epicList, ticketList, prdList, strategyList, capabilityList, bundleList] = await Promise.all([
      api(`/products/${id}/epics`),
      api(`/products/${id}/tickets`),
      api(`/products/${id}/decompositions`),
      api(`/products/${id}/strategies`),
      api("/capabilities/inventory"),
      api(`/products/${id}/bundles`),
    ]);
    if (currentId.current !== id) return; // the person switched product meanwhile
    setEpics(epicList);
    setTickets(ticketList);
    setDecompositions(prdList);
    setStrategies(strategyList);
    setCapabilities(capabilityList);
    setBundles(bundleList);
    setDetailId(id);
    // Reloads of the same product swap data in place, without a loading flash.
    api("/graph/layout")
      .then((layout) => currentId.current === id && setFeatures(layout.nodes.filter((n) => (n.product_ids ?? []).includes(id))))
      .catch(() => currentId.current === id && setFeatures([]));
    api(`/products/${id}/coverage`)
      .then((s) => currentId.current === id && setScore(s))
      .catch(() => currentId.current === id && setScore(false));
  }, []);

  React.useEffect(() => {
    loadProducts().catch((e) => setToast({ tone: "danger", title: "Load failed", detail: String(e.message) }));
    api("/journeys").then(setJourneys).catch(() => setJourneys([]));
    api("/motivations").then(setMotivations).catch(() => setMotivations([]));
  }, [loadProducts]);

  React.useEffect(() => {
    currentId.current = productId;
    setFeatures(null); // don't show the previous product's features under this one's name
    setScore(null);
    // A product that's gone fails to load; by then the page has moved on, so stay quiet.
    loadDetail(productId).catch((e) => currentId.current === productId && setToast({ tone: "danger", title: "Load failed", detail: String(e.message) }));
  }, [productId, loadDetail]);

  const showError = (title) => (e) => setToast({ tone: "danger", title, detail: String(e.message) });

  const approveProduct = () =>
    api(`/products/${productId}/approve`, { method: "POST" })
      .then(() => { setToast({ tone: "ok", title: "Spec approved" }); return loadProducts(); })
      .catch(showError("Approve failed"));

  const approvePrd = () =>
    api(`/decompositions/${prd.id}/approve`, { method: "POST" })
      .then(() => { setToast({ tone: "ok", title: `${prd.display_id} approved` }); return loadDetail(productId); })
      .catch(showError("Plan document not ready"));

  const exportProduct = () =>
    exportSeedFile(productId)
      .then((filename) => setToast({ tone: "ok", title: "Seed file downloaded", detail: filename }))
      .catch(showError("Export failed"));

  const shareProduct = () => {
    const filename = downloadSnapshot({ product, goals, features, capabilities, score });
    setToast({ tone: "ok", title: "Snapshot downloaded", detail: filename });
  };

  const openNewProduct = () => {
    setConfirmingDelete(false);
    setProductDialog({ mode: "new", name: "", summary: "", goalId: "", external: false });
  };

  const openEditProduct = () => {
    setConfirmingDelete(false);
    setProductDialog({ mode: "edit", name: product.name, summary: product.summary ?? "", goalId: product.goal_id ?? "", external: product.external });
  };

  const saveProduct = async () => {
    const d = productDialog;
    if (!d?.name?.trim()) return;
    setSaving(true);
    try {
      const body = {
        name: d.name.trim(),
        summary: d.summary.trim() || null,
        // Goals say why our products exist; someone else's product has none here (A31).
        goal_id: d.external ? null : (d.goalId || null),
        external: d.external,
      };
      if (d.mode === "new") {
        const created = await api("/products", { method: "POST", body });
        await loadProducts();
        selectProduct(created.id);
        setToast({ tone: "ok", title: `Created ${created.name}` });
      } else {
        const goal = goals.find((g) => g.id === body.goal_id);
        const changes = [
          body.name !== product.name && `renamed from ${product.name}`,
          body.summary !== (product.summary ?? null) && "summary updated",
          body.goal_id !== (product.goal_id ?? null) && (goal ? `goal now ${goal.display_id} ${goal.title}` : "no goal now"),
          body.external !== product.external && (body.external ? "now someone else's product" : "now one of ours"),
        ].filter(Boolean);
        await api(`/products/${productId}`, { method: "PATCH", body });
        await loadProducts();
        setToast({ tone: "ok", title: `Saved ${body.name}`, detail: changes.length ? `${changes.join(", ")}.` : "Nothing changed." });
      }
      setProductDialog(null);
    } catch (e) {
      showError("Product save failed")(e);
    } finally {
      setSaving(false);
    }
  };

  // Read at arm, so the note names what this delete takes now (B47).
  const armDelete = () => {
    setConfirmingDelete(true);
    setTakes(undefined);
    api(`/products/${productId}/deletes`).then(setTakes).catch(() => setTakes(null));
  };

  const deleteProduct = async () => {
    setSaving(true);
    try {
      await api(`/products/${productId}`, { method: "DELETE" });
      setProductDialog(null);
      const gone = [features?.length && count(features.length, "feature"), ...takenCounts(takes)].filter(Boolean);
      setToast({ tone: "ok", title: `Deleted ${product.name}`, detail: gone.length ? `With its ${andList(gone)}.` : undefined });
      await loadProducts();
    } catch (e) {
      showError("Delete failed")(e);
      setConfirmingDelete(false);
    } finally {
      setSaving(false);
    }
  };

  const addBundle = async (capabilityId) => {
    setSaving(true);
    try {
      await api(`/products/${productId}/bundles`, {
        method: "POST",
        body: { capability_id: capabilityId },
      });
      await loadDetail(productId);
    } catch (e) {
      showError("Couldn't add the capability")(e);
    } finally {
      setSaving(false);
    }
  };

  const removeBundle = async (capabilityId) => {
    setSaving(true);
    try {
      await api(`/products/${productId}/bundles/${capabilityId}`, { method: "DELETE" });
      await loadDetail(productId);
    } catch (e) {
      showError("Couldn't remove the capability")(e);
    } finally {
      setSaving(false);
    }
  };

  const saveTicket = async () => {
    const d = ticketDialog;
    if (!d?.title?.trim()) return;
    setSaving(true);
    try {
      const body = {
        title: d.title.trim(),
        description: d.description?.trim() || null,
        context_budget: d.budget,
        affected_files: (d.files || "").split(",").map((s) => s.trim()).filter(Boolean),
      };
      if (d.mode === "new") {
        await api("/tickets", { method: "POST", body: { ...body, product_id: productId } });
      } else {
        await api(`/tickets/${d.ticket.id}`, { method: "PATCH", body: { ...body, status: d.status } });
      }
      setTicketDialog(null);
      await loadDetail(productId);
    } catch (e) {
      showError("Ticket save failed")(e);
    } finally {
      setSaving(false);
    }
  };

  const deleteTicket = async () => {
    const t = ticketDialog?.ticket;
    if (!t) return;
    setSaving(true);
    try {
      await api(`/tickets/${t.id}`, { method: "DELETE" });
      setTicketDialog(null);
      setConfirmingTicketDelete(false);
      setToast({ tone: "ok", title: "Ticket deleted" });
      await loadDetail(productId);
    } catch (e) {
      showError("Delete failed")(e);
      setConfirmingTicketDelete(false);
    } finally {
      setSaving(false);
    }
  };

  const closeTicket = () => { setTicketDialog(null); setConfirmingTicketDelete(false); };

  // What the owner reads in their own Chat thread, so plain words and no ids:
  // Chat resolves the exact name first and refuses one several products share.
  const planActions = {
    prompts: {
      decompose: () =>
        `Plan the work left on "${product.name}": break it down into a plan document and tickets, each ticket small enough for one coding session. Use the current capabilities and features.`,
      refreshPrd: () =>
        `Update the draft plan document for "${product.name}" to match the current capabilities and features. Keep what still fits.`,
      strategy: () =>
        `Make a delivery strategy for "${product.name}": a timeline in phases that follows its plan document and the order its features need.${strategy ? " It replaces the current one with a new version." : ""}`,
    },
    approveSpec: approveProduct,
    approvePrd,
    newTicket: () => setTicketDialog({ mode: "new", title: "", description: "", budget: "M", files: "" }),
    openTicket: (t) => setTicketDialog(canWrite
      ? { mode: "edit", ticket: t, title: t.title, description: t.description || "", budget: t.context_budget, status: t.status, files: (t.affected_files || []).join(", ") }
      : { mode: "view", ticket: t }),
  };


  return (
    <>
      <PageHeader
        title="Products"
        meta={products?.length ? count(products.length, "product") : undefined}
        actions={canWrite && products?.length > 0 && (
          <Button size="sm" variant="accent" style={{ gap: 6 }} onClick={openNewProduct}>
            <Icon name="plus" size={13} />New product
          </Button>
        )}
      />
      <div style={{ flex: 1, overflowY: "auto", padding: 24 }}>
        {products == null ? (
          <div role="status" style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)" }}>Loading products…</div>
        ) : product ? (
          <div style={{ maxWidth: 860, display: "flex", flexDirection: "column", gap: 16 }}>
            {/* In the page, not the header: the header doesn't wrap, and at phone width the picker shrank to an empty box. */}
            {products.length > 1 && (
              <Select aria-label="Product" value={productId ?? ""} onChange={(e) => selectProduct(e.target.value)} style={{ width: 320, maxWidth: "100%" }}
                options={productOptions(products)} />
            )}
            <Card>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <h2 style={{ margin: 0, fontSize: "var(--text-lg)", fontWeight: "var(--weight-semibold)", color: "var(--text-heading)" }}>{product.name}</h2>
                {product.external && <span title="Someone else's product. Its features never count as ours."><Badge>external</Badge></span>}
                <span title="When its seed file was last imported" style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>{freshness(product.seeded_at)}</span>
                <span style={{ flex: 1 }} />
                {canWrite && (
                  <>
                    <Button size="sm" variant="secondary" style={{ gap: 6 }} onClick={openEditProduct}>
                      <Icon name="pencil" size={13} />Edit
                    </Button>
                    <Button size="sm" variant="secondary" style={{ gap: 6 }} onClick={exportProduct}>
                      <Icon name="arrow-right" size={13} />Export
                    </Button>
                  </>
                )}
                <Button size="sm" variant="secondary" style={{ gap: 6 }} onClick={shareProduct} disabled={features == null || score == null}
                  title="Download a read-only page of this product to send to someone without a login">
                  <Icon name="send" size={13} />Share
                </Button>
              </div>
              {product.summary && (
                <div style={{ marginTop: 8, fontSize: "var(--text-sm)", color: "var(--text-secondary)", lineHeight: "var(--leading-body)" }}>
                  {product.summary}
                </div>
              )}
            </Card>

            <Tabs
              tabs={[
                { value: "does", label: "What it does", count: features?.length },
                { value: "goals", label: "Goals" },
                ...(showPlan ? [{ value: "plan", label: "Plan" }] : []),
              ]}
              value={shownTab}
              onChange={changeTab}
              label="Product view"
              panelId="product-panel"
            />

            <div id="product-panel" role="tabpanel" aria-labelledby={tabId("product-panel", shownTab)} style={{ minWidth: 0 }}>
            {shownTab === "does" && (
              <WhatItDoes product={product} features={features} score={score} capabilities={capabilities} journeys={journeys}
                bundles={bundles} canWrite={canWrite} onAddBundle={addBundle} onRemoveBundle={removeBundle} />
            )}

            {shownTab === "goals" && <ProductGoals product={product} goals={goals} features={features} capabilities={capabilities}
              motivations={motivations} canWrite={canWrite} />}

            {shownTab === "plan" && (showPlan ? (
              <ProductPlan product={product} prd={prd} epics={epics} tickets={tickets} strategy={strategy}
                capabilities={capabilities} features={features} canWrite={canWrite} actions={planActions} />
            ) : (
              <div role="status" style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)" }}>Loading the plan…</div>
            ))}
            </div>
          </div>
        ) : (
          <div style={{ maxWidth: 860, border: "1px dashed var(--border-default)", borderRadius: "var(--radius-md)", padding: 24, display: "flex", flexDirection: "column", gap: 12, alignItems: "flex-start", color: "var(--text-secondary)", fontSize: "var(--text-sm)" }}>
            <div>No products yet.{canWrite ? "" : " An editor adds products."}</div>
            {canWrite && (
              <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                <Button size="sm" variant="accent" style={{ gap: 6 }} onClick={openNewProduct}>
                  <Icon name="plus" size={13} />New product
                </Button>
                <a href="/settings">Add one from its repo</a>
              </div>
            )}
          </div>
        )}
      </div>

      <Dialog
        open={ticketDialog != null}
        title={ticketDialog?.mode === "new" ? "New ticket" : ticketDialog?.mode === "view" ? ticketDialog.ticket.display_id : `Edit ${ticketDialog?.ticket?.display_id ?? ""}`}
        onClose={closeTicket}
        footer={ticketDialog?.mode === "view" ? (
          <Button size="sm" variant="secondary" onClick={closeTicket}>Close</Button>
        ) : (
          <>
            {ticketDialog?.mode === "edit" && (
              <DeleteConfirm armed={confirmingTicketDelete} onArm={() => setConfirmingTicketDelete(true)} onCancel={() => setConfirmingTicketDelete(false)} onConfirm={deleteTicket} disabled={saving}
                label="Delete" confirmLabel={"Delete ticket"} style={{ marginRight: "auto" }} />
            )}
            <Button size="sm" variant="secondary" onClick={closeTicket}>Cancel</Button>
            <Button size="sm" variant="accent" disabled={saving || !ticketDialog?.title?.trim()} onClick={saveTicket}>
              {ticketDialog?.mode === "new" ? "Create ticket" : "Save"}
            </Button>
          </>
        )}
      >
        {ticketDialog?.mode === "view" && <TicketView ticket={ticketDialog.ticket} />}
        {ticketDialog && ticketDialog.mode !== "view" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <Input label="Title" value={ticketDialog.title} onChange={(e) => setTicketDialog({ ...ticketDialog, title: e.target.value })} />
            <Input label="Description (how to tell it's done)" value={ticketDialog.description} onChange={(e) => setTicketDialog({ ...ticketDialog, description: e.target.value })} />
            <Input label="Affected files (comma-separated)" mono value={ticketDialog.files} onChange={(e) => setTicketDialog({ ...ticketDialog, files: e.target.value })} placeholder="migration.sql, features.py" />
            <div title={SIZE_HINT}>
              <Select label="Size (one ticket is one coding session)" value={ticketDialog.budget} onChange={(e) => setTicketDialog({ ...ticketDialog, budget: e.target.value })}
                options={SIZES} />
            </div>
            {ticketDialog.mode === "edit" && (
              <Select label="Status" value={ticketDialog.status} onChange={(e) => setTicketDialog({ ...ticketDialog, status: e.target.value })}
                options={TICKET_STATUSES} />
            )}
          </div>
        )}
      </Dialog>

      <Dialog
        open={productDialog != null}
        title={productDialog?.mode === "new" ? "New product" : `Edit ${product?.name ?? ""}`}
        onClose={() => setProductDialog(null)}
        footer={
          <>
            {productDialog?.mode === "edit" && (
              <DeleteConfirm armed={confirmingDelete} onArm={armDelete} onCancel={() => setConfirmingDelete(false)} onConfirm={deleteProduct}
                disabled={saving || features == null || (confirmingDelete && takes === undefined)} label="Delete" confirmLabel={"Delete product"} style={{ marginRight: "auto" }} />
            )}
            {/* While a delete is armed, Keep is the one way back: Cancel would do the same, and Save is another act. */}
            {!confirmingDelete && <>
              <Button size="sm" variant="secondary" onClick={() => setProductDialog(null)}>Cancel</Button>
              <Button size="sm" variant="accent" disabled={saving || !productDialog?.name?.trim()} onClick={saveProduct}>
                {productDialog?.mode === "new" ? "Create product" : "Save"}
              </Button>
            </>}
          </>
        }
      >
        {productDialog?.mode === "edit" && confirmingDelete && <DeleteWhat product={product} features={features ?? []} takes={takes} />}
        {productDialog && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <Input label="Name" value={productDialog.name} onChange={(e) => setProductDialog({ ...productDialog, name: e.target.value })} placeholder="e.g. Trail planner" />
            <Input label="Summary" value={productDialog.summary} onChange={(e) => setProductDialog({ ...productDialog, summary: e.target.value })} />
            {!productDialog.external && (
              <Select label="Goal" value={productDialog.goalId} onChange={(e) => setProductDialog({ ...productDialog, goalId: e.target.value })}
                options={[{ value: "", label: "None" },
                  ...goals.map((g) => ({ value: g.id, label: `${g.display_id} ${g.title}` }))]} />
            )}
            <Checkbox label="External: someone else's product, known from the outside. Its features never count as ours."
              checked={productDialog.external} onChange={(on) => setProductDialog({ ...productDialog, external: on })} />
          </div>
        )}
      </Dialog>

      {toast && (
        <div style={{ position: "fixed", bottom: 20, right: 20, zIndex: 200 }}>
          <Toast tone={toast.tone} title={toast.title} detail={toast.detail} onDismiss={() => setToast(null)} />
        </div>
      )}
    </>
  );
}

// What a product delete keeps but unlinks (the API's detaches), in plain
// words: [one, many, what happens to one, to many].
const KEPT = {
  journey_steps: ["journey step", "journey steps", "stays as a gap in its journey", "stay as gaps in their journeys"],
  stories: ["story in another product's plan", "stories in other products' plans", "loses its feature", "lose their feature"],
  encounters: ["record of a technology used on it", "records of technologies used on it", "loses its product", "lose their product"],
  tickets: ["ticket in another product", "tickets in other products", "loses its story", "lose their story"],
  product_technologies: ["technology use recorded elsewhere", "technology uses recorded elsewhere", "loses its stack slot", "lose their stack slot"],
  stack_concern_answers: ["answer to a stack concern", "answers to stack concerns", "loses its slot", "lose their slot"],
};
const KEPT_ORDER = Object.keys(KEPT);
// "1 journey step stays as a gap in its journey: Write a note (A ride)." Named when few.
const keptSentence = (t) => {
  const [one, many, does, do_] = KEPT[t.table] ?? [t.label.toLowerCase(), t.label.toLowerCase(), "is kept, unlinked", "are kept, unlinked"];
  const said = `${count(t.count, one, many)} ${t.count === 1 ? does : do_}`;
  return t.names.length > 0 && t.count <= 5 ? `${said}: ${t.names.join(", ")}.` : `${said}.`;
};

// What deleting a product takes with it. Its features go too: left without a
// product they would count as ours. What only pointed at it stays, unlinked.
function DeleteWhat({ product, features, takes }) {
  const [kept, setKept] = React.useState(undefined);
  React.useEffect(() => {
    api(`/products/${product.id}/detaches`).then(setKept).catch(() => setKept(null));
  }, [product.id]);
  return (
    <div role="note" style={{ marginBottom: 14, padding: 12, border: "1px solid var(--border-default)", borderRadius: "var(--radius-sm)", display: "flex", flexDirection: "column", gap: 8, fontSize: "var(--text-sm)", color: "var(--text-body)" }}>
      <div>
        {features.length > 0
          ? <>Deleting {product.name} also deletes its {count(features.length, "feature")}:</>
          : <>{product.name} has no features.</>}
      </div>
      {features.length > 0 && (
        <ul style={{ margin: 0, paddingLeft: 18, maxHeight: 160, overflowY: "auto", display: "flex", flexDirection: "column", gap: 2 }}>
          {features.map((f) => <li key={f.id}>{f.name}</li>)}
        </ul>
      )}
      <div style={{ color: "var(--text-secondary)" }}>
        {takes === undefined ? "Reading what else goes with it…"
          : takes === null ? "Anything kept only for it, such as its plan or technology stack, goes too."
          : takenRows(takes).length ? `It also deletes ${andList(takenWords(takes))}.`
          : "Nothing else goes with it."}
        {" "}Capabilities and goals stay.
      </div>
      {kept && [...kept].sort((a, b) => (KEPT_ORDER.indexOf(a.table) + 1 || 99) - (KEPT_ORDER.indexOf(b.table) + 1 || 99)).map((t) => <div key={t.table} style={{ color: "var(--text-secondary)" }}>{keptSentence(t)}</div>)}
    </div>
  );
}

// Read-only ticket for viewers: everything the card leaves out.
function TicketView({ ticket: t }) {
  const row = (label, value) => value && (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span style={{ fontSize: "var(--text-xs)", fontWeight: "var(--weight-medium)", color: "var(--text-heading)" }}>{label}</span>
      <span style={{ fontSize: "var(--text-sm)", color: "var(--text-body)", whiteSpace: "pre-wrap" }}>{value}</span>
    </div>
  );
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ fontSize: "var(--text-md)", fontWeight: "var(--weight-semibold)", color: "var(--text-heading)" }}>{t.title}</span>
        <StatusBadge status={t.status} />
        <span title={SIZE_HINT} style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>size {t.context_budget}</span>
      </div>
      {row("Description", t.description)}
      {row("Approach", t.technical_approach)}
      {row("Acceptance", t.acceptance_criteria)}
      {row("Affected files", (t.affected_files ?? []).join(", "))}
    </div>
  );
}
