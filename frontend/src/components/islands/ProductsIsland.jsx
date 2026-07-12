import React from "react";
import { PageHeader } from "../shell/PageHeader.jsx";
import { Badge, Button, Card, Dialog, Icon, Input, Select, StatusBadge, Tabs, TicketCard, Toast } from "../../ds";
import { api } from "../../lib/api.js";

export default function ProductsIsland() {
  const [products, setProducts] = React.useState([]);
  const [productId, setProductId] = React.useState(null);
  const [epics, setEpics] = React.useState([]);
  const [tickets, setTickets] = React.useState([]);
  const [decompositions, setDecompositions] = React.useState([]);
  const [strategies, setStrategies] = React.useState([]);
  const [capabilities, setCapabilities] = React.useState([]);
  const [tab, setTab] = React.useState("prd");
  const [toast, setToast] = React.useState(null);
  const [ticketDialog, setTicketDialog] = React.useState(null); // null | {mode:'new'} | {mode:'edit', ticket}
  const [saving, setSaving] = React.useState(false);

  const product = products.find((p) => p.id === productId);
  const prd = decompositions[0];
  const strategy = strategies[0];

  const loadProducts = React.useCallback(async () => {
    const list = await api("/products");
    setProducts(list);
    setProductId((current) => current && list.some((p) => p.id === current) ? current : list[0]?.id ?? null);
  }, []);

  const loadDetail = React.useCallback(async (id) => {
    if (!id) return;
    const [epicList, ticketList, prdList, strategyList, capabilityList] = await Promise.all([
      api(`/products/${id}/epics`),
      api(`/products/${id}/tickets`),
      api(`/products/${id}/decompositions`),
      api(`/products/${id}/strategies`),
      api("/capabilities"),
    ]);
    setEpics(epicList);
    setTickets(ticketList);
    setDecompositions(prdList);
    setStrategies(strategyList);
    setCapabilities(capabilityList);
  }, []);

  React.useEffect(() => {
    loadProducts().catch((e) => setToast({ tone: "danger", title: "Load failed", detail: String(e.message) }));
  }, [loadProducts]);

  React.useEffect(() => {
    loadDetail(productId).catch((e) => setToast({ tone: "danger", title: "Load failed", detail: String(e.message) }));
  }, [productId, loadDetail]);

  const showError = (title) => (e) => setToast({ tone: "danger", title, detail: String(e.message) });

  const approveProduct = () =>
    api(`/products/${productId}/approve`, { method: "POST" })
      .then(() => { setToast({ tone: "ok", title: "Spec approved" }); return loadProducts(); })
      .catch(showError("Approve failed"));

  const approvePrd = () =>
    api(`/decompositions/${prd.id}/approve`, { method: "POST" })
      .then(() => { setToast({ tone: "ok", title: `${prd.display_id} approved` }); return loadDetail(productId); })
      .catch(showError("PRD not ready"));

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

  const ticketCounts = (epicId) => {
    const inEpic = tickets.filter((t) => t.epic_id === epicId);
    return { total: inEpic.length, done: inEpic.filter((t) => t.status === "done").length };
  };

  const maxPhaseEnd = Math.max(1, ...(strategy?.phases ?? []).map((p) => (p.start || 0) + (p.length || 0)));

  return (
    <>
      <PageHeader
        title="Products"
        meta={product ? `${product.display_id} · v${product.version}` : "no products"}
        actions={
          products.length > 1 ? (
            <Select value={productId ?? ""} onChange={(e) => setProductId(e.target.value)} style={{ width: 240 }}
              options={products.map((p) => ({ value: p.id, label: p.name }))} />
          ) : null
        }
      />
      <div style={{ flex: 1, overflowY: "auto", padding: 24 }}>
        {product ? (
          <div style={{ maxWidth: 860, display: "flex", flexDirection: "column", gap: 16 }}>
            <Card
              title={product.name}
              meta={`${product.display_id} · v${product.version}`}
              footer={
                <>
                  <StatusBadge status={product.status} />
                  {prd && <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-disabled)" }}>{prd.display_id} v{prd.version} · {prd.created_by}</span>}
                  <span style={{ flex: 1 }} />
                  {product.status === "draft" && (
                    <Button size="sm" onClick={approveProduct}>Approve</Button>
                  )}
                </>
              }
            >
              <span style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)", lineHeight: "var(--leading-body)" }}>
                {product.summary}
              </span>
            </Card>

            <Tabs
              tabs={[
                { value: "prd", label: "PRD", count: epics.length },
                { value: "tickets", label: "Tickets", count: tickets.length },
                { value: "strategy", label: "Delivery strategy" },
              ]}
              value={tab}
              onChange={setTab}
            />

            {tab === "prd" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {prd && prd.status === "draft" && (
                  <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", background: "var(--accent-wash)", borderRadius: "var(--radius-md)", fontSize: "var(--text-sm)", color: "var(--text-accent)" }}>
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>{prd.display_id} v{prd.version}</span>
                    <span style={{ flex: 1 }}>Draft until approved. L tickets must be split first.</span>
                    <Button size="sm" onClick={approvePrd}>Approve PRD</Button>
                  </div>
                )}
                {epics.map((e, i) => {
                  const counts = ticketCounts(e.id);
                  return (
                    <div key={e.id} style={{ display: "flex", alignItems: "center", gap: 12, background: "var(--surface-card)", border: "1px solid var(--border-hairline)", borderRadius: "var(--radius-md)", padding: "12px 16px" }}>
                      <Icon name="layers" size={15} style={{ color: "var(--stage-prd)" }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: "var(--text-sm)", fontWeight: "var(--weight-semibold)", color: "var(--text-heading)" }}>Epic {i + 1} — {e.title}</div>
                        {e.acceptance_criteria && <div style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)", marginTop: 2 }}>AC: {e.acceptance_criteria}</div>}
                        {(() => {
                          const cap = capabilities.find((c) => c.id === e.capability_id);
                          return cap ? (
                            <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-disabled)", marginTop: 2 }}>
                              snapshots {cap.display_id} {cap.name}
                            </div>
                          ) : null;
                        })()}
                      </div>
                      <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-secondary)" }}>{counts.done}/{counts.total}</span>
                      <Icon name="chevron-right" size={14} style={{ color: "var(--text-disabled)" }} />
                    </div>
                  );
                })}
                {epics.length === 0 && (
                  <div style={{ border: "1px dashed var(--border-default)", borderRadius: "var(--radius-md)", padding: 16, color: "var(--text-disabled)", fontSize: "var(--text-sm)" }}>
                    No PRD yet. Ask `spec_decomposer` in Chat to decompose this Spec.
                  </div>
                )}
              </div>
            )}

            {tab === "tickets" && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                {tickets.map((t) => (
                  <TicketCard key={t.id} id={t.display_id} title={t.title} description={t.description}
                    status={t.status} budget={t.context_budget} files={t.affected_files}
                    onClick={() => setTicketDialog({ mode: "edit", ticket: t, title: t.title, description: t.description || "", budget: t.context_budget, status: t.status, files: (t.affected_files || []).join(", ") })} />
                ))}
                <div onClick={() => setTicketDialog({ mode: "new", title: "", description: "", budget: "M", files: "" })}
                  style={{ border: "1px dashed var(--border-default)", borderRadius: "var(--radius-md)", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, color: "var(--text-disabled)", fontSize: "var(--text-sm)", minHeight: 90, cursor: "pointer" }}>
                  <Icon name="plus" size={14} /> New ticket
                </div>
              </div>
            )}

            {tab === "strategy" && (
              <div style={{ background: "var(--surface-card)", border: "1px solid var(--border-hairline)", borderRadius: "var(--radius-md)", padding: 20, display: "flex", flexDirection: "column", gap: 10 }}>
                {(strategy?.phases ?? []).map((p, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-disabled)", width: 16 }}>{i + 1}</span>
                    <div style={{ display: "flex", flex: "0 0 420px" }}>
                      <div style={{ width: `${((p.start || 0) / maxPhaseEnd) * 100}%` }} />
                      <div style={{ height: 10, borderRadius: 5, background: i === 0 ? "var(--stage-prd)" : "var(--ink-2)", width: `${((p.length || 0) / maxPhaseEnd) * 100}%` }} />
                    </div>
                    <span style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>{p.name}</span>
                  </div>
                ))}
                {strategy ? (
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-disabled)", marginTop: 4 }}>
                    {strategy.created_by} · v{strategy.version} · gantt
                  </div>
                ) : (
                  <div style={{ color: "var(--text-disabled)", fontSize: "var(--text-sm)" }}>
                    No delivery strategy yet. Ask `strategist` in Chat to create one.
                  </div>
                )}
              </div>
            )}
          </div>
        ) : (
          <div style={{ maxWidth: 860, border: "1px dashed var(--border-default)", borderRadius: "var(--radius-md)", padding: 24, color: "var(--text-disabled)", fontSize: "var(--text-sm)" }}>
            No products yet. Ask `spec_decomposer` in Chat to create a Spec from a product goal.
          </div>
        )}
      </div>

      <Dialog
        open={ticketDialog != null}
        title={ticketDialog?.mode === "new" ? "New ticket" : `Edit ${ticketDialog?.ticket?.display_id ?? ""}`}
        onClose={() => setTicketDialog(null)}
        footer={
          <>
            <Button size="sm" variant="secondary" onClick={() => setTicketDialog(null)}>Cancel</Button>
            <Button size="sm" variant="accent" disabled={saving || !ticketDialog?.title?.trim()} onClick={saveTicket}>
              {ticketDialog?.mode === "new" ? "Create ticket" : "Save"}
            </Button>
          </>
        }
      >
        {ticketDialog && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <Input label="Title" value={ticketDialog.title} onChange={(e) => setTicketDialog({ ...ticketDialog, title: e.target.value })} />
            <Input label="Description (verifiable done condition)" value={ticketDialog.description} onChange={(e) => setTicketDialog({ ...ticketDialog, description: e.target.value })} />
            <Input label="Affected files (comma-separated)" mono value={ticketDialog.files} onChange={(e) => setTicketDialog({ ...ticketDialog, files: e.target.value })} placeholder="migration.sql, features.py" />
            <Select label="context_budget (one ticket = one Claude session)" value={ticketDialog.budget} onChange={(e) => setTicketDialog({ ...ticketDialog, budget: e.target.value })}
              options={[{ value: "S", label: "S — single file change" }, { value: "M", label: "M — 2-4 files" }, { value: "L", label: "L — must be split" }]} />
            {ticketDialog.mode === "edit" && (
              <Select label="Status" value={ticketDialog.status} onChange={(e) => setTicketDialog({ ...ticketDialog, status: e.target.value })}
                options={["pending", "in_progress", "done"]} />
            )}
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
