import React from "react";
import { PageHeader } from "../shell/PageHeader.jsx";
import { Badge, Button, Dialog, Icon, Input, Select } from "../../ds";
import { MaturityBadge } from "../shared/coverage.jsx";
import { Guesses } from "../shared/Guesses.jsx";
import { api } from "../../lib/api.js";
import { readParam, useParamRestore, writeParams } from "../../lib/url-state.js";
import { MATURITY, NEED, count, needKey } from "../../lib/words.js";

// Health finding kinds this page shows, in plain words, and where each links.
const FINDINGS = {
  empty_intent: { label: "Goal with no capabilities", tone: "neutral", hint: "This product goal links to no capability" },
  unmotivated_capability: { label: "No goal explains it", tone: "danger", hint: "No goal links to it or to anything under it" },
  aspirational_gap: { label: NEED.none.label, tone: NEED.none.tone, hint: "No feature builds it yet" },
  unlinked_feature: { label: "Feature with no capability", tone: "warn", hint: "It can't count toward reuse or coverage until it has one" },
  stale_map: { label: "Map may be out of date", tone: "warn", hint: "Not imported from its seed file in 30 days, or ever" },
};
// "never imported from a seed file." → "Never imported from a seed file."
const sentence = (text) => text.charAt(0).toUpperCase() + text.slice(1);
const VIEWS = [
  { value: "tree", label: "Tree" },
  { value: "reused", label: "Most reused" },
  { value: "attention", label: "Needs attention" },
];

