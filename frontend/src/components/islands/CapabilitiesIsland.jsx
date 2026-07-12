import React from "react";
import { PageHeader } from "../shell/PageHeader.jsx";
import { Badge, Button, Dialog, Icon, IconButton, Input, Select, Tag } from "../../ds";
import { api } from "../../lib/api.js";

const MATURITY_TONES = {
  planned: "neutral",
  alpha: "warn",
  beta: "accent",
  ga: "ok",
  deprecated: "danger",
  retired: "danger",
};
const MATURITIES = ["planned", "alpha", "beta", "ga", "deprecated", "retired"];

const CAPS_HEADER = {
  fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "var(--tracking-caps)",
  textTransform: "uppercase", color: "var(--text-disabled)",
};

function flatten(nodes, depth = 0, out = []) {
  for (const n of nodes) {
    out.push({ ...n, depth });
    flatten(n.children ?? [], depth + 1, out);
  }
  return out;
}

function subtreeIds(node, out = new Set()) {
  out.add(node.id);
  for (const c of node.children ?? []) subtreeIds(c, out);
  return out;
}

const EMPTY_DRAFT = { name: "", description: "", parentId: "", maturity: "planned" };

export default function CapabilitiesIsland() {
  const [tree, setTree] = React.useState([]);
  const [goals, setGoals] = React.useState([]);
  const [selected, setSelected] = React.useState(null);
  const [motivations, setMotivations] = React.useState([]);
  const [dialog, setDialog] = React.useState(null); // null | {mode:"new"} | {mode:"edit"}
  const [draft, setDraft] = React.useState(EMPTY_DRAFT);
  const [saving, setSaving] = React.useState(false);
  const [confirmingDelete, setConfirmingDelete] = React.useState(false);
  const [dialogError, setDialogError] = React.useState(null);
  const [error, setError] = React.useState(null);

  const flat = React.useMemo(() => flatten(tree), [tree]);
  const detail = flat.find((c) => c.id === selected) ?? null;

  const load = React.useCallback(async () => {
    const [map, goalList] = await Promise.all([api("/capabilities/map"), api("/goals")]);
    setTree(map);
    setGoals(goalList);
    const ids = new Set(flatten(map).map((c) => c.id));
    setSelected((sel) => (sel && ids.has(sel) ? sel : (flatten(map)[0]?.id ?? null)));
  }, []);

  React.useEffect(() => {
    load().catch((e) => setError(String(e.message)));
  }, [load]);

  const loadMotivations = React.useCallback(async (id) => {
    if (!id) {
      setMotivations([]);
      return;
    }
    setMotivations(await api(`/capabilities/${id}/motivations`));
  }, []);

  React.useEffect(() => {
    loadMotivations(selected).catch(() => setMotivations([]));
  }, [selected, loadMotivations]);

  const openNew = () => {
    setDraft({ ...EMPTY_DRAFT, parentId: detail?.id ?? "" });
    setDialogError(null);
    setConfirmingDelete(false);
    setDialog({ mode: "new" });
  };

  const openEdit = () => {
    if (!detail) return;
    setDraft({
      name: detail.name,
      description: detail.description ?? "",
      parentId: detail.parent_id ?? "",
      maturity: detail.maturity,
    });
    setDialogError(null);
    setConfirmingDelete(false);
    setDialog({ mode: "edit" });
  };

  const save = async () => {
    if (!draft.name.trim()) return;
    setSaving(true);
    setDialogError(null);
    const body = {
      name: draft.name.trim(),
      description: draft.description.trim() || null,
      parent_id: draft.parentId || null,
      maturity: draft.maturity,
    };
    try {
      if (dialog.mode === "new") {
        const created = await api("/capabilities", { method: "POST", body });
        await load();
        setSelected(created.id);
      } else {
        await api(`/capabilities/${detail.id}`, { method: "PATCH", body });
        await load();
      }
      setDialog(null);
    } catch (e) {
      setDialogError(String(e.message));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setSaving(true);
    setDialogError(null);
    try {
      await api(`/capabilities/${detail.id}`, { method: "DELETE" });
      setDialog(null);
      setSelected(null);
      await load();
    } catch (e) {
      setDialogError(String(e.message));
      setConfirmingDelete(false);
    } finally {
      setSaving(false);
    }
  };

  const addMotivation = async (goalId) => {
    setError(null);
    try {
      await api(`/capabilities/${selected}/motivations`, { method: "POST", body: { goal_id: goalId } });
      await loadMotivations(selected);
    } catch (e) {
      setError(String(e.message));
    }
  };

  const removeMotivation = async (goalId) => {
    setError(null);
    try {
      await api(`/capabilities/${selected}/motivations/${goalId}`, { method: "DELETE" });
      await loadMotivations(selected);
    } catch (e) {
      setError(String(e.message));
    }
  };

  // Re-parenting onto yourself or your own subtree is a containment cycle.
  const parentOptions = React.useMemo(() => {
    const excluded = dialog?.mode === "edit" && detail ? subtreeIds(detail) : new Set();
    return [
      { value: "", label: "None (top-level)" },
      ...flat.filter((c) => !excluded.has(c.id)).map((c) => ({ value: c.id, label: `${"— ".repeat(c.depth)}${c.name}` })),
    ];
  }, [flat, dialog, detail]);

  const motivationIds = new Set(motivations.map((g) => g.id));
  const addableGoals = goals.filter((g) => !motivationIds.has(g.id));

  return (
    <>
      <PageHeader
        title="Capabilities"
        meta={`${flat.length} capabilities · containment map`}
        actions={
          <Button size="sm" variant="accent" style={{ gap: 6 }} onClick={openNew}>
            <Icon name="plus" size={13} />New capability
          </Button>
        }
      />
      {error && <div style={{ padding: "8px 24px", fontSize: "var(--text-sm)", color: "var(--danger-fg)" }}>{error}</div>}
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        <div style={{ flex: 1, overflowY: "auto", margin: 20, minWidth: 0 }}>
          <div style={{ background: "var(--surface-card)", border: "1px solid var(--border-hairline)", borderRadius: "var(--radius-md)", overflow: "hidden" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 90px 110px", padding: "8px 16px", borderBottom: "1px solid var(--border-hairline)", ...CAPS_HEADER }}>
              <span>Capability</span><span>Scope</span><span>Maturity</span>
            </div>
            {flat.map((c, i) => (
              <div key={c.id} onClick={() => setSelected(c.id)}
                style={{ display: "grid", gridTemplateColumns: "1fr 90px 110px", alignItems: "center", padding: "10px 16px",
                  borderBottom: i < flat.length - 1 ? "1px solid var(--border-hairline)" : "none", cursor: "pointer", fontSize: "var(--text-sm)",
                  background: c.id === selected ? "var(--surface-inset)" : "transparent" }}>
                <span style={{ display: "flex", alignItems: "center", gap: 8, paddingLeft: c.depth * 18, minWidth: 0 }}>
                  <Icon name="layers" size={13} style={{ color: c.id === selected ? "var(--text-accent)" : "var(--text-disabled)" }} />
                  <span style={{ color: "var(--text-heading)", fontWeight: "var(--weight-medium)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</span>
                </span>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-secondary)" }}>
                  {c.rollup.done}/{c.rollup.total}
                </span>
                <span><Badge tone={MATURITY_TONES[c.maturity] ?? "neutral"}>{c.maturity}</Badge></span>
              </div>
            ))}
            {flat.length === 0 && (
              <div style={{ padding: 16, fontSize: "var(--text-sm)", color: "var(--text-disabled)" }}>
                No capabilities yet. Create one to start the map.
              </div>
            )}
          </div>
        </div>
        <aside style={{ width: 300, flex: "none", margin: "20px 20px 20px 0", background: "var(--surface-card)", border: "1px solid var(--border-hairline)", borderRadius: "var(--radius-md)", padding: 16, display: "flex", flexDirection: "column", gap: 12, overflowY: "auto" }}>
          {detail ? (
            <>
              <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                <div style={{ flex: 1, fontSize: "var(--text-md)", fontWeight: "var(--weight-semibold)", color: "var(--text-heading)" }}>{detail.name}</div>
                <IconButton size="sm" label="Edit capability" onClick={openEdit}><Icon name="pencil" size={13} /></IconButton>
              </div>
              {detail.description && (
                <div style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)", lineHeight: "var(--leading-snug)" }}>{detail.description}</div>
              )}
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <Badge tone={MATURITY_TONES[detail.maturity] ?? "neutral"}>{detail.maturity}</Badge>
                {Object.entries(detail.facets ?? {}).map(([k, v]) => (
                  <Tag key={k}>{k}: {v}</Tag>
                ))}
              </div>
              {detail.parent_id && flat.find((c) => c.id === detail.parent_id) && (
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-secondary)" }}>
                  PART_OF → {flat.find((c) => c.id === detail.parent_id).name}
                </div>
              )}
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-secondary)" }}>
                scope {detail.rollup.done} done · {detail.rollup.in_progress} in progress · {detail.rollup.pending} pending
              </div>
              <div style={{ borderTop: "1px solid var(--border-hairline)", paddingTop: 12, display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={CAPS_HEADER}>Motivated by</div>
                {motivations.map((g) => (
                  <div key={g.id} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-secondary)", flex: "none" }}>{g.display_id}</span>
                    <span style={{ fontSize: "var(--text-xs)", color: "var(--text-body)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{g.title}</span>
                    <IconButton size="sm" label="Remove motivation" onClick={() => removeMotivation(g.id)}><Icon name="x" size={12} /></IconButton>
                  </div>
                ))}
                {motivations.length === 0 && (
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-disabled)" }}>no motivating goals</div>
                )}
                {addableGoals.length > 0 && (
                  <Select value="" onChange={(e) => e.target.value && addMotivation(e.target.value)}
                    options={[{ value: "", label: "Link a goal…" },
                      ...addableGoals.map((g) => ({ value: g.id, label: `${g.display_id} ${g.title}` }))]} />
                )}
              </div>
            </>
          ) : (
            <div style={{ fontSize: "var(--text-sm)", color: "var(--text-disabled)" }}>Select a capability.</div>
          )}
        </aside>
      </div>

      <Dialog
        open={dialog != null}
        title={dialog?.mode === "new" ? "New capability" : `Edit ${detail?.name ?? ""}`}
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
            <Button size="sm" variant="accent" disabled={saving || !draft.name.trim()} onClick={save}>
              {dialog?.mode === "new" ? "Create capability" : "Save"}
            </Button>
          </>
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {dialogError && <div style={{ fontSize: "var(--text-sm)", color: "var(--danger-fg)" }}>{dialogError}</div>}
          <Input label="Name (a system quality, noun phrase)" value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="PM tracker export" />
          <Input label="Description" value={draft.description}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
          <Select label="Part of" value={draft.parentId}
            onChange={(e) => setDraft({ ...draft, parentId: e.target.value })} options={parentOptions} />
          <Select label="Maturity" value={draft.maturity}
            onChange={(e) => setDraft({ ...draft, maturity: e.target.value })} options={MATURITIES} />
        </div>
      </Dialog>
    </>
  );
}
