import React from "react";
import { PageHeader } from "../shell/PageHeader.jsx";
import { Badge, Button, Dialog, Icon, Input, Select } from "../../ds";
import { MaturityBadge } from "../shared/coverage.jsx";
import { api } from "../../lib/api.js";
import { MATURITY, count } from "../../lib/words.js";

// Health finding kinds this page shows, in plain words, and where each links.
const FINDINGS = {
  empty_intent: { label: "Goal with no capabilities", tone: "neutral", hint: "This product goal links to no capability" },
  unmotivated_capability: { label: "No goal explains it", tone: "danger", hint: "No goal links to it or to anything under it" },
  aspirational_gap: { label: "Wanted but nothing builds it", tone: "warn", hint: "None of our features builds it yet" },
  unlinked_feature: { label: "Feature with no capability", tone: "warn", hint: "It can't count toward reuse or coverage until it has one" },
};
const FINDING_FILTERS = [
  { value: "", label: "All findings" },
  ...Object.entries(FINDINGS).map(([value, f]) => ({ value, label: f.label })),
];
const VIEWS = [
  { value: "tree", label: "Tree" },
  { value: "reused", label: "Most reused" },
  { value: "attention", label: "Needs attention" },
];

const CAPS_HEADER = {
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  letterSpacing: "var(--tracking-caps)",
  textTransform: "uppercase",
  color: "var(--text-secondary)",
};
const COLUMNS = "1fr 110px 150px 100px";