const CAPS_HEADER = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-2xs)",
  letterSpacing: "var(--tracking-caps)",
  textTransform: "uppercase",
  color: "var(--text-secondary)",
};
const COLUMNS = "minmax(180px, 1fr) 110px 150px 100px";
const TABLE_MIN = 620; // the columns above, their gaps and the row padding

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
  const [deleted, setDeleted] = React.useState(null); // name a capability page just deleted
  const [guessCount, setGuessCount] = React.useState(0); // guesses still waiting for a decision
  const [near, setNear] = React.useState(null); // the typed name's exact match and near names
  // Narrower than the table's columns (a phone), each row stacks its counts
  // under its name instead of cutting them off.
  const [tableEl, setTableEl] = React.useState(null);
  const [narrow, setNarrow] = React.useState(false);

  // The view lives in the URL, so /capabilities?view=attention opens on it and Back returns.
  useParamRestore("view", (v) => setView(VIEWS.some((x) => x.value === v) ? v : "tree"));
  const changeView = (next) => {
    setView(next);
    writeParams({ view: next === "tree" ? "" : next }, { push: true });
  };
  React.useEffect(() => {
    if (!tableEl) return undefined;
    const observer = new ResizeObserver(() => setNarrow(tableEl.clientWidth < TABLE_MIN));
    observer.observe(tableEl);
    return () => observer.disconnect();
  }, [tableEl]);

  React.useEffect(() => {
    // The capability page sends you here after a delete; say so once.
    const name = readParam("deleted");
    if (name) {
      setDeleted(name);
      writeParams({ deleted: "" });
    }
    Promise.all([api("/capabilities/inventory"), api("/capabilities/health"), canWrite ? api("/guesses") : []])
      .then(([inv, health, guesses]) => {
        setInventory(inv);
        setFindings(health.filter((f) => FINDINGS[f.kind]));
        setGuessCount(guesses.length);
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

  // One row per thing: a capability can need attention for two reasons.
  const groups = React.useMemo(() => {
    const bySubject = new Map();
    for (const f of findings) {
      if (!bySubject.has(f.subject_id)) bySubject.set(f.subject_id, { ...f, kinds: [] });
      bySubject.get(f.subject_id).kinds.push(f);
    }
    return [...bySubject.values()];
  }, [findings]);
  const hasKind = (g, kind) => g.kinds.some((f) => f.kind === kind);
  const shownGroups = groups.filter(
    (g) => (!findingFilter || hasKind(g, findingFilter)) && (!q || g.subject_name.toLowerCase().includes(q)),
  );
  const attentionTotal = groups.length + guessCount;
  const filterOptions = [
    { value: "", label: `All (${attentionTotal})` },
    ...Object.entries(FINDINGS).map(([value, f]) => ({ value, label: `${f.label} (${groups.filter((g) => hasKind(g, value)).length})` })),
    ...(canWrite ? [{ value: "guesses", label: `Guessed links to review (${guessCount})` }] : []),
  ];
  const ours = all.filter((c) => c.ours).length;

  // Near names for the name being typed, so a duplicate is caught before it's made.
  React.useEffect(() => {
    const name = draft.name.trim();
    if (!dialogOpen || name.length < 3) {
      setNear(null);
      return undefined;
    }
    let live = true;
    const t = setTimeout(() => {
      api("/capabilities/coverage", { method: "POST", body: { features: [{ name: "new capability", capabilities: [name] }] } })
        .then((r) => {
          const need = r.features[0]?.capabilities[0];
          if (live) setNear(need ? { exact: need.match, candidates: need.candidates } : null);
        })
        .catch(() => { if (live) setNear(null); });
    }, 300);
    return () => { live = false; clearTimeout(t); };
  }, [draft.name, dialogOpen]);

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
      // Same name in another case: point at the one that exists, stay here.
      setDialogError(e.status === 409 && e.existing?.slug
        ? <>{e.detail}. <a href={`/capabilities/${e.existing.slug}`}>Open {e.existing.name}</a></>
        : String(e.message));
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
        meta={inventory ? `${count(all.length, "capability", "capabilities")} · ${ours} ours` : "loading"}
        actions={
          canWrite && (
            <Button size="sm" variant="accent" style={{ gap: 6 }} onClick={openNew}>
              <Icon name="plus" size={13} />New capability
            </Button>
          )
        }
      />
      {error && <div style={{ padding: "8px 24px", fontSize: "var(--text-sm)", color: "var(--danger-fg)" }}>{error}</div>}
      {deleted && <div role="status" style={{ padding: "8px 24px 0", fontSize: "var(--text-sm)", color: "var(--ok-fg)" }}>Deleted {deleted}.</div>}
      <div style={{ flex: 1, overflowY: "auto", padding: 20, display: "flex", flexDirection: "column", gap: 12, minHeight: 0 }}>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <input type="search" value={find} onChange={(e) => setFind(e.target.value)}
            placeholder={all.length ? `Find among ${count(all.length, "capability", "capabilities")}` : "Find a capability"} aria-label="Find a capability"
            style={{ flex: "1 1 240px", height: 32, padding: "0 10px", fontSize: "var(--text-sm)", fontFamily: "var(--font-body)", color: "var(--text-body)", background: "var(--surface-card)", border: "1px solid var(--border-control)", borderRadius: "var(--radius-sm)" }} />
          <div role="group" aria-label="View" style={{ display: "inline-flex", border: "1px solid var(--border-control)", borderRadius: "var(--radius-sm)", overflow: "hidden" }}>
            {VIEWS.map((v, i) => (
              <button key={v.value} type="button" aria-pressed={view === v.value} onClick={() => changeView(v.value)}
                style={{ height: 30, padding: "0 12px", font: "inherit", fontSize: "var(--text-xs)", cursor: "pointer", border: "none",
                  borderLeft: i ? "1px solid var(--border-control)" : "none",
                  background: view === v.value ? "var(--accent-wash)" : "var(--surface-card)",
                  color: view === v.value ? "var(--text-accent)" : "var(--text-body)" }}>
                {v.label}{v.value === "attention" && inventory ? ` · ${attentionTotal}` : ""}
              </button>
            ))}
          </div>
          {view === "attention" && attentionTotal > 0 && (
            <div style={{ minWidth: 220 }}>
              <Select aria-label="Filter findings" value={findingFilter} onChange={(e) => setFindingFilter(e.target.value)} options={filterOptions} />
            </div>
          )}
        </div>

        {view === "attention" ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {findingFilter !== "guesses" && !(groups.length === 0 && guessCount > 0) && (
              <FindingList groups={shownGroups} total={groups.length} byId={byId} loaded={inventory != null} />
            )}
            {canWrite && (!findingFilter || findingFilter === "guesses") && (
              <Guesses query={{}} name="both" title="Guessed links to review" onCount={setGuessCount} />
            )}
          </div>
        ) : (
          <div ref={setTableEl} style={{ background: "var(--surface-card)", border: "1px solid var(--border-hairline)", borderRadius: "var(--radius-md)", overflowX: narrow ? "visible" : "auto" }}>
           <div style={{ minWidth: narrow ? 0 : TABLE_MIN }}>
            {!narrow && (
              <div style={{ display: "grid", gridTemplateColumns: COLUMNS, gap: 12, padding: "8px 16px", borderBottom: "1px solid var(--border-hairline)", ...CAPS_HEADER }}>
                <span>Capability</span><span>Maturity</span><span>Products</span><span>Our features</span>
              </div>
            )}
            {shown.map((c, i) => <CapabilityRow key={c.id} c={c} last={i === shown.length - 1} compact={narrow} />)}
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
          </div>
        )}
      </div>

      <Dialog
        open={dialogOpen}
        title="New capability"
        onClose={() => setDialogOpen(false)}
        footer={
          <>
            {!draft.name.trim() && <span style={{ marginRight: "auto", alignSelf: "center", fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>Give it a name to create it.</span>}
            <Button size="sm" variant="secondary" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button size="sm" variant="accent" disabled={saving || !draft.name.trim() || Boolean(near?.exact)} onClick={create}>Create capability</Button>
          </>
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {dialogError && <div role="alert" style={{ fontSize: "var(--text-sm)", color: "var(--danger-fg)" }}>{dialogError}</div>}
          <Input label="Name" hint="A noun phrase, e.g. Route planning" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          {near?.exact && (
            <div role="status" style={{ fontSize: "var(--text-xs)", color: "var(--text-body)" }}>
              Already exists: <a href={`/capabilities/${near.exact.slug}`}>{near.exact.name}</a>. Open it instead.
            </div>
          )}
          {!near?.exact && near?.candidates?.length > 0 && (
            <div role="status" style={{ fontSize: "var(--text-xs)", color: "var(--text-body)" }}>
              Similar names in use:{" "}
              {near.candidates.map((c, i) => (
                <React.Fragment key={c.id}>{i > 0 && ", "}<a href={`/capabilities/${c.slug}`}>{c.name}</a></React.Fragment>
              ))}. If one is the same thing, open it instead.
            </div>
          )}
          <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={{ fontSize: "var(--text-xs)", fontWeight: "var(--weight-medium)", color: "var(--text-heading)" }}>Description</span>
            <textarea rows={3} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              style={{ padding: "8px 10px", fontSize: "var(--text-sm)", fontFamily: "var(--font-body)", color: "var(--text-heading)", background: "var(--surface-card)", border: "1px solid var(--border-control)", borderRadius: "var(--radius-sm)", resize: "vertical" }} />
          </label>
          <Select label="Part of" value={draft.parentId} onChange={(e) => setDraft({ ...draft, parentId: e.target.value })} options={parentOptions} />
          <Select label="Maturity" value={draft.maturity} onChange={(e) => setDraft({ ...draft, maturity: e.target.value })}
            options={Object.entries(MATURITY).map(([value, label]) => ({ value, label }))} />
        </div>
      </Dialog>
    </>
  );
}

function CapabilityRow({ c, last, compact }) {
  const theirs = c.external_products;
  const badge = c.ours ? <MaturityBadge maturity={c.maturity} /> : <span title={NEED[needKey(c)].hint}><Badge tone={NEED[needKey(c)].tone}>{NEED[needKey(c)].label}</Badge></span>;
  if (compact) {
    // Phone: the name and its badge, then the counts the table's columns hold.
    return (
      <a href={`/capabilities/${c.slug}`}
        style={{ display: "flex", flexDirection: "column", gap: 4, padding: "10px 16px", textDecoration: "none", color: "inherit",
          borderBottom: last ? "none" : "1px solid var(--border-hairline)", fontSize: "var(--text-sm)" }}>
        <span style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", paddingLeft: c.depth * 12 }}>
          <span style={{ color: "var(--text-heading)", fontWeight: "var(--weight-medium)", overflowWrap: "anywhere" }}>{c.name}</span>
          {badge}
        </span>
        <span style={{ paddingLeft: c.depth * 12, fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>
          <span title={c.products.map((p) => p.name).join(", ") || undefined}>in {count(c.products.length, "product")}</span>
          {theirs.length > 0 && <span title={theirs.map((p) => p.name).join(", ")}> +{theirs.length} not ours</span>}
          {` · ${count(c.features, "feature")} of ours`}
        </span>
      </a>
    );
  }
  return (
    <a href={`/capabilities/${c.slug}`}
      style={{ display: "grid", gridTemplateColumns: COLUMNS, gap: 12, alignItems: "center", padding: "10px 16px", textDecoration: "none", color: "inherit",
        borderBottom: last ? "none" : "1px solid var(--border-hairline)", fontSize: "var(--text-sm)" }}>
      <span style={{ display: "flex", alignItems: "center", gap: 8, paddingLeft: c.depth * 18, minWidth: 0 }}>
        <Icon name="layers" size={13} style={{ color: "var(--text-secondary)", flex: "none" }} />
        <span style={{ color: "var(--text-heading)", fontWeight: "var(--weight-medium)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</span>
      </span>
      <span>{badge}</span>
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

function FindingList({ groups: findings, total, byId, loaded }) {
  const box = { background: "var(--surface-card)", border: "1px solid var(--border-hairline)", borderRadius: "var(--radius-md)", overflow: "hidden" };
  const note = { padding: 16, fontSize: "var(--text-sm)", color: "var(--text-secondary)" };
  if (!loaded) return <div style={box}><div style={note}>Loading…</div></div>;
  if (total === 0) return <div style={box}><div style={note}>Nothing needs attention.</div></div>;
  if (findings.length === 0) return <div style={box}><div style={note}>No finding matches.</div></div>;
  return (
    <div style={box}>
      {findings.map((f, i) => {
        const capability = byId.get(f.subject_id);
        const href = f.kind === "empty_intent" ? `/goals?goal=${f.subject_id}`
          : f.kind === "unlinked_feature" ? `/features?feature=${f.subject_id}`
          : f.kind === "stale_map" ? `/products?product=${f.subject_id}`
          : capability ? `/capabilities/${capability.slug}` : null;
        const label = f.subject_display_id ? `${f.subject_display_id} ${f.subject_name}` : f.subject_name;
        const Tag = href ? "a" : "div";
        return (
          <Tag key={`${f.kind}-${f.subject_id}`} href={href ?? undefined}
            style={{ display: "flex", flexDirection: "column", gap: 4, padding: "10px 16px", textDecoration: "none", color: "inherit",
              borderBottom: i < findings.length - 1 ? "1px solid var(--border-hairline)" : "none" }}>
            {/* The name on its own line, then what's wrong: the same at every width and length. */}
            <span style={{ fontSize: "var(--text-sm)", fontWeight: "var(--weight-medium)", color: "var(--text-heading)", overflowWrap: "anywhere" }}>{label}</span>
            <span style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              {f.kinds.map((k) => <Badge key={k.kind} tone={FINDINGS[k.kind].tone}>{FINDINGS[k.kind].label}</Badge>)}
              <span style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>
                {f.kinds.map((k) => (k.kind === "stale_map" ? sentence(k.detail) : FINDINGS[k.kind].hint)).join(" · ")}
              </span>
            </span>
          </Tag>
        );
      })}
    </div>
  );
}
