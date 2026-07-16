import React from "react";
import { PageHeader } from "../shell/PageHeader.jsx";
import { Badge, Button, Card, Dialog, Icon, Input, Select, StatusBadge, Tabs, TicketCard, Toast } from "../../ds";
import { api } from "../../lib/api.js";
import { openChatWithPrompt } from "../../lib/chat-launch.js";

export default function ProductsIsland({ canWrite = true }) {
  const [products, setProducts] = React.useState([]);
  const [productId, setProductId] = React.useState(null);
  const [goals, setGoals] = React.useState([]);
  const [epics, setEpics] = React.useState([]);
  const [tickets, setTickets] = React.useState([]);
  const [decompositions, setDecompositions] = React.useState([]);
  const [strategies, setStrategies] = React.useState([]);
  const [capabilities, setCapabilities] = React.useState([]);
  const [tab, setTab] = React.useState("prd");
  const [toast, setToast] = React.useState(null);
  const [ticketDialog, setTicketDialog] = React.useState(null); // null | {mode:'new'} | {mode:'edit', ticket}
  const [productDialog, setProductDialog] = React.useState(null); // null | {mode:'new'} | {mode:'edit'}
  const [seedDialog, setSeedDialog] = React.useState(false);
  const [seedText, setSeedText] = React.useState("");
  const [seedResult, setSeedResult] = React.useState(null);
  const [seedAction, setSeedAction] = React.useState(null); // null | "validate" | "import"
  const [confirmingDelete, setConfirmingDelete] = React.useState(false);
  const [confirmingTicketDelete, setConfirmingTicketDelete] = React.useState(false);
  const [saving, setSaving] = React.useState(false);

  const product = products.find((p) => p.id === productId);
  const prd = decompositions[0];
  const strategy = strategies[0];

  const loadProducts = React.useCallback(async () => {
    const [list, goalList] = await Promise.all([api("/products"), api("/goals")]);
    setProducts(list);
    setGoals(goalList);
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

  const openNewProduct = () => {
    setConfirmingDelete(false);
    setProductDialog({ mode: "new", name: "", summary: "", goalId: "" });
  };

  const openEditProduct = () => {
    setConfirmingDelete(false);
    setProductDialog({ mode: "edit", name: product.name, summary: product.summary ?? "", goalId: product.goal_id ?? "" });
  };

  const saveProduct = async () => {
    const d = productDialog;
    if (!d?.name?.trim()) return;
    setSaving(true);
    try {
      const body = {
        name: d.name.trim(),
        summary: d.summary.trim() || null,
        goal_id: d.goalId || null,
      };
      if (d.mode === "new") {
        const created = await api("/products", { method: "POST", body });
        await loadProducts();
        setProductId(created.id);
      } else {
        await api(`/products/${productId}`, { method: "PATCH", body });
        await loadProducts();
      }
      setProductDialog(null);
    } catch (e) {
      showError("Spec save failed")(e);
    } finally {
      setSaving(false);
    }
  };

  const deleteProduct = async () => {
    setSaving(true);
    try {
      await api(`/products/${productId}`, { method: "DELETE" });
      setProductDialog(null);
      setToast({ tone: "ok", title: "Spec deleted" });
      await loadProducts();
    } catch (e) {
      showError("Delete failed")(e);
      setConfirmingDelete(false);
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

  const ticketCounts = (epicId) => {
    const inEpic = tickets.filter((t) => t.epic_id === epicId);
    return { total: inEpic.length, done: inEpic.filter((t) => t.status === "done").length };
  };

  const maxPhaseEnd = Math.max(1, ...(strategy?.phases ?? []).map((p) => (p.start || 0) + (p.length || 0)));

  const decomposePrompt = () =>
    `Decompose the Spec "${product.name}" (${product.display_id}, product id ${productId}) into a PRD: epics must pin capabilities, stories must pin features, tickets sized S/M/L for one Claude session each. Use the current capability map and feature graph.`;

  const refreshPrdPrompt = () =>
    `Refresh the draft PRD for "${product.name}" (${product.display_id}, product id ${productId}). Keep approved pins where still valid; update epics/stories/tickets to match the current taxonomy.`;

  const strategyPrompt = () =>
    `Create a delivery strategy for "${product.name}" (${product.display_id}, product id ${productId}): phased Gantt plan aligned to the current PRD and feature graph.${strategy ? " Replace the existing strategy with a new version." : ""}`;

  const summarizeCounts = (counts) =>
    [
      formatCounts("goals", counts?.goals),
      formatCounts("capabilities", counts?.capabilities),
      formatCounts("motivations", counts?.motivations),
      formatCounts("features", counts?.features),
      formatCounts("edges", counts?.edges),
      formatCounts("products", counts?.products),
      formatCounts("decompositions", counts?.decompositions),
    ].filter(Boolean);

  const runSeedImport = async (dryRun) => {
    if (!seedText.trim()) return;
    setSeedAction(dryRun ? "validate" : "import");
    try {
      const result = await api("/seed/import", {
        method: "POST",
        body: { document: seedText, dryRun },
      });
      setSeedResult(result);
      if (!dryRun) {
        setToast({
          tone: "ok",
          title: "Seed imported",
          detail: summarizeCounts(result.counts).join(" · "),
        });
        await loadProducts();
        if (productId) await loadDetail(productId);
      }
    } catch (e) {
      setToast({
        tone: "danger",
        title: dryRun ? "Validation failed" : "Import failed",
        detail: String(e.message),
      });
    } finally {
      setSeedAction(null);
    }
  };

  const loadSeedFile = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setSeedText(await file.text());
    setSeedResult(null);
  };

  return (
    <>
      <PageHeader
        title="Products"
        meta={product ? `${product.display_id} · v${product.version}` : "no products"}
        actions={
          <>
            {products.length > 1 && (
              <Select value={productId ?? ""} onChange={(e) => setProductId(e.target.value)} style={{ width: 240 }}
                options={products.map((p) => ({ value: p.id, label: p.name }))} />
            )}
            {canWrite && (
              <Button size="sm" variant="accent" style={{ gap: 6 }} onClick={openNewProduct}>
                <Icon name="plus" size={13} />New spec
              </Button>
            )}
            {canWrite && (
              <Button
                size="sm"
                variant="secondary"
                style={{ gap: 6 }}
                onClick={() => {
                  setSeedDialog(true);
                  setSeedResult(null);
                }}
              >
                <Icon name="paperclip" size={13} />Import seed
              </Button>
            )}
          </>
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
                  {canWrite && (
                    <Button size="sm" variant="secondary" style={{ gap: 6 }} onClick={openEditProduct}>
                      <Icon name="pencil" size={13} />Edit
                    </Button>
                  )}
                  {canWrite && product.status === "draft" && (
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
                {canWrite && (
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <Button size="sm" variant="secondary" style={{ gap: 6 }} onClick={() => openChatWithPrompt(decomposePrompt())}>
                      <Icon name="sparkles" size={13} />{epics.length === 0 ? "Decompose spec" : "Regenerate PRD"}
                    </Button>
                    {prd && prd.status === "draft" && (
                      <Button size="sm" variant="secondary" style={{ gap: 6 }} onClick={() => openChatWithPrompt(refreshPrdPrompt())}>
                        <Icon name="sparkles" size={13} />Refresh PRD draft
                      </Button>
                    )}
                  </div>
                )}
                {prd && prd.status === "draft" && canWrite && (
                  <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", background: "var(--accent-wash)", borderRadius: "var(--radius-md)", fontSize: "var(--text-sm)", color: "var(--text-accent)" }}>
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>{prd.display_id} v{prd.version}</span>
                    <span style={{ flex: 1 }}>Draft until approved. L tickets must be split first.</span>
                    <Button size="sm" onClick={approvePrd}>Approve PRD</Button>
                  </div>
                )}
                {prd && prd.status === "draft" && !canWrite && (
                  <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", background: "var(--accent-wash)", borderRadius: "var(--radius-md)", fontSize: "var(--text-sm)", color: "var(--text-accent)" }}>
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>{prd.display_id} v{prd.version}</span>
                    <span style={{ flex: 1 }}>Draft PRD — awaiting approval.</span>
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
                              snapshots {cap.name}
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
                    onClick={canWrite ? () => setTicketDialog({ mode: "edit", ticket: t, title: t.title, description: t.description || "", budget: t.context_budget, status: t.status, files: (t.affected_files || []).join(", ") }) : undefined} />
                ))}
                {canWrite && (
                  <div onClick={() => setTicketDialog({ mode: "new", title: "", description: "", budget: "M", files: "" })}
                    style={{ border: "1px dashed var(--border-default)", borderRadius: "var(--radius-md)", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, color: "var(--text-disabled)", fontSize: "var(--text-sm)", minHeight: 90, cursor: "pointer" }}>
                    <Icon name="plus" size={14} /> New ticket
                  </div>
                )}
              </div>
            )}

            {tab === "strategy" && (
              <div style={{ background: "var(--surface-card)", border: "1px solid var(--border-hairline)", borderRadius: "var(--radius-md)", padding: 20, display: "flex", flexDirection: "column", gap: 10 }}>
                {canWrite && (
                  <Button size="sm" variant="secondary" style={{ alignSelf: "flex-start", gap: 6 }}
                    onClick={() => openChatWithPrompt(strategyPrompt())}>
                    <Icon name="sparkles" size={13} />{strategy ? "Regenerate strategy" : "Create strategy"}
                  </Button>
                )}
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
        open={seedDialog}
        title="Import metis-seed.json"
        onClose={() => {
          setSeedDialog(false);
          setSeedAction(null);
        }}
        footer={
          <>
            <Button size="sm" variant="secondary" onClick={() => setSeedResult(null)}>
              Clear summary
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setSeedDialog(false)}>
              Close
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={seedAction != null || !seedText.trim()}
              onClick={() => runSeedImport(true)}
            >
              {seedAction === "validate" ? "Validating..." : "Validate"}
            </Button>
            <Button
              size="sm"
              variant="accent"
              disabled={seedAction != null || !seedText.trim()}
              onClick={() => runSeedImport(false)}
            >
              {seedAction === "import" ? "Importing..." : "Import"}
            </Button>
          </>
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)", lineHeight: "var(--leading-body)" }}>
            Paste a `metis-seed/v1` document or load a local `.json` file. Validate runs the
            same seed-format checks as the loader; import uses the same add-only identity rules.
          </div>
          <input type="file" accept=".json,application/json" onChange={loadSeedFile} />
          <textarea
            rows={14}
            value={seedText}
            onChange={(e) => {
              setSeedText(e.target.value);
              setSeedResult(null);
            }}
            placeholder='{"format":"metis-seed/v1", ...}'
            style={{
              width: "100%",
              resize: "vertical",
              border: "1px solid var(--border-default)",
              borderRadius: "var(--radius-md)",
              background: "var(--surface-card)",
              color: "var(--text-body)",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-xs)",
              padding: 12,
              lineHeight: 1.5,
            }}
          />
          {seedResult && (
            <div
              style={{
                border: "1px solid var(--border-hairline)",
                borderRadius: "var(--radius-md)",
                background: "var(--surface-inset)",
                padding: 12,
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              <div style={{ fontSize: "var(--text-sm)", fontWeight: "var(--weight-semibold)", color: "var(--text-heading)" }}>
                {seedResult.dryRun ? "Dry run" : "Imported"}
              </div>
              <div style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)", lineHeight: "var(--leading-snug)" }}>
                {summarizeCounts(seedResult.counts).join(" · ")}
              </div>
              {(seedResult.notes || []).length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-disabled)" }}>Notes</div>
                  {seedResult.notes.map((note, i) => (
                    <div key={i} style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>{note}</div>
                  ))}
                </div>
              )}
              {(seedResult.warnings || []).length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--danger-fg)" }}>Warnings</div>
                  {seedResult.warnings.map((warning, i) => (
                    <div key={i} style={{ fontSize: "var(--text-xs)", color: "var(--danger-fg)" }}>{warning}</div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </Dialog>

      <Dialog
        open={ticketDialog != null}
        title={ticketDialog?.mode === "new" ? "New ticket" : `Edit ${ticketDialog?.ticket?.display_id ?? ""}`}
        onClose={() => { setTicketDialog(null); setConfirmingTicketDelete(false); }}
        footer={
          <>
            {ticketDialog?.mode === "edit" && (
              <Button size="sm" variant={confirmingTicketDelete ? "danger" : "secondary"} disabled={saving}
                style={{ marginRight: "auto", gap: 6 }}
                onClick={() => (confirmingTicketDelete ? deleteTicket() : setConfirmingTicketDelete(true))}>
                <Icon name="trash" size={13} />{confirmingTicketDelete ? "Confirm delete" : "Delete"}
              </Button>
            )}
            <Button size="sm" variant="secondary" onClick={() => { setTicketDialog(null); setConfirmingTicketDelete(false); }}>Cancel</Button>
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

      <Dialog
        open={productDialog != null}
        title={productDialog?.mode === "new" ? "New spec" : `Edit ${product?.display_id ?? ""}`}
        onClose={() => setProductDialog(null)}
        footer={
          <>
            {productDialog?.mode === "edit" && (
              <Button size="sm" variant={confirmingDelete ? "danger" : "secondary"} disabled={saving}
                style={{ marginRight: "auto", gap: 6 }}
                onClick={() => (confirmingDelete ? deleteProduct() : setConfirmingDelete(true))}>
                <Icon name="trash" size={13} />{confirmingDelete ? "Confirm delete" : "Delete"}
              </Button>
            )}
            <Button size="sm" variant="secondary" onClick={() => setProductDialog(null)}>Cancel</Button>
            <Button size="sm" variant="accent" disabled={saving || !productDialog?.name?.trim()} onClick={saveProduct}>
              {productDialog?.mode === "new" ? "Create spec" : "Save"}
            </Button>
          </>
        }
      >
        {productDialog && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <Input label="Name" value={productDialog.name} onChange={(e) => setProductDialog({ ...productDialog, name: e.target.value })} placeholder="PM tracker export" />
            <Input label="Summary" value={productDialog.summary} onChange={(e) => setProductDialog({ ...productDialog, summary: e.target.value })} />
            <Select label="Product goal" value={productDialog.goalId} onChange={(e) => setProductDialog({ ...productDialog, goalId: e.target.value })}
              options={[{ value: "", label: "None" },
                ...goals.map((g) => ({ value: g.id, label: `${g.display_id} ${g.title}` }))]} />
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

function formatCounts(collection, counts) {
  if (!counts) return null;
  const detail = Object.entries(counts)
    .filter(([, value]) => value > 0)
    .map(([action, value]) => `${value} ${action}`)
    .join(", ");
  return detail ? `${collection}: ${detail}` : null;
}
