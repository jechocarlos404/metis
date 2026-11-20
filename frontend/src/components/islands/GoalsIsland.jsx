import React from "react";
import { PageHeader } from "../shell/PageHeader.jsx";
import { Button, Dialog, Icon, IconButton, Input, PriorityBadge, Select, StatusBadge, Tabs, Toast, DeleteConfirm } from "../../ds";
import { api } from "../../lib/api.js";
import { readParam, useParamRestore, writeParams } from "../../lib/url-state.js";
import { GoalNetworkView } from "../graph/GoalNetworkView.jsx";
import { NEED, PRIORITY_HINT, andList, count, needKey, statusLabel } from "../../lib/words.js";
import { deleteEffects } from "../graph/goal-facts.js";

const EMPTY_DRAFT = { goal_type: "product", parent_goal_id: "", title: "", description: "", success_criteria: "", priority: "3", status: "pending" };

export default function GoalsIsland({ canWrite = true }) {
  const [goals, setGoals] = React.useState(null); // null until the first load finishes
  const [products, setProducts] = React.useState([]);
  const productById = React.useMemo(() => Object.fromEntries(products.map((p) => [p.id, p])), [products]);
  const [capsByGoal, setCapsByGoal] = React.useState({});
  const [highlight, setHighlight] = React.useState(null); // ?goal=<id>, scrolled to once loaded
  const [view, setView] = React.useState("list"); // ?view=network, read after mount (the server has no URL)
  const [picked, setPicked] = React.useState(null); // ?goal=<id> selected in the network
  const [dialog, setDialog] = React.useState(null); // null | {mode:"new"} | {mode:"edit", goal}
  const [draft, setDraft] = React.useState(EMPTY_DRAFT);
  const [saving, setSaving] = React.useState(false);
  const [confirmingDelete, setConfirmingDelete] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [notice, setNotice] = React.useState(null); // what the last write did
  const [scrollTo, setScrollTo] = React.useState(null); // a goal to bring into view once rendered

  const load = React.useCallback(async () => {
    const [goalList, productList, motivations, capabilities] = await Promise.all([
      api("/goals"),
      api("/products"),
      api("/motivations"),
      api("/capabilities/inventory"),
    ]);
    // Per goal, the capabilities it motivates, linked by slug, with whether we have each.
    const byId = new Map(capabilities.map((c) => [c.id, c]));
    const caps = {};
    for (const m of motivations) {
      const c = byId.get(m.capability_id);
      (caps[m.goal_id] ??= []).push({ id: m.capability_id, name: m.capability_name, slug: c?.slug, need: needKey(c) });
    }
    setCapsByGoal(caps);
    setGoals(goalList);
    // Each goal says which product it belongs to (the goals API's product_id);
    // a delete also needs which products have a goal as theirs (goal_id).
    setProducts(productList);
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

  // An org goal's own links, the count the Network panel shows, then the
  // distinct capabilities across it and its product goals when that is more.
  const orgCapabilityCount = (org) => {
    const direct = (capsByGoal[org.id] ?? []).length;
    const children = productGoals.filter((g) => g.parent_goal_id === org.id);
    if (children.length === 0) return `${count(direct, "capability", "capabilities")} linked`;
    const ids = new Set((capsByGoal[org.id] ?? []).map((c) => c.id));
    for (const g of children) for (const c of capsByGoal[g.id] ?? []) ids.add(c.id);
    return `${count(direct, "capability", "capabilities")} linked directly${ids.size > direct ? ` · ${ids.size} with its product goals` : ""}`;
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
      let saved;
      if (dialog.mode === "new") {
        saved = await api("/goals", {
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
        saved = await api(`/goals/${dialog.goal.id}`, {
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
      const created = dialog.mode === "new";
      setDialog(null);
      setDraft(EMPTY_DRAFT);
      await load();
      setNotice({ tone: "ok", title: `${created ? "Created" : "Saved"} ${saved.display_id}`, detail: saved.title });
      setHighlight(saved.id);
      setScrollTo(saved.id);
    } catch (e) {
      setError(String(e.message));
    } finally {
      setSaving(false);
    }
  };

  // Arming reloads, so the note names what the delete removes now, not at page load.
  const armDelete = () => {
    setConfirmingDelete(true);
    load().catch((e) => setError(String(e.message)));
  };

  const remove = async () => {
    setSaving(true);
    setError(null);
    try {
      const gone = dialog.goal;
      const { capabilities, products: left, children } = deleteEffects(gone, goals, capsByGoal, products);
      await api(`/goals/${gone.id}`, { method: "DELETE" });
      setDialog(null);
      await load();
      const did = [
        capabilities.length > 0 && `Unlinked ${andList(capabilities.map((c) => c.name))}.`,
        left.length > 0 && `${andList(left.map((p) => p.name))} ${left.length === 1 ? "has" : "have"} no goal now.`,
        children.length > 0 && `${andList(children.map((g) => g.display_id))} ${children.length === 1 ? "is" : "are"} no longer under an org goal.`,
      ].filter(Boolean);
      setNotice({ tone: "ok", title: `Deleted ${gone.display_id}`, detail: [gone.title, ...did].join(" ") });
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

  React.useEffect(() => {
    if (!scrollTo) return;
    document.getElementById(`goal-${scrollTo}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
    setScrollTo(null);
  }, [scrollTo, goals]);
  React.useEffect(() => {
    if (!notice) return undefined;
    const t = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(t);
  }, [notice]);

  const highlightStyle = (id) => (id === highlight ? { outline: "2px solid var(--accent)", outlineOffset: 2 } : null);

  const editButton = (goal) =>
    canWrite ? (
      <IconButton size="sm" label={`Edit ${goal.title}`}
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
                <div id={`goal-${org.id}`} style={{ background: "var(--surface-inverse)", borderRadius: "var(--radius-lg)", padding: "20px 24px", display: "flex", flexWrap: "wrap", alignItems: "center", gap: 16, ...highlightStyle(org.id) }}>
                  <Icon name="target" size={20} style={{ color: "var(--aegean-4)" }} />
                  <div style={{ flex: "1 1 220px", minWidth: 0 }}>
                    <div style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", letterSpacing: "var(--tracking-caps)", textTransform: "uppercase", color: "var(--aegean-4)" }}>org goal · {org.display_id}</div>
                    <div style={{ fontFamily: "var(--font-display)", fontSize: "var(--text-xl)", fontWeight: "var(--weight-semibold)", color: "var(--text-inverse)", letterSpacing: "var(--tracking-tight)" }}>{org.title}</div>
                    {productById[org.product_id] && (
                      <div style={{ fontSize: "var(--text-xs)", color: "var(--aegean-4)", marginTop: 2 }}>
                        For <a href={`/products?product=${org.product_id}`} style={{ color: "var(--text-inverse)" }}>{productById[org.product_id].name}</a>
                      </div>
                    )}
                    {org.description && <div style={{ fontSize: "var(--text-sm)", color: "var(--aegean-4)", marginTop: 4 }}>{org.description}</div>}
                    {org.success_criteria && <div style={{ fontSize: "var(--text-xs)", color: "var(--aegean-4)", marginTop: 2 }}>Success: {org.success_criteria}</div>}
                    <div style={{ fontSize: "var(--text-xs)", color: "var(--aegean-4)", marginTop: 4 }}>{orgCapabilityCount(org)}</div>
                  </div>
                  <StatusBadge status={org.status} />
                  {canWrite && (
                    <IconButton size="sm" label={`Edit ${org.title}`} style={{ color: "var(--aegean-4)" }}
                      onClick={() => openEdit(org)}>
                      <Icon name="pencil" size={13} />
                    </IconButton>
                  )}
                </div>
                <GoalList
                  goals={productGoals.filter((g) => g.parent_goal_id === org.id)}
                  productById={productById}
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
                <GoalList goals={unparented} productById={productById} capsByGoal={capsByGoal} highlightStyle={highlightStyle} editButton={editButton} canWrite={canWrite} />
              </div>
            )}
          </div>
        </div>
      </div>
      )}

      {notice && (
        <div style={{ position: "fixed", right: 20, bottom: 20, zIndex: 200 }}>
          <Toast {...notice} onDismiss={() => setNotice(null)} />
        </div>
      )}

      <Dialog
        open={dialog != null}
        title={dialog?.mode === "new" ? "New goal" : `Edit ${dialog?.goal?.display_id ?? ""}`}
        onClose={() => setDialog(null)}
        footer={
          <>
            {dialog?.mode === "edit" && (
              <DeleteConfirm armed={confirmingDelete} onArm={armDelete} onCancel={() => setConfirmingDelete(false)} onConfirm={remove} disabled={saving}
                label="Delete" confirmLabel={"Delete goal"} style={{ marginRight: "auto" }} />
            )}
            {/* While a delete is armed, Keep is the one way back: Cancel would do the same, and Save is another act. */}
            {!confirmingDelete && <>
              <Button size="sm" variant="secondary" onClick={() => setDialog(null)}>Cancel</Button>
              <Button size="sm" variant="accent" disabled={saving || !draft.title.trim() || needsParent} onClick={save}>
                {dialog?.mode === "new" ? "Create goal" : "Save"}
              </Button>
            </>}
          </>
        }
      >
        {dialog?.mode === "edit" && confirmingDelete && (
          <DeleteWhat goal={dialog.goal} effects={deleteEffects(dialog.goal, goals ?? [], capsByGoal, products)} />
        )}
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

// Shown while a delete is armed: every row the delete removes or changes, by name.
function DeleteWhat({ goal, effects: { capabilities, products, children } }) {
  const list = { margin: 0, paddingLeft: 18, maxHeight: 160, overflowY: "auto", display: "flex", flexDirection: "column", gap: 2 };
  const nothing = capabilities.length === 0 && products.length === 0 && children.length === 0;
  return (
    <div role="note" style={{ marginBottom: 14, padding: 12, border: "1px solid var(--border-default)", borderRadius: "var(--radius-sm)", display: "flex", flexDirection: "column", gap: 8, fontSize: "var(--text-sm)", color: "var(--text-body)" }}>
      {nothing && <div>No capability, product or goal is linked to {goal.display_id}, so the delete removes only the goal.</div>}
      {capabilities.length > 0 && <>
        <div>Deleting {goal.display_id} also removes its links to {count(capabilities.length, "capability", "capabilities")}:</div>
        <ul style={list}>{capabilities.map((c) => <li key={c.id}>{c.name}</li>)}</ul>
      </>}
      {products.length > 0 && (
        <div>{andList(products.map((p) => p.name))} {products.length === 1 ? "has" : "have"} it as {products.length === 1 ? "its" : "their"} goal, and will have none.</div>
      )}
      {children.length > 0 && <>
        <div>{children.length === 1 ? "This product goal stays" : `These ${children.length} product goals stay`}, no longer under an org goal:</div>
        <ul style={list}>{children.map((g) => <li key={g.id}>{g.display_id} {g.title}</li>)}</ul>
      </>}
      {!nothing && <div style={{ color: "var(--text-secondary)" }}>The capabilities, products and other goals stay.</div>}
    </div>
  );
}

function GoalList({ goals, productById, capsByGoal, highlightStyle, editButton, emptyText, canWrite }) {
  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "16px 0 10px", fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", letterSpacing: "var(--tracking-caps)", textTransform: "uppercase", color: "var(--text-secondary)" }}>
        <span style={{ width: 14, height: 1, background: "var(--ink-3)" }} />product goals · {goals.length}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {goals.map((g) => {
          const owner = productById[g.product_id];
          const caps = capsByGoal[g.id] || [];
          return (
            <div key={g.id} id={`goal-${g.id}`} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 14, background: "var(--surface-card)", border: "1px solid var(--border-hairline)", borderRadius: "var(--radius-md)", boxShadow: "var(--shadow-card)", padding: "14px 18px", ...highlightStyle(g.id) }}>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-secondary)", width: 46 }}>{g.display_id}</span>
              <div style={{ flex: "1 1 220px", minWidth: 0 }}>
                <div style={{ fontSize: "var(--text-md)", fontWeight: "var(--weight-semibold)", color: "var(--text-heading)" }}>{g.title}</div>
                {owner && (
                  <div style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)", marginTop: 2 }}>
                    For <a href={`/products?product=${owner.id}`}>{owner.name}</a>
                  </div>
                )}
                {g.description && (
                  <div style={{ fontSize: "var(--text-sm)", color: "var(--text-body)", marginTop: 2 }}>{g.description}</div>
                )}
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
                        <a key={c.id} href={`/capabilities/${c.slug}`}>
                          {c.name}
                          {c.need !== "ours" && <span title={NEED[c.need].hint} style={{ color: "var(--text-secondary)" }}> ({NEED[c.need].label})</span>}
                          {i < caps.length - 1 ? "," : ""}
                        </a>
                      ))}
                    </>
                  )}
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginLeft: "auto" }}>
                {g.priority != null && <PriorityBadge priority={g.priority} rationale={PRIORITY_HINT} />}
                <StatusBadge status={g.status} />
                {editButton(g)}
              </div>
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
