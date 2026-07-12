import React from "react";
import { PageHeader } from "../shell/PageHeader.jsx";
import { Badge, Button, Dialog, Icon, IconButton, Input, PriorityBadge, Select, StatusBadge } from "../../ds";
import { api } from "../../lib/api.js";

const EMPTY_DRAFT = { goal_type: "product", title: "", description: "", success_criteria: "", priority: "3", status: "pending" };

export default function GoalsIsland() {
  const [goals, setGoals] = React.useState([]);
  const [productCounts, setProductCounts] = React.useState({});
  const [dialog, setDialog] = React.useState(null); // null | {mode:"new"} | {mode:"edit", goal}
  const [draft, setDraft] = React.useState(EMPTY_DRAFT);
  const [saving, setSaving] = React.useState(false);
  const [confirmingDelete, setConfirmingDelete] = React.useState(false);
  const [error, setError] = React.useState(null);

  const load = React.useCallback(async () => {
    const [goalList, products] = await Promise.all([api("/goals"), api("/products")]);
    setGoals(goalList);
    const counts = {};
    for (const p of products) {
      if (p.goal_id) counts[p.goal_id] = (counts[p.goal_id] || 0) + 1;
    }
    setProductCounts(counts);
  }, []);

  React.useEffect(() => {
    load().catch((e) => setError(String(e.message)));
  }, [load]);

  const org = goals.find((g) => g.goal_type === "org");
  const productGoals = goals.filter((g) => g.goal_type === "product");

  const openNew = () => {
    setDraft(EMPTY_DRAFT);
    setConfirmingDelete(false);
    setDialog({ mode: "new" });
  };

  const openEdit = (goal) => {
    setDraft({
      goal_type: goal.goal_type,
      title: goal.title,
      description: goal.description ?? "",
      success_criteria: goal.success_criteria ?? "",
      priority: goal.priority != null ? String(goal.priority) : "3",
      status: goal.status,
    });
    setConfirmingDelete(false);
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
            parent_goal_id: draft.goal_type === "product" && org ? org.id : null,
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

  const editButton = (goal) => (
    <IconButton size="sm" label="Edit goal"
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); openEdit(goal); }}>
      <Icon name="pencil" size={13} />
    </IconButton>
  );

  return (
    <>
      <PageHeader
        title="Goals"
        meta={`${org ? 1 : 0} org · ${productGoals.length} product`}
        actions={
          <Button size="sm" variant="accent" style={{ gap: 6 }} onClick={openNew}>
            <Icon name="plus" size={13} />New goal
          </Button>
        }
      />
      <div style={{ flex: 1, overflowY: "auto", padding: 24 }}>
        <div style={{ maxWidth: 760 }}>
          {error && (
            <div style={{ marginBottom: 12, fontSize: "var(--text-sm)", color: "var(--danger-fg)" }}>{error}</div>
          )}
          {org ? (
            <div style={{ background: "var(--surface-inverse)", borderRadius: "var(--radius-lg)", padding: "20px 24px", display: "flex", alignItems: "center", gap: 16 }}>
              <Icon name="target" size={20} style={{ color: "var(--aegean-4)" }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "var(--tracking-caps)", textTransform: "uppercase", color: "var(--aegean-4)" }}>org goal</div>
                <div style={{ fontFamily: "var(--font-display)", fontSize: "var(--text-xl)", fontWeight: "var(--weight-semibold)", color: "var(--text-inverse)", letterSpacing: "var(--tracking-tight)" }}>{org.title}</div>
              </div>
              <StatusBadge status={org.status} />
              <IconButton size="sm" label="Edit goal" style={{ color: "var(--aegean-4)" }}
                onClick={() => openEdit(org)}>
                <Icon name="pencil" size={13} />
              </IconButton>
            </div>
          ) : (
            <div style={{ border: "1px dashed var(--border-default)", borderRadius: "var(--radius-lg)", padding: "20px 24px", color: "var(--text-disabled)", fontSize: "var(--text-sm)" }}>
              No org goal yet. Create one to anchor the pipeline.
            </div>
          )}
          <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "16px 0 10px", fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "var(--tracking-caps)", textTransform: "uppercase", color: "var(--text-disabled)" }}>
            <span style={{ width: 14, height: 1, background: "var(--ink-3)" }} />product goals
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {productGoals.map((g) => {
              const specs = productCounts[g.id] || 0;
              return (
                <a key={g.id} href="/products" style={{ textDecoration: "none", display: "flex", alignItems: "center", gap: 14, background: "var(--surface-card)", border: "1px solid var(--border-hairline)", borderRadius: "var(--radius-md)", boxShadow: "var(--shadow-card)", padding: "14px 18px", cursor: "pointer" }}>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-secondary)", width: 46 }}>{g.display_id}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: "var(--text-md)", fontWeight: "var(--weight-semibold)", color: "var(--text-heading)" }}>{g.title}</div>
                    {g.success_criteria && (
                      <div style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)", marginTop: 2 }}>Success: {g.success_criteria}</div>
                    )}
                  </div>
                  {g.priority != null && <PriorityBadge priority={g.priority} />}
                  {specs > 0 && <Badge tone="accent">{specs} spec{specs > 1 ? "s" : ""}</Badge>}
                  <StatusBadge status={g.status} />
                  {editButton(g)}
                  <Icon name="chevron-right" size={14} style={{ color: "var(--text-disabled)" }} />
                </a>
              );
            })}
            {productGoals.length === 0 && (
              <div style={{ border: "1px dashed var(--border-default)", borderRadius: "var(--radius-md)", padding: "16px 18px", color: "var(--text-disabled)", fontSize: "var(--text-sm)" }}>
                No product goals yet.
              </div>
            )}
          </div>
        </div>
      </div>

      <Dialog
        open={dialog != null}
        title={dialog?.mode === "new" ? "New goal" : `Edit ${dialog?.goal?.display_id ?? ""}`}
        onClose={() => setDialog(null)}
        footer={
          <>
            {dialog?.mode === "edit" && (
              <Button size="sm" variant={confirmingDelete ? "danger" : "secondary"} disabled={saving}
                style={{ marginRight: "auto", gap: 6 }}
                onClick={() => (confirmingDelete ? remove() : setConfirmingDelete(true))}>
                <Icon name="trash" size={13} />{confirmingDelete ? "Confirm delete" : "Delete"}
              </Button>
            )}
            <Button size="sm" variant="secondary" onClick={() => setDialog(null)}>Cancel</Button>
            <Button size="sm" variant="accent" disabled={saving || !draft.title.trim()} onClick={save}>
              {dialog?.mode === "new" ? "Create goal" : "Save"}
            </Button>
          </>
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
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
              label="Priority (1 hottest)"
              value={draft.priority}
              onChange={(e) => setDraft({ ...draft, priority: e.target.value })}
              options={["1", "2", "3", "4", "5"]}
            />
          )}
          {dialog?.mode === "edit" && (
            <Select
              label="Status"
              value={draft.status}
              onChange={(e) => setDraft({ ...draft, status: e.target.value })}
              options={["pending", "in_progress", "done"]}
            />
          )}
        </div>
      </Dialog>
    </>
  );
}
