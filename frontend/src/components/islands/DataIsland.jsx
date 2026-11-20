import React from "react";
import { PageHeader } from "../shell/PageHeader.jsx";
import { Badge, Button, Checkbox, Dialog, Icon, IconButton, Input, Select, Tabs, Tag, Toast, DeleteConfirm } from "../../ds";
import { api } from "../../lib/api.js";
import { ENTITIES, REF_SOURCES, shortId } from "../../lib/data-entities.js";
import { count } from "../../lib/words.js";

const TH = {
  fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "var(--tracking-caps)",
  textTransform: "uppercase", color: "var(--text-secondary)",
};
const CELL = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-body)" };
const CELL_MONO = { ...CELL, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-secondary)" };
const MUTED = { fontSize: "var(--text-sm)", color: "var(--text-secondary)" };
// The API's table labels are plural ("Goals", "Stories"): "1 goal", "2 stories".
const tally = (t) => count(t.count, t.label.replace(/ies$/, "y").replace(/s$/, "").toLowerCase(), t.label.toLowerCase());
const EMPTY_REFS = Object.fromEntries(
  Object.keys(REF_SOURCES).map((k) => [k, { list: [], byId: new Map() }]),
);

export default function DataIsland() {
  const [tab, setTab] = React.useState(ENTITIES[0].key);
  const [rows, setRows] = React.useState([]);
  const [counts, setCounts] = React.useState({});
  const [refs, setRefs] = React.useState(EMPTY_REFS);
  const [selected, setSelected] = React.useState(() => new Set());
  const [dialog, setDialog] = React.useState(null); // null | {mode:"new"} | {mode:"edit", row}
  const [draft, setDraft] = React.useState({});
  const [preview, setPreview] = React.useState(null); // {loading} | {data} | {error}
  const [banner, setBanner] = React.useState(null);
  const [toast, setToast] = React.useState(null);
  const [dialogError, setDialogError] = React.useState(null);
  const [saving, setSaving] = React.useState(false);
  const [confirming, setConfirming] = React.useState(false);

  const ent = ENTITIES.find((e) => e.key === tab);

  const loadRefs = React.useCallback(async () => {
    const keys = Object.keys(REF_SOURCES);
    const lists = await Promise.all(keys.map((k) => api(REF_SOURCES[k])));
    setRefs(Object.fromEntries(
      keys.map((k, i) => [k, { list: lists[i], byId: new Map(lists[i].map((r) => [r.id, r])) }]),
    ));
  }, []);

  const loadRows = React.useCallback(async (key) => {
    const e = ENTITIES.find((x) => x.key === key);
    const data = await api(e.listPath);
    setRows(data);
    setCounts((c) => ({ ...c, [key]: data.length }));
  }, []);

  // Every tab's count, so the tab bar shows where the junk is without having to
  // click through all eight.
  const loadCounts = React.useCallback(async () => {
    const lists = await Promise.all(
      ENTITIES.map((e) => api(e.listPath).catch(() => null)),
    );
    setCounts(Object.fromEntries(
      ENTITIES.map((e, i) => [e.key, lists[i]?.length]).filter(([, n]) => n != null),
    ));
  }, []);

  const reload = React.useCallback(
    async (key) => Promise.all([loadRows(key), loadRefs(), loadCounts()]),
    [loadRows, loadRefs, loadCounts],
  );

  React.useEffect(() => {
    reload(tab).catch((e) => setBanner(`Could not load ${tab}: ${e.message}`));
  }, [tab, reload]);

  // A selection is scoped to one table — carrying ids across tabs would arm a
  // bulk delete against the wrong entity.
  React.useEffect(() => { setSelected(new Set()); }, [tab]);

  // Drop ids that no longer exist, so a retry after a failure is armed against
  // exactly the survivors.
  React.useEffect(() => {
    setSelected((s) => {
      if (s.size === 0) return s;
      const live = new Set(rows.map((r) => r.id));
      const next = new Set([...s].filter((id) => live.has(id)));
      return next.size === s.size ? s : next;
    });
  }, [rows]);

  React.useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  const cols = React.useMemo(
    () => `32px ${ent.columns.map((c) => c.width).join(" ")} 40px`,
    [ent],
  );

  const allSelected = rows.length > 0 && selected.size === rows.length;

  const toggle = (id) =>
    setSelected((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const fieldsFor = (mode) =>
    ent.fields.filter((f) => mode === "new" || !f.createOnly);

  const openNew = () => {
    setDraft({ ...ent.emptyDraft });
    setDialogError(null);
    setConfirming(false);
    setDialog({ mode: "new" });
  };

  const openEdit = (row) => {
    if (!ent.editable) return;
    setDraft(ent.toDraft(row));
    setDialogError(null);
    setConfirming(false);
    setDialog({ mode: "edit", row });
  };

  const save = async () => {
    const missing = fieldsFor(dialog.mode).filter(
      (f) => f.required && !(f.requiredUnless && draft[f.requiredUnless]) && !String(draft[f.key] ?? "").trim(),
    );
    if (missing.length) {
      setDialogError(`Required: ${missing.map((f) => f.label).join(", ")}`);
      return;
    }
    // Link rows carry a unique constraint on their two ids — catch it here
    // rather than spending a round trip to be told.
    if (dialog.mode === "new" && ent.duplicateOf) {
      const clash = rows.some((r) => ent.duplicateOf.every((k) => r[k] === draft[k]));
      if (clash) {
        setDialogError(`That ${ent.singular} already exists.`);
        return;
      }
    }
    setSaving(true);
    setDialogError(null);
    try {
      if (dialog.mode === "new") {
        await api(ent.createPath(draft), { method: "POST", body: ent.createBody(draft) });
      } else {
        await api(ent.patchPath(dialog.row), {
          method: "PATCH",
          body: ent.patchBody(draft, dialog.row),
        });
      }
      await reload(tab);
      setDialog(null);
    } catch (e) {
      setDialogError(String(e.detail?.message ?? e.message));
    } finally {
      setSaving(false);
    }
  };

  const removeOne = async () => {
    setSaving(true);
    setDialogError(null);
    try {
      await api(ent.deletePath(dialog.row), { method: "DELETE" });
      await reload(tab);
      setDialog(null);
    } catch (e) {
      setDialogError(String(e.message));
      setConfirming(false); // don't leave the arm hot on a row that refused
    } finally {
      setSaving(false);
    }
  };

  const cascadeBody = () => ({
    rows: [...selected].map((id) => ({ entity: ent.key, id })),
  });

  const openPreview = async () => {
    setPreview({ loading: true });
    setConfirming(false);
    try {
      const data = await api("/admin/data/cascade-preview", {
        method: "POST",
        body: cascadeBody(),
      });
      setPreview({ data });
    } catch (e) {
      setPreview({ error: String(e.message) });
    }
  };

  const runBulkDelete = async () => {
    setSaving(true);
    const body = cascadeBody(); // same body the preview was computed from
    try {
      const result = await api("/admin/data/cascade-delete", { method: "POST", body });
      setPreview(null);
      setSelected(new Set());
      setToast({
        tone: "ok",
        title: `Deleted ${count(result.total, "row")}`,
        detail: result.deleted.map(tally).join(", "),
      });
    } catch (e) {
      setPreview(null);
      setBanner(`Delete failed, so nothing was removed. ${e.message}`);
    } finally {
      setSaving(false);
      setConfirming(false);
      // Unconditional, and load-bearing: nothing re-validates a preview against
      // changes made between preview and confirm, so re-reading is the only
      // trustworthy answer to what is in the database now.
      await reload(tab).catch(() => setBanner("Reload failed. Refresh the page."));
    }
  };

  const previewData = preview?.data;

  return (
    <>
      <PageHeader
        title="Raw data"
        meta="Every record, for fixing data by hand"
        actions={
          <Button size="sm" variant="accent" style={{ gap: 6 }} onClick={openNew}>
            <Icon name="plus" size={13} />New {ent.singular}
          </Button>
        }
      />
      <div style={{ padding: "12px 24px 0", flex: "none" }}>
        <Tabs
          tabs={ENTITIES.map((e) => ({ value: e.key, label: e.label, count: counts[e.key] }))}
          value={tab}
          onChange={setTab}
        />
      </div>
      {banner && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 24px", fontSize: "var(--text-sm)", color: "var(--danger-fg)" }}>
          <span style={{ flex: 1 }}>{banner}</span>
          <IconButton size="sm" label="Dismiss" onClick={() => setBanner(null)}>
            <Icon name="x" size={12} />
          </IconButton>
        </div>
      )}

      <div style={{ flex: 1, overflowY: "auto", margin: 20, minWidth: 0 }}>
        {selected.size > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, padding: "8px 16px", background: "var(--surface-card)", border: "1px solid var(--border-hairline)", borderRadius: "var(--radius-md)" }}>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-secondary)" }}>
              {selected.size} of {rows.length} selected
            </span>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button>
            <span style={{ flex: 1 }} />
            <Button size="sm" variant="danger" style={{ gap: 6 }} onClick={openPreview}>
              <Icon name="trash" size={13} />
              Delete {selected.size} {selected.size === 1 ? ent.singular : ent.label.toLowerCase()}
            </Button>
          </div>
        )}

        <div style={{ background: "var(--surface-card)", border: "1px solid var(--border-hairline)", borderRadius: "var(--radius-md)", overflow: "hidden" }}>
          <div style={{ display: "grid", gridTemplateColumns: cols, alignItems: "center", gap: 8, padding: "8px 16px", borderBottom: "1px solid var(--border-hairline)", ...TH }}>
            <Checkbox
              aria-label={allSelected ? "Deselect all rows" : "Select all rows"}
              checked={allSelected}
              onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)))}
            />
            {ent.columns.map((c) => <span key={c.key}>{c.label}</span>)}
            <span />
          </div>
          {rows.map((row, i) => (
            <div
              key={row.id}
              onClick={() => openEdit(row)}
              style={{
                display: "grid", gridTemplateColumns: cols, alignItems: "center", gap: 8,
                padding: "10px 16px", fontSize: "var(--text-sm)",
                borderBottom: i < rows.length - 1 ? "1px solid var(--border-hairline)" : "none",
                cursor: ent.editable ? "pointer" : "default",
                background: selected.has(row.id) ? "var(--accent-wash)" : "transparent",
              }}
            >
              <span onClick={(e) => e.stopPropagation()}>
                <Checkbox aria-label={`Select ${ent.title?.(row) ?? row.name ?? row.title ?? "row"}`} checked={selected.has(row.id)} onChange={() => toggle(row.id)} />
              </span>
              {ent.columns.map((c) => {
                const value = c.render(row, refs);
                const tone = c.tone?.(row, refs);
                const raw = c.raw?.(row);
                return (
                  <span key={c.key} style={c.mono ? CELL_MONO : CELL}
                    data-raw={raw ?? undefined}
                    title={raw != null && String(raw) !== String(value) ? String(raw) : undefined}>
                    {tone ? <Badge tone={tone}>{value}</Badge> : (value ?? "—")}
                  </span>
                );
              })}
              {ent.editable ? (
                <IconButton size="sm" label={`Edit ${ent.singular}`}
                  onClick={(e) => { e.stopPropagation(); openEdit(row); }}>
                  <Icon name="pencil" size={13} />
                </IconButton>
              ) : <span />}
            </div>
          ))}
          {rows.length === 0 && (
            <div style={{ padding: 16, ...MUTED }}>No {ent.label.toLowerCase()} yet. Add one with New {ent.singular} above.</div>
          )}
        </div>
      </div>

      {/* Create / edit / single delete — all through the domain endpoints. */}
      <Dialog
        open={dialog != null}
        title={dialog?.mode === "new" ? `New ${ent.singular}` : `Edit ${ent.singular}`}
        width="560px"
        onClose={() => setDialog(null)}
        footer={
          <>
            {dialog?.mode === "edit" && (
              <DeleteConfirm armed={confirming} onArm={() => setConfirming(true)} onCancel={() => setConfirming(false)} onConfirm={removeOne} disabled={saving}
                label="Delete" confirmLabel={"Delete row"} style={{ marginRight: "auto" }} />
            )}
            <Button size="sm" variant="secondary" onClick={() => setDialog(null)}>Cancel</Button>
            <Button size="sm" variant="accent" disabled={saving} onClick={save}>
              {dialog?.mode === "new" ? `Create ${ent.singular}` : "Save"}
            </Button>
          </>
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {dialogError && (
            <div style={{ fontSize: "var(--text-sm)", color: "var(--danger-fg)" }}>{dialogError}</div>
          )}
          {dialog && fieldsFor(dialog.mode).map((field) => (
            <Field key={field.key} field={field} refs={refs} value={draft[field.key] ?? ""}
              onChange={(v) => setDraft((d) => ({ ...d, [field.key]: v }))} />
          ))}
        </div>
      </Dialog>

      {/* Cascade preview — the whole point of the bulk path. */}
      <Dialog
        open={preview != null}
        title={`Delete ${selected.size} ${selected.size === 1 ? ent.singular : ent.label.toLowerCase()}?`}
        width="600px"
        onClose={() => setPreview(null)}
        footer={
          <>
            <DeleteConfirm armed={confirming} onArm={() => setConfirming(true)} onCancel={() => setConfirming(false)} onConfirm={runBulkDelete}
              disabled={saving || !previewData} label="Delete"
              confirmLabel={`Delete ${count(previewData?.total_rows ?? 0, "row")}`} style={{ marginRight: "auto" }} />
            <Button size="sm" variant="secondary" onClick={() => setPreview(null)}>Cancel</Button>
          </>
        }
      >
        {preview?.loading && <div style={MUTED}>Computing dependents…</div>}
        {preview?.error && (
          <div style={{ fontSize: "var(--text-sm)", color: "var(--danger-fg)" }}>{preview.error}</div>
        )}
        {previewData && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {/* Every row that goes, by name where it has one; link rows are counted. */}
            <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 200, overflowY: "auto", fontSize: "var(--text-sm)", color: "var(--text-body)", lineHeight: "var(--leading-snug)" }}>
              <div style={TH}>Deletes {count(previewData.total_rows, "row")}</div>
              {previewData.total_deletes.map((t) => (
                <div key={t.table}>
                  <b style={{ fontWeight: "var(--weight-medium)", color: "var(--text-heading)" }}>{tally(t)}</b>
                  {t.names?.length > 0 && <>: {t.names.join(", ")}</>}
                </div>
              ))}
            </div>
            {previewData.warnings.map((w, i) => (
              <div key={i} style={{ fontSize: "var(--text-xs)", color: "var(--warn-fg, var(--text-secondary))" }}>{w}</div>
            ))}

            {/* Label above its tags, not beside them: the collateral would
                otherwise squeeze the name down to an ellipsis. */}
            <div style={{ border: "1px solid var(--border-hairline)", borderRadius: "var(--radius-md)", maxHeight: 240, overflowY: "auto" }}>
              {previewData.rows.map((r, i) => (
                <div key={r.id} style={{ display: "flex", flexDirection: "column", gap: 6, padding: "8px 12px", borderBottom: i < previewData.rows.length - 1 ? "1px solid var(--border-hairline)" : "none" }}>
                  <span style={{ ...CELL, fontSize: "var(--text-sm)", color: "var(--text-heading)" }}>
                    {r.missing ? `${shortId(r.id)} (already gone)` : r.label}
                  </span>
                  <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {r.deletes.map((t) => <Tag key={t.table}>{tally(t)}</Tag>)}
                    {r.deletes.length === 0 && !r.missing && <span style={MUTED}>no dependents</span>}
                  </span>
                </div>
              ))}
            </div>

            {previewData.total_detaches.length > 0 && (
              <div style={{ borderTop: "1px solid var(--border-hairline)", paddingTop: 12, display: "flex", flexDirection: "column", gap: 4 }}>
                <div style={TH}>Kept, but unlinked</div>
                {previewData.total_detaches.map((t) => (
                  <div key={t.table} style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>
                    {tally(t)}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </Dialog>

      {toast && (
        <div style={{ position: "fixed", right: 20, bottom: 20, zIndex: 200 }}>
          <Toast {...toast} onDismiss={() => setToast(null)} />
        </div>
      )}
    </>
  );
}

function Field({ field, refs, value, onChange }) {
  if (field.type === "checkbox") {
    return <Checkbox label={field.label} checked={!!value} onChange={onChange} />;
  }
  if (field.type === "multiselect") {
    const chosen = new Set(value ?? []);
    const toggle = (id, on) => onChange(on ? [...(value ?? []), id] : (value ?? []).filter((x) => x !== id));
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span style={TH}>{field.label} · {chosen.size} selected</span>
        <div style={{ maxHeight: 180, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6, padding: "8px 10px", border: "1px solid var(--border-default)", borderRadius: "var(--radius-md)" }}>
          {(refs[field.optionsFrom]?.list ?? []).map((r) => (
            <Checkbox key={r.id} label={field.optionLabel(r)} checked={chosen.has(r.id)} onChange={(on) => toggle(r.id, on)} />
          ))}
        </div>
      </div>
    );
  }
  if (field.type === "select") {
    const options = field.optionsFrom
      ? (refs[field.optionsFrom]?.list ?? []).map((r) => ({
          value: r.id, label: field.optionLabel(r),
        }))
      : field.options.map((o) => (typeof o === "string" ? { value: o, label: o } : o));
    return (
      <Select label={field.label} value={value}
        options={field.nullable ? [{ value: "", label: "—" }, ...options] : options}
        onChange={(e) => onChange(e.target.value)} />
    );
  }
  if (field.type === "textarea") {
    // No DS primitive; matches Input's label treatment and ProductsIsland's box.
    return (
      <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span style={TH}>{field.label}</span>
        <textarea rows={3} value={value} onChange={(e) => onChange(e.target.value)}
          style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)", color: "var(--text-body)", background: "var(--surface-input, var(--surface-card))", border: "1px solid var(--border-default)", borderRadius: "var(--radius-md)", padding: "8px 10px", resize: "vertical" }} />
      </label>
    );
  }
  return (
    <Input label={field.label} type={field.type === "number" ? "number" : "text"}
      value={value} onChange={(e) => onChange(e.target.value)} />
  );
}
