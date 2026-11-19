import React from "react";
import { PageHeader } from "../shell/PageHeader.jsx";
import { Button, Dialog, Icon, IconButton, Input, PriorityBadge, Select, StatusBadge, Tabs, DeleteConfirm } from "../../ds";
import { api } from "../../lib/api.js";
import { readParam, useParamRestore, writeParams } from "../../lib/url-state.js";
import { GoalNetworkView } from "../graph/GoalNetworkView.jsx";
import { PRIORITY_HINT, count, statusLabel } from "../../lib/words.js";

const EMPTY_DRAFT = { goal_type: "product", parent_goal_id: "", title: "", description: "", success_criteria: "", priority: "3", status: "pending" };

export default function GoalsIsland({ canWrite = true }) {
  const [goals, setGoals] = React.useState(null); // null until the first load finishes
  const [productCounts, setProductCounts] = React.useState({});
  const [capsByGoal, setCapsByGoal] = React.useState({});
  const [highlight, setHighlight] = React.useState(null); // ?goal=<id>, scrolled to once loaded
  const [view, setView] = React.useState("list"); // ?view=network, read after mount (the server has no URL)
  const [picked, setPicked] = React.useState(null); // ?goal=<id> selected in the network
  const [dialog, setDialog] = React.useState(null); // null | {mode:"new"} | {mode:"edit", goal}
  const [draft, setDraft] = React.useState(EMPTY_DRAFT);
  const [saving, setSaving] = React.useState(false);
  const [confirmingDelete, setConfirmingDelete] = React.useState(false);
  const [error, setError] = React.useState(null);

  const load = React.useCallback(async () => {
    const [goalList, products, motivations, capabilities] = await Promise.all([
      api("/goals"),
      api("/products"),
      api("/motivations"),
      api("/capabilities"),
    ]);
    // Per goal, the capabilities it motivates, linked by slug.
    const slugs = new Map(capabilities.map((c) => [c.id, c.slug]));
    const caps = {};
    for (const m of motivations) {
      (caps[m.goal_id] ??= []).push({ id: m.capability_id, name: m.capability_name, slug: slugs.get(m.capability_id) });
    }
    setCapsByGoal(caps);
    setGoals(goalList);
    // Per goal, the products that serve it, so each goal links to its own product.
    const byGoal = {};
    for (const p of products) {
      if (p.goal_id) (byGoal[p.goal_id] ??= []).push(p);
    }
    setProductCounts(byGoal);
  }, []);

  React.useEffect(() => {
    load().catch((e) => setError(String(e.message)));
  }, [load]);

  const loaded = goals != null;
  React.useEffect(() => {
    const id = readParam("goal");
    if (!loaded || !id || view !== "list") return;
    const el = document.getElementById(`goal-${id}`);
    if (!el) return;
    el.scrollIntoView({ block: "center" });
    setHighlight(id);
  }, [loaded, view]);

  const orgs = (goals ?? []).filter((g) => g.goal_type === "org");
  const productGoals = (goals ?? []).filter((g) => g.goal_type === "product");
  const orgIds = new Set(orgs.map((o) => o.id));
  const unparented = productGoals.filter((g) => !orgIds.has(g.parent_goal_id));
  // A product goal needs an org goal as its parent whenever one exists.
  const needsParent = draft.goal_type === "product" && orgs.length > 0 && !draft.parent_goal_id;

  // An org goal across its product goals: distinct capabilities linked to any of them.
  const orgCapabilityCount = (org) => {
    const ids = new Set((capsByGoal[org.id] ?? []).map((c) => c.id));
    for (const g of productGoals) if (g.parent_goal_id === org.id) for (const c of capsByGoal[g.id] ?? []) ids.add(c.id);
    return ids.size;
  };

  const openNew = () => {
    setDraft({ ...EMPTY_DRAFT, goal_type: orgs.length === 0 ? "org" : "product" });
    setConfirmingDelete(false);
    setError(null);
    setDialog({ mode: "new" });
  };

  const openEdit = (goal) => {
    setDraft({
      goal_type: goal.goal_type,
      parent_goal_id: goal.parent_goal_id ?? "",
      title: goal.title,
      description: goal.description ?? "",
      success_criteria: goal.success_criteria ?? "",
      priority: goal.priority != null ? String(goal.priority) : "3",
      status: goal.status,
    });
    setConfirmingDelete(false);
    setError(null);
    setDialog({ mode: "edit", goal });
  };

  const save = async () => {
    if (!draft.title.trim()) return;
    setSaving(true);
    setError(null);
    try {
      if (dialog.mode === "new") {
        await api("/goals", {
          method: "POST",
          body: {
            goal_type: draft.goal_type,
            title: draft.title.trim(),
            description: draft.description.trim() || null,
            success_criteria: draft.success_criteria.trim() || null,
            priority: draft.goal_type === "product" ? Number(draft.priority) : null,
            parent_goal_id: draft.goal_type === "product" && draft.parent_goal_id ? draft.parent_goal_id : null,
          },
        });
      } else {
        await api(`/goals/${dialog.goal.id}`, {
          method: "PATCH",
          body: {
            title: draft.title.trim(),
            description: draft.description.trim() || null,
            success_criteria: draft.success_criteria.trim() || null,
            priority: draft.goal_type === "product" ? Number(draft.priority) : null,
            status: draft.status,
            ...(draft.goal_type === "product" && draft.parent_goal_id ? { parent_goal_id: draft.parent_goal_id } : {}),
          },
        });
      }
      setDialog(null);
      setDraft(EMPTY_DRAFT);
      await load();
    } catch (e) {
      setError(String(e.message));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setSaving(true);
    setError(null);
    try {
      await api(`/goals/${dialog.goal.id}`, { method: "DELETE" });
      setDialog(null);
      await load();
    } catch (e) {
      setError(String(e.message));
      setConfirmingDelete(false);
    } finally {
      setSaving(false);
    }
  };

  useParamRestore("view", (v) => setView(v === "network" ? "network" : "list"));
  useParamRestore("goal", (id) => setPicked(id));
  const changeView = (next) => {
    setView(next);
    // Carry the network's selection over, so the list scrolls to it.
    writeParams({ view: next === "network" ? "network" : "", goal: picked ?? "" }, { push: true });
    if (next === "list") setHighlight(picked);
  };
  const pickGoal = (id) => {
    setPicked(id);
    writeParams({ goal: id }, { push: true });
  };

  const highlightStyle = (id) => (id === highlight ? { outline: "2px solid var(--accent)", outlineOffset: 2 } : null);

  const editButton = (goal) =>
    canWrite ? (
      <IconButton size="sm" label="Edit goal"
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); openEdit(goal); }}>
        <Icon name="pencil" size={13} />
      </IconButton>
    ) : null;

  return (
    <>
      <PageHeader
        title="Goals"
        meta={goals ? `${orgs.length} org · ${productGoals.length} product` : "loading"}
        actions={
          canWrite && (
            <Button size="sm" variant="accent" style={{ gap: 6 }} onClick={openNew}>
              <Icon name="plus" size={13} />New goal
            </Button>
          )
        }
      />
      <div style={{ padding: "12px 24px 0", flex: "none" }}>
        <Tabs tabs={[{ value: "list", label: "List" }, { value: "network", label: "Network" }]} value={view} onChange={changeView} />
      </div>
      {view === "network" ? (
        goals == null ? (
          <div style={{ padding: 24, color: "var(--text-secondary)", fontSize: "var(--text-sm)" }}>{error ?? "Loading goals…"}</div>
        ) : (
          <GoalNetworkView goals={goals} capsByGoal={capsByGoal} selectedId={picked} onSelect={pickGoal} />
        )
      ) : (
      <div style={{ flex: 1, overflowY: "auto", padding: 24 }}>
        <div style={{ maxWidth: 760 }}>
          {error && !dialog && (
            <div style={{ marginBottom: 12, fontSize: "var(--text-sm)", color: "var(--danger-fg)" }}>{error}</div>
          )}
          {goals == null && !error && (
            <div style={{ color: "var(--text-secondary)", fontSize: "var(--text-sm)" }}>Loading goals…</div>
          )}
          {goals != null && !canWrite && (
            <div style={{ marginBottom: 12, fontSize: "var(--text-sm)", color: "var(--text-secondary)" }}>An editor or admin can change goals.</div>
          )}
          {goals != null && orgs.length === 0 && (
            <div style={{ border: "1px dashed var(--border-default)", borderRadius: "var(--radius-lg)", padding: "20px 24px", color: "var(--text-secondary)", fontSize: "var(--text-sm)", display: "flex", flexDirection: "column", gap: 6 }}>
              <span>No org goal yet. An org goal says why the company cares about something. A product goal sits under one and says what a product is for.</span>
              {canWrite && <span>Start with an org goal: choose New goal.</span>}
            </div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
            {orgs.map((org) => (
              <div key={org.id}>
                <div id={`goal-${org.id}`} style={{ background: "var(--surface-inverse)", borderRadius: "var(--radius-lg)", padding: "20px 24px", display: "flex", alignItems: "center", gap: 16, ...highlightStyle(org.id) }}>
                  <Icon name="target" size={20} style={{ color: "var(--aegean-4)" }} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "var(--tracking-caps)", textTransform: "uppercase", color: "var(--aegean-4)" }}>org goal · {org.display_id}</div>
                    <div style={{ fontFamily: "var(--font-display)", fontSize: "var(--text-xl)", fontWeight: "var(--weight-semibold)", color: "var(--text-inverse)", letterSpacing: "var(--tracking-tight)" }}>{org.title}</div>
                  </div>
                  <span style={{ fontSize: "var(--text-xs)", color: "var(--aegean-4)", whiteSpace: "nowrap" }}>
                    {count(orgCapabilityCount(org), "capability", "capabilities")} linked
                  </span>
                  <StatusBadge status={org.status} />
                  {canWrite && (
                    <IconButton size="sm" label="Edit goal" style={{ color: "var(--aegean-4)" }}
                      onClick={() => openEdit(org)}>
                      <Icon name="pencil" size={13} />
                    </IconButton>
                  )}
                </div>
                <GoalList
                  goals={productGoals.filter((g) => g.parent_goal_id === org.id)}
                  productCounts={productCounts}
                  capsByGoal={capsByGoal}
                  highlightStyle={highlightStyle}
                  editButton={editButton}
                  canWrite={canWrite}
                  emptyText="No product goals under this org goal yet."
                />
              </div>
            ))}
            {unparented.length > 0 && (
              <div>
                <div style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)" }}>
                  These product goals aren't under an org goal. Edit one to choose its parent.
                </div>
                <GoalList goals={unparented} productCounts={productCounts} capsByGoal={capsByGoal} highlightStyle={highlightStyle} editButton={editButton} canWrite={canWrite} />
              </div>
            )}
          </div>
        </div>
      </div>
      )}

      <Dialog
        open={dialog != null}
        title={dialog?.mode === "new" ? "New goal" : `Edit ${dialog?.goal?.display_id ?? ""}`}
        onClose={() => setDialog(null)}
        footer={
          <>
            {dialog?.mode === "edit" && (
              <DeleteConfirm armed={confirmingDelete} onArm={() => setConfirmingDelete(true)} onCancel={() => setConfirmingDelete(false)} onConfirm={remove} disabled={saving}
                label="Delete" confirmLabel={"Delete goal"} style={{ marginRight: "auto" }} />
            )}
            <Button size="sm" variant="secondary" onClick={() => setDialog(null)}>Cancel</Button>
            <Button size="sm" variant="accent" disabled={saving || !draft.title.trim() || needsParent} onClick={save}>
              {dialog?.mode === "new" ? "Create goal" : "Save"}
            </Button>
          </>
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {error && (
            <div role="alert" style={{ fontSize: "var(--text-sm)", color: "var(--danger-fg)" }}>{error}</div>
          )}
          {dialog?.mode === "new" && (
            <Select
              label="Type"
              value={draft.goal_type}
              onChange={(e) => setDraft({ ...draft, goal_type: e.target.value })}
              options={[
                { value: "product", label: "Product goal" },
                { value: "org", label: "Org goal" },
              ]}
            />
          )}
          {draft.goal_type === "product" && orgs.length > 0 && (
            <Select
              label="Org goal it serves"
              value={draft.parent_goal_id}
              onChange={(e) => setDraft({ ...draft, parent_goal_id: e.target.value })}
              options={[
                { value: "", label: "Choose an org goal…", disabled: true },
                ...orgs.map((o) => ({ value: o.id, label: `${o.display_id} · ${o.title}` })),
              ]}
            />
          )}
          <Input
            label="Title"
            value={draft.title}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            placeholder="Ship PM export to 3 trackers"
          />
          <Input
            label="Description"
            value={draft.description}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          />
          <Input
            label="Success criteria"
            value={draft.success_criteria}
            onChange={(e) => setDraft({ ...draft, success_criteria: e.target.value })}
            placeholder="Jira, Linear, Notion round-trip by Q4"
          />
          {draft.goal_type === "product" && (
            <Select
              label={`Priority (${PRIORITY_HINT})`}
              value={draft.priority}
              onChange={(e) => setDraft({ ...draft, priority: e.target.value })}
              options={["1", "2", "3", "4", "5"].map((p) => ({ value: p, label: `P${p}` }))}
            />
          )}
          {dialog?.mode === "edit" && (
            <Select
              label="Status"
              value={draft.status}
              onChange={(e) => setDraft({ ...draft, status: e.target.value })}
              options={["pending", "in_progress", "done"].map((v) => ({ value: v, label: statusLabel(v) }))}
            />
          )}
        </div>
      </Dialog>
    </>
  );
}