// Inventory entries → depth-first rows, siblings in creation order.
function treeRows(entries) {
  const byParent = new Map();
  for (const e of [...entries].sort((a, b) => a.seq - b.seq)) {
    const key = e.parent_id ?? null;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(e);
  }
  const out = [];
  const walk = (parentId, depth) => {
    for (const e of byParent.get(parentId) ?? []) {
      out.push({ ...e, depth });
      walk(e.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

const EMPTY_DRAFT = { name: "", description: "", parentId: "", maturity: "planned" };

export default function CapabilitiesIsland({ canWrite = true }) {
  const [inventory, setInventory] = React.useState(null); // null until the first load finishes
  const [findings, setFindings] = React.useState([]);
  const [error, setError] = React.useState(null);
  const [view, setView] = React.useState("tree");
  const [findingFilter, setFindingFilter] = React.useState("");
  const [find, setFind] = React.useState("");
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [draft, setDraft] = React.useState(EMPTY_DRAFT);
  const [saving, setSaving] = React.useState(false);
  const [dialogError, setDialogError] = React.useState(null);

  React.useEffect(() => {
    Promise.all([api("/capabilities/inventory"), api("/capabilities/health")])
      .then(([inv, health]) => {
        setInventory(inv);
        setFindings(health.filter((f) => FINDINGS[f.kind]));
      })
      .catch((e) => setError(String(e.message)));
  }, []);

  const all = inventory ?? [];
  const rows = React.useMemo(() => treeRows(all), [inventory]);
  const byId = React.useMemo(() => new Map(all.map((c) => [c.id, c])), [inventory]);
  const q = find.trim().toLowerCase();

  // Tree: a match keeps its ancestors so the tree still reads as a tree.
  const shown = React.useMemo(() => {
    if (view === "reused") {
      return all
        .filter((c) => !q || c.name.toLowerCase().includes(q))
        .sort((a, b) => b.products.length - a.products.length || b.features - a.features || a.name.localeCompare(b.name))
        .map((c) => ({ ...c, depth: 0 }));
    }
    if (!q) return rows;
    const keep = new Set();
    for (const c of rows) {
      if (!c.name.toLowerCase().includes(q)) continue;
      for (let cur = c; cur; cur = byId.get(cur.parent_id)) keep.add(cur.id);
    }
    return rows.filter((c) => keep.has(c.id));
  }, [view, rows, byId, q, inventory]);

  const shownFindings = findings.filter(
    (f) => (!findingFilter || f.kind === findingFilter) && (!q || f.subject_name.toLowerCase().includes(q)),
  );

  const openNew = () => {
    setDraft(EMPTY_DRAFT);
    setDialogError(null);
    setDialogOpen(true);
  };

  const create = async () => {
    if (!draft.name.trim()) return;
    setSaving(true);
    setDialogError(null);
    try {
      const created = await api("/capabilities", {
        method: "POST",
        body: {
          name: draft.name.trim(),
          description: draft.description.trim() || null,
          parent_id: draft.parentId || null,
          maturity: draft.maturity,
        },
      });
      window.location.href = `/capabilities/${created.slug}`;
    } catch (e) {
      setDialogError(String(e.message));
      setSaving(false);
    }
  };

  const parentOptions = [
    { value: "", label: "None (top level)" },
    ...rows.map((c) => ({ value: c.id, label: `${"   ".repeat(c.depth)}${c.name}` })),
  ];

  return (
    <>
      <PageHeader
        title="Capabilities"
        meta={inventory ? count(all.length, "capability", "capabilities") : "loading"}
        actions={
          canWrite && (
            <Button size="sm" variant="accent" style={{ gap: 6 }} onClick={openNew}>
              <Icon name="plus" size={13} />New capability
            </Button>
          )
        }
      />
      {error && <div style={{ padding: "8px 24px", fontSize: "var(--text-sm)", color: "var(--danger-fg)" }}>{error}</div>}
      <div style={{ flex: 1, overflowY: "auto", padding: 20, display: "flex", flexDirection: "column", gap: 12, minHeight: 0 }}>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <input type="search" value={find} onChange={(e) => setFind(e.target.value)}
            placeholder={`Find among ${all.length || ""} capabilities`} aria-label="Find a capability"
            style={{ flex: "1 1 240px", height: 32, padding: "0 10px", fontSize: "var(--text-sm)", fontFamily: "var(--font-body)", color: "var(--text-body)", background: "var(--surface-card)", border: "1px solid var(--border-control)", borderRadius: "var(--radius-sm)" }} />
          <div role="group" aria-label="View" style={{ display: "inline-flex", border: "1px solid var(--border-control)", borderRadius: "var(--radius-sm)", overflow: "hidden" }}>
            {VIEWS.map((v, i) => (
              <button key={v.value} type="button" aria-pressed={view === v.value} onClick={() => setView(v.value)}
                style={{ height: 30, padding: "0 12px", font: "inherit", fontSize: "var(--text-xs)", cursor: "pointer", border: "none",
                  borderLeft: i ? "1px solid var(--border-control)" : "none",
                  background: view === v.value ? "var(--accent-wash)" : "var(--surface-card)",
                  color: view === v.value ? "var(--text-accent)" : "var(--text-body)" }}>
                {v.label}{v.value === "attention" && inventory ? ` · ${findings.length}` : ""}
              </button>
            ))}
          </div>
          {view === "attention" && findings.length > 0 && (
            <div style={{ minWidth: 220 }}>
              <Select aria-label="Filter findings" value={findingFilter} onChange={(e) => setFindingFilter(e.target.value)} options={FINDING_FILTERS} />
            </div>
          )}
        </div>

        {view === "attention" ? (
          <FindingList findings={shownFindings} total={findings.length} byId={byId} loaded={inventory != null} />
        ) : (
          <div style={{ background: "var(--surface-card)", border: "1px solid var(--border-hairline)", borderRadius: "var(--radius-md)", overflow: "hidden" }}>
            <div style={{ display: "grid", gridTemplateColumns: COLUMNS, gap: 12, padding: "8px 16px", borderBottom: "1px solid var(--border-hairline)", ...CAPS_HEADER }}>
              <span>Capability</span><span>Maturity</span><span>Products</span><span>Our features</span>
            </div>
            {shown.map((c, i) => <CapabilityRow key={c.id} c={c} last={i === shown.length - 1} />)}
            {inventory && all.length > 0 && shown.length === 0 && (
              <div style={{ padding: 16, fontSize: "var(--text-sm)", color: "var(--text-secondary)" }}>No capability matches "{find.trim()}".</div>
            )}
            {all.length === 0 && (
              <div style={{ padding: 16, fontSize: "var(--text-sm)", color: "var(--text-secondary)" }}>
                {inventory
                  ? canWrite
                    ? "No capabilities yet. Add the first one with New capability."
                    : "No capabilities yet. An editor or admin can add them."
                  : error ? "Couldn't load capabilities." : "Loading capabilities…"}
              </div>
            )}
          </div>
        )}
      </div>

      <Dialog
        open={dialogOpen}
        title="New capability"
        onClose={() => setDialogOpen(false)}
        footer={
          <>
            <Button size="sm" variant="secondary" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button size="sm" variant="accent" disabled={saving || !draft.name.trim()} onClick={create}>Create capability</Button>
          </>
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {dialogError && <div role="alert" style={{ fontSize: "var(--text-sm)", color: "var(--danger-fg)" }}>{dialogError}</div>}
          <Input label="Name" hint="A noun phrase, e.g. Route planning" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          <Input label="Description" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
          <Select label="Part of" value={draft.parentId} onChange={(e) => setDraft({ ...draft, parentId: e.target.value })} options={parentOptions} />
          <Select label="Maturity" value={draft.maturity} onChange={(e) => setDraft({ ...draft, maturity: e.target.value })}
            options={Object.entries(MATURITY).map(([value, label]) => ({ value, label }))} />
        </div>
      </Dialog>
    </>
  );
}

function CapabilityRow({ c, last }) {
  const theirs = c.external_products;
  return (
    <a href={`/capabilities/${c.slug}`}
      style={{ display: "grid", gridTemplateColumns: COLUMNS, gap: 12, alignItems: "center", padding: "10px 16px", textDecoration: "none", color: "inherit",
        borderBottom: last ? "none" : "1px solid var(--border-hairline)", fontSize: "var(--text-sm)" }}>
      <span style={{ display: "flex", alignItems: "center", gap: 8, paddingLeft: c.depth * 18, minWidth: 0 }}>
        <Icon name="layers" size={13} style={{ color: "var(--text-secondary)", flex: "none" }} />
        <span style={{ color: "var(--text-heading)", fontWeight: "var(--weight-medium)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</span>
      </span>
      <span><MaturityBadge maturity={c.maturity} /></span>
      <span style={{ display: "flex", gap: 8, alignItems: "baseline", minWidth: 0 }}>
        <span title={c.products.map((p) => p.name).join(", ") || undefined} style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-heading)" }}>
          {c.products.length}
        </span>
        {theirs.length > 0 && (
          <span title={theirs.map((p) => p.name).join(", ")} style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)", whiteSpace: "nowrap" }}>
            +{theirs.length} not ours
          </span>
        )}
      </span>
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-heading)" }}>{c.features}</span>
    </a>
  );
}

function FindingList({ findings, total, byId, loaded }) {
  const box = { background: "var(--surface-card)", border: "1px solid var(--border-hairline)", borderRadius: "var(--radius-md)", overflow: "hidden" };
  const note = { padding: 16, fontSize: "var(--text-sm)", color: "var(--text-secondary)" };
  if (!loaded) return <div style={box}><div style={note}>Loading…</div></div>;
  if (total === 0) return <div style={box}><div style={note}>Nothing needs attention.</div></div>;
  if (findings.length === 0) return <div style={box}><div style={note}>No finding matches.</div></div>;
  return (
    <div style={box}>
      {findings.map((f, i) => {
        const kind = FINDINGS[f.kind];
        const capability = byId.get(f.subject_id);
        const href = f.kind === "empty_intent" ? `/goals?goal=${f.subject_id}`
          : f.kind === "unlinked_feature" ? `/features?feature=${f.subject_id}`
          : capability ? `/capabilities/${capability.slug}` : null;
        const label = f.subject_display_id ? `${f.subject_display_id} ${f.subject_name}` : f.subject_name;
        const Tag = href ? "a" : "div";
        return (
          <Tag key={`${f.kind}-${f.subject_id}`} href={href ?? undefined}
            style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "10px 16px", textDecoration: "none", color: "inherit",
              borderBottom: i < findings.length - 1 ? "1px solid var(--border-hairline)" : "none" }}>
            <Badge tone={kind.tone}>{kind.label}</Badge>
            <span style={{ fontSize: "var(--text-sm)", fontWeight: "var(--weight-medium)", color: "var(--text-heading)" }}>{label}</span>
            <span style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>{kind.hint}</span>
          </Tag>
        );
      })}
    </div>
  );
}
