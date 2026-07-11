import React from "react";
import { PageHeader } from "../shell/PageHeader.jsx";
import { Badge, Button, Dialog, Icon, Input, PriorityBadge, Select, StatusBadge } from "../../ds";
import { api } from "../../lib/api.js";

export default function GoalsIsland() {
  const [goals, setGoals] = React.useState([]);
  const [productCounts, setProductCounts] = React.useState({});
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [draft, setDraft] = React.useState({ goal_type: "product", title: "", success_criteria: "", priority: "3" });
  const [saving, setSaving] = React.useState(false);
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

  const save = async () => {
    if (!draft.title.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await api("/goals", {
        method: "POST",
        body: {
          goal_type: draft.goal_type,
          title: draft.title.trim(),
          success_criteria: draft.success_criteria.trim() || null,
          priority: draft.goal_type === "product" ? Number(draft.priority) : null,
          parent_goal_id: draft.goal_type === "product" && org ? org.id : null,
        },
      });
      setDialogOpen(false);
      setDraft({ goal_type: "product", title: "", success_criteria: "", priority: "3" });
      await load();
    } catch (e) {
      setError(String(e.message));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Goals"
        meta={`${org ? 1 : 0} org · ${productGoals.length} product`}
        actions={
          <Button size="sm" variant="accent" style={{ gap: 6 }} onClick={() => setDialogOpen(true)}>
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
        open={dialogOpen}
        title="New goal"
        onClose={() => setDialogOpen(false)}
        footer={
          <>
            <Button size="sm" variant="secondary" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button size="sm" variant="accent" disabled={saving || !draft.title.trim()} onClick={save}>Create goal</Button>
          </>
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Select
            label="Type"
            value={draft.goal_type}
            onChange={(e) => setDraft({ ...draft, goal_type: e.target.value })}
            options={[
              { value: "product", label: "Product goal" },
              { value: "org", label: "Org goal" },
            ]}
          />
          <Input
            label="Title"
            value={draft.title}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            placeholder="Ship PM export to 3 trackers"
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
        </div>
      </Dialog>
    </>
  );
}