function GoalList({ goals, productCounts, capsByGoal, highlightStyle, editButton, emptyText, canWrite }) {
  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "16px 0 10px", fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "var(--tracking-caps)", textTransform: "uppercase", color: "var(--text-secondary)" }}>
        <span style={{ width: 14, height: 1, background: "var(--ink-3)" }} />product goals · {goals.length}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {goals.map((g) => {
          const served = productCounts[g.id] || [];
          const caps = capsByGoal[g.id] || [];
          return (
            <div key={g.id} id={`goal-${g.id}`} style={{ display: "flex", alignItems: "center", gap: 14, background: "var(--surface-card)", border: "1px solid var(--border-hairline)", borderRadius: "var(--radius-md)", boxShadow: "var(--shadow-card)", padding: "14px 18px", ...highlightStyle(g.id) }}>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-secondary)", width: 46 }}>{g.display_id}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: "var(--text-md)", fontWeight: "var(--weight-semibold)", color: "var(--text-heading)" }}>{g.title}</div>
                {g.success_criteria && (
                  <div style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)", marginTop: 2 }}>Success: {g.success_criteria}</div>
                )}
                <div style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)", marginTop: 4, display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {caps.length === 0 ? (
                    <span>{canWrite ? "No capabilities linked. Link one from a capability's page." : "No capabilities linked."}</span>
                  ) : (
                    <>
                      <span>{count(caps.length, "capability", "capabilities")}:</span>
                      {caps.map((c, i) => (
                        <a key={c.id} href={`/capabilities/${c.slug}`}>{c.name}{i < caps.length - 1 ? "," : ""}</a>
                      ))}
                    </>
                  )}
                </div>
              </div>
              {g.priority != null && <PriorityBadge priority={g.priority} rationale={PRIORITY_HINT} />}
              {served.map((p) => (
                <a key={p.id} href={`/products?product=${p.id}`} style={{ fontSize: "var(--text-xs)", whiteSpace: "nowrap" }}>{p.name}</a>
              ))}
              <StatusBadge status={g.status} />
              {editButton(g)}
            </div>
          );
        })}
        {goals.length === 0 && emptyText && (
          <div style={{ border: "1px dashed var(--border-default)", borderRadius: "var(--radius-md)", padding: "16px 18px", color: "var(--text-secondary)", fontSize: "var(--text-sm)" }}>
            {emptyText}
          </div>
        )}
      </div>
    </>
  );
}
