import React from "react";
import { PageHeader } from "../shell/PageHeader.jsx";
import { Badge, Button, DeleteConfirm, Input } from "../../ds";
import { api } from "../../lib/api.js";
import { MATURITY, NEED, VERDICT, count, plain, statusLabel } from "../../lib/words.js";
import { readParam, useParamRestore, writeParams } from "../../lib/url-state.js";
import { CoverageReport } from "../shared/coverage.jsx";
import { CapabilityPicker } from "../shared/CapabilityPicker.jsx";

// A journey is an ordered path of features; an idea is a journey whose steps
// aren't built yet. The map draws the steps in order across the top and the
// capabilities they stand on below, so it shows at a glance which parts
// already exist (and in which product), which capabilities carry several
// steps, and where the path breaks.

const CAPS = {
  fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "var(--tracking-caps)",
  textTransform: "uppercase", color: "var(--text-secondary)",
};
const PANEL = {
  background: "var(--surface-card)", border: "1px solid var(--border-hairline)",
  borderRadius: "var(--radius-md)",
};

// Badge tones as raw tokens, for the SVG map where a Badge can't render.
const TONE = {
  neutral: { bg: "var(--surface-inset)", fg: "var(--text-secondary)" },
  accent: { bg: "var(--accent-wash)", fg: "var(--text-accent)" },
  ok: { bg: "var(--ok-bg)", fg: "var(--ok-fg)" },
  warn: { bg: "var(--warn-bg)", fg: "var(--warn-fg)" },
  danger: { bg: "var(--danger-bg)", fg: "var(--danger-fg)" },
};

// The analysis's step verdicts, in the shared VERDICT words.
const VERDICT_KEY = { buildable: "buildable", known_covered: "partly", missing: "missing", unknown: "unknown" };
const stepKind = (step) => (step.live ? "live" : VERDICT_KEY[step.verdict] ?? "unknown");
const needKind = (need) => (need.match ? (need.match.ours ? "ours" : "elsewhere") : "none");

const STEP_W = 176;
const STEP_H = 92;
const GAP = 44;
const CAP_H = 26;
const CAP_Y = STEP_H + 120;

export default function JourneysIsland({ canWrite }) {
  const [journeys, setJourneys] = React.useState(null);
  const [selected, setSelected] = React.useState(() => readParam("id"));
  const [analysis, setAnalysis] = React.useState(null);
  const [features, setFeatures] = React.useState([]);
  const [products, setProducts] = React.useState([]);
  const [editing, setEditing] = React.useState(null); // { base, draft } or null
  const [inventory, setInventory] = React.useState([]);
  const [error, setError] = React.useState(null);

  useParamRestore("id", (v) => v && setSelected(v));
  const select = (id) => { setSelected(id); writeParams({ id }, { push: true }); };

  const loadList = React.useCallback(async () => {
    const list = await api("/journeys");
    setJourneys(list);
    return list;
  }, []);

  React.useEffect(() => {
    loadList().catch((e) => setError(e.message));
    Promise.all([api("/features"), api("/products"), api("/capabilities/inventory")])
      .then(([f, p, inv]) => { setFeatures(f); setProducts(p); setInventory(inv); })
      .catch((e) => setError(e.message));
  }, [loadList]);

  // Default to the first one when nothing, or something gone, is selected.
  React.useEffect(() => {
    if (!journeys || (selected && journeys.some((j) => j.id === selected))) return;
    const first = journeys[0]?.id ?? null;
    setSelected(first);
    writeParams({ id: first });
  }, [journeys, selected]);

  React.useEffect(() => {
    setAnalysis(null);
    if (!selected || !journeys?.some((j) => j.id === selected)) return;
    let live = true; // a slow answer for the previous journey must not land on this one
    api(`/journeys/${selected}/analysis`)
      .then((a) => { if (live) setAnalysis(a); })
      .catch((e) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [selected, journeys]);

  const productById = React.useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  function startNew() {
    const base = { id: null, name: "", persona: "", description: "", steps: [] };
    setEditing({ base, draft: base });
  }

  // swap = { from, to }: open with that need swapped in every unbuilt step.
  function startEdit(swap) {
    const j = analysis.journey;
    const base = {
      id: j.id,
      name: j.name,
      persona: j.persona ?? "",
      description: j.description ?? "",
      steps: j.steps.map((s) => ({
        feature_id: s.feature_id,
        label: s.label,
        needs: [...s.needs],
        note: s.note ?? "",
      })),
    };
    const draft = !swap ? base : {
      ...base,
      steps: base.steps.map((s) => (s.feature_id ? s : {
        ...s, needs: [...new Set(s.needs.map((n) => (n.trim() === swap.from ? swap.to : n)))],
      })),
    };
    setEditing({ base, draft });
  }

  async function save(draft) {
    const body = {
      name: draft.name.trim(),
      persona: draft.persona.trim() || null,
      description: draft.description.trim() || null,
      steps: draft.steps.map((s) => ({
        feature_id: s.feature_id,
        label: s.label.trim() || null,
        needs: s.feature_id ? [] : s.needs,
        note: s.note.trim() || null,
      })),
    };
    const saved = draft.id
      ? await api(`/journeys/${draft.id}`, { method: "PATCH", body })
      : await api("/journeys", { method: "POST", body });
    setEditing(null);
    await loadList(); // reloads the analysis too
    if (saved.id !== selected) select(saved.id);
  }

  async function remove(id) {
    await api(`/journeys/${id}`, { method: "DELETE" });
    await loadList(); // the selection falls back to the first one
  }

  return (
    <>
      <PageHeader
        title="Ideas & journeys"
        meta={journeys ? `${journeys.length} saved` : "loading…"}
        actions={canWrite && !editing && <Button size="sm" variant="accent" onClick={startNew}>New idea or journey</Button>}
      />
      {error && <div style={{ padding: "8px 24px", color: "var(--danger-fg)", fontSize: "var(--text-xs)" }}>{error}</div>}
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "grid", gridTemplateColumns: "260px minmax(0,1fr)", gap: 16, padding: "16px 24px", alignItems: "start" }}>
        <JourneyList journeys={journeys} selected={selected} onSelect={select} />
        <div style={{ minWidth: 0 }}>
          {editing && (
            <JourneyEditor
              key={editing.base.id ?? "new"}
              base={editing.base}
              draft={editing.draft}
              features={features}
              productById={productById}
              inventory={inventory}
              onCancel={() => setEditing(null)}
              onSave={save}
            />
          )}
          {!editing && analysis && (
            <JourneyDetail
              key={analysis.journey.id}
              analysis={analysis}
              canWrite={canWrite}
              onEdit={startEdit}
              onDelete={remove}
              onError={setError}
            />
          )}
          {!editing && journeys && journeys.length === 0 && <EmptyState canWrite={canWrite} />}
        </div>
      </div>
    </>
  );
}

function EmptyState({ canWrite }) {
  return (
    <div style={{ ...PANEL, padding: 24, display: "flex", flexDirection: "column", gap: 10, fontSize: "var(--text-sm)", color: "var(--text-secondary)", maxWidth: 620 }}>
      <div style={{ color: "var(--text-heading)", fontWeight: "var(--weight-medium)" }}>No ideas or journeys yet</div>
      <div>
        A journey is the path a person takes through features: “import a route, see the climb’s
        weather, pace it, pack the food”. An idea is a journey whose steps aren’t built yet.
        Steps can come from any product, ours or someone else’s, and a step nobody has built
        names the capabilities it would need. Metis then shows which steps are live today, which
        are buildable from what we have, and what’s missing.
      </div>
      {canWrite ? (
        <div>
          To make one, use the idea check on <a href="/home" style={{ color: "var(--text-accent)" }}>Home</a>:
          name the idea, pick the capabilities it needs, Check, then Save as idea.
          A coding agent with the metis plugin can propose some with <code>metis-what-next</code>:
          each comes with a link that opens Home’s idea check filled in, ready for you to save.
        </div>
      ) : (
        <div>
          Someone who can edit saves ideas from the idea check on <a href="/home" style={{ color: "var(--text-accent)" }}>Home</a>.
          You can check an idea there yourself; it just won’t be saved.
        </div>
      )}
    </div>
  );
}

function JourneyList({ journeys, selected, onSelect }) {
  return (
    <div style={{ ...PANEL, overflow: "hidden" }}>
      <div style={{ ...CAPS, padding: "10px 12px", borderBottom: "1px solid var(--border-hairline)" }}>Saved</div>
      {!journeys && <div style={{ padding: 12, fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>loading…</div>}
      {journeys?.length === 0 && <div style={{ padding: 12, fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>Nothing saved yet.</div>}
      {journeys?.map((j) => (
        <button key={j.id} onClick={() => onSelect(j.id)}
          style={{
            display: "block", width: "100%", textAlign: "left", padding: "10px 12px", border: "none",
            borderBottom: "1px solid var(--border-hairline)", cursor: "pointer",
            background: j.id === selected ? "var(--surface-hover)" : "transparent",
            fontFamily: "var(--font-body)",
          }}>
          <div style={{ fontSize: "var(--text-sm)", color: "var(--text-heading)", fontWeight: "var(--weight-medium)" }}>{j.name}</div>
          <div style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>
            {count(j.steps.length, "step")}{j.persona ? ` · ${j.persona}` : ""}
          </div>
        </button>
      ))}
    </div>
  );
}

/** "4 steps · 1 live · 2 buildable · 1 missing", in the shared verdict words. */
function Tally({ kinds }) {
  return (
    <div role="status" style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>
      <span>{count(kinds.length, "step")}</span>
      {Object.entries(VERDICT).map(([k, v]) => {
        const n = kinds.filter((x) => x === k).length;
        return n > 0 && (
          <span key={k} title={v.hint} style={{ display: "inline-flex", gap: 5, alignItems: "center" }}>
            <b style={{ color: "var(--text-heading)", fontFamily: "var(--font-mono)" }}>{n}</b>
            <Badge tone={v.tone}>{v.label}</Badge>
          </span>
        );
      })}
    </div>
  );
}

function JourneyDetail({ analysis, canWrite, onEdit, onDelete, onError }) {
  const { journey, steps, products, external_products: external, report } = analysis;
  const [confirmingDelete, setConfirmingDelete] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const confirmDelete = () => {
    setDeleting(true);
    onDelete(journey.id).catch((e) => { onError(e.message); setDeleting(false); });
  };
  const productLink = { textDecoration: "none" };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ ...PANEL, padding: 16, display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <div style={{ fontSize: "var(--text-lg)", color: "var(--text-heading)", fontWeight: "var(--weight-semibold)", flex: 1 }}>{journey.name}</div>
          {canWrite && <>
            {!confirmingDelete && <Button size="sm" variant="secondary" onClick={() => onEdit(null)}>Edit</Button>}
            <DeleteConfirm armed={confirmingDelete} onArm={() => setConfirmingDelete(true)} onCancel={() => setConfirmingDelete(false)}
              onConfirm={confirmDelete} disabled={deleting} label="Delete" confirmLabel="Delete journey" />
          </>}
        </div>
        {journey.persona && <div style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)" }}>For {journey.persona}</div>}
        {journey.description && <div style={{ fontSize: "var(--text-sm)", color: "var(--text-body)" }}>{journey.description}</div>}
        {steps.length > 0 && <Tally kinds={steps.map(stepKind)} />}
        {(products.length > 0 || external.length > 0) && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>
            <span>Passes through</span>
            {products.map((p) => <a key={p.id} href={`/products?product=${p.id}`} style={productLink}><Badge tone="accent">{p.name}</Badge></a>)}
            {external.map((p) => <a key={p.id} href={`/products?product=${p.id}`} style={productLink}><Badge tone="neutral">{p.name} (external)</Badge></a>)}
          </div>
        )}
      </div>

      {steps.length > 0 ? <JourneyMap steps={steps} /> : (
        <div style={{ ...PANEL, padding: 16, fontSize: "var(--text-sm)", color: "var(--text-secondary)" }}>No steps yet. Edit it to add some.</div>
      )}

      {report && (
        <div style={{ ...PANEL, overflow: "hidden" }}>
          <div style={{ ...CAPS, padding: "10px 16px" }}>What each step needs</div>
          <CoverageReport report={report} onCandidate={canWrite ? (from, to) => onEdit({ from, to }) : undefined} />
        </div>
      )}
    </div>
  );
}

/** Distinct capabilities across steps, each placed under the steps that use it. */
function layoutCapabilities(steps) {
  const caps = new Map();
  steps.forEach((s, i) => {
    for (const need of s.coverage?.capabilities ?? []) {
      const key = need.match?.id ?? `name:${need.name.toLowerCase()}`;
      if (!caps.has(key)) caps.set(key, { key, need, steps: [] });
      caps.get(key).steps.push(i);
    }
  });
  const list = [...caps.values()].map((c) => ({
    ...c,
    center: c.steps.reduce((a, i) => a + i, 0) / c.steps.length,
  }));
  list.sort((a, b) => a.center - b.center || b.steps.length - a.steps.length);
  return list;
}

const names = (refs) => refs.map((p) => p.name).join(", ");

/** "ours · in Atlas, Beacon · stable", in the shared need words. */
function capInfo(need) {
  const m = need.match;
  const kind = needKind(need);
  return [
    NEED[kind].label,
    kind === "ours" && m.products.length > 0 ? `in ${names(m.products)}` : null,
    kind === "elsewhere" ? `known from ${names(m.external_products)}` : null,
    kind === "ours" ? plain(MATURITY, m.maturity) : null,
  ].filter(Boolean).join(" · ");
}

function stepWhere(step) {
  const f = step.feature;
  if (!f) return "not built";
  const where = `${f.product ? f.product.name : "no product"}${f.external ? " (external)" : ""}`;
  return !f.external && !step.live ? `${where} · ${statusLabel(f.status)}` : where;
}

function JourneyMap({ steps }) {
  const [hover, setHover] = React.useState(null); // {kind:'step'|'cap', key}
  const caps = React.useMemo(() => layoutCapabilities(steps), [steps]);

  const stepX = (i) => 16 + i * (STEP_W + GAP);
  const stepsWidth = stepX(steps.length - 1) + STEP_W + 16;

  // Capability chips: packed left-to-right along the bottom, each as close as
  // it can get to the centre of the steps that use it.
  const placed = [];
  let cursor = 16;
  for (const c of caps) {
    const w = Math.min(200, 24 + c.need.name.length * 6.6);
    const ideal = stepX(c.center) + STEP_W / 2 - w / 2;
    const x = Math.max(cursor, ideal);
    placed.push({ ...c, x, w });
    cursor = x + w + 10;
  }
  const width = Math.max(stepsWidth, cursor + 6);
  const height = CAP_Y + CAP_H + 24;

  const active = (stepIdx, capKey) => {
    if (!hover) return true;
    if (hover.kind === "step") return stepIdx === hover.key || (capKey && placed.find((c) => c.key === capKey)?.steps.includes(hover.key));
    return capKey === hover.key || (stepIdx != null && placed.find((c) => c.key === hover.key)?.steps.includes(stepIdx));
  };

  const hoveredCap = hover?.kind === "cap" ? placed.find((c) => c.key === hover.key) : null;
  const hoveredStep = hover?.kind === "step" ? steps[hover.key] : null;
  const leave = () => setHover(null);

  return (
    <div style={{ ...PANEL, padding: "12px 0 4px" }}>
      <div style={{ ...CAPS, padding: "0 16px 6px" }}>Steps and the capabilities they need. Hover either to trace it, click to open it.</div>
      <div style={{ overflowX: "auto" }}>
        <svg width={width} height={height} style={{ display: "block", fontFamily: "var(--font-body)" }}>
          <defs>
            <marker id="jarrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
              <path d="M0,0 L10,5 L0,10 z" fill="var(--text-secondary)" />
            </marker>
          </defs>
          {/* path between steps */}
          {steps.slice(1).map((_, i) => (
            <line key={`a${i}`} x1={stepX(i) + STEP_W + 4} y1={STEP_H / 2} x2={stepX(i + 1) - 6} y2={STEP_H / 2}
              stroke="var(--text-secondary)" strokeWidth="1.5" markerEnd="url(#jarrow)" />
          ))}
          {/* step → capability links */}
          {placed.flatMap((c) => c.steps.map((i) => {
            const on = active(i, c.key);
            const kind = needKind(c.need);
            const x1 = stepX(i) + STEP_W / 2;
            const x2 = c.x + c.w / 2;
            return (
              <path key={`${c.key}-${i}`}
                d={`M${x1},${STEP_H} C${x1},${STEP_H + 60} ${x2},${CAP_Y - 60} ${x2},${CAP_Y}`}
                fill="none" stroke={on && hover ? TONE[NEED[kind].tone].fg : "var(--border-default)"}
                strokeWidth={on && hover ? 1.8 : 1} strokeDasharray={kind === "none" ? "3,3" : undefined}
                opacity={on ? 1 : 0.15} />
            );
          }))}
          {steps.map((s, i) => (
            <StepCard key={i} step={s} x={stepX(i)} dim={!active(i, null)}
              onEnter={() => setHover({ kind: "step", key: i })} onLeave={leave} />
          ))}
          {placed.map((c) => {
            const kind = needKind(c.need);
            const t = TONE[NEED[kind].tone];
            const on = active(null, c.key);
            const enter = () => setHover({ kind: "cap", key: c.key });
            const chip = (
              <g transform={`translate(${c.x},${CAP_Y})`} opacity={on ? 1 : 0.2}
                onMouseEnter={enter} onMouseLeave={leave} style={{ cursor: c.need.match ? "pointer" : "default" }}>
                <title>{`${c.need.match?.name ?? c.need.name}: ${capInfo(c.need)}`}</title>
                <rect width={c.w} height={CAP_H} rx={CAP_H / 2} fill={t.bg} stroke={t.fg}
                  strokeDasharray={kind === "none" ? "3,3" : undefined} />
                <text x={c.w / 2} y={CAP_H / 2 + 4} textAnchor="middle" fontSize="11" fill={t.fg}>
                  {truncate(c.need.match?.name ?? c.need.name, Math.floor((c.w - 16) / 6.4))}
                </text>
              </g>
            );
            return c.need.match
              ? <a key={c.key} href={`/capabilities/${c.need.match.slug}`} onFocus={enter} onBlur={leave}>{chip}</a>
              : <React.Fragment key={c.key}>{chip}</React.Fragment>;
          })}
        </svg>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 14, alignItems: "center", padding: "6px 16px 8px", fontSize: "var(--text-xs)", color: "var(--text-secondary)", minHeight: 22 }}>
        {hoveredCap && (
          <span>
            <b style={{ color: "var(--text-heading)" }}>{hoveredCap.need.match?.name ?? hoveredCap.need.name}</b>: {capInfo(hoveredCap.need)} · used by {count(hoveredCap.steps.length, "step")} here
          </span>
        )}
        {hoveredStep && (
          <span>
            <b style={{ color: "var(--text-heading)" }}>{hoveredStep.label}</b>: {stepWhere(hoveredStep)} · {VERDICT[stepKind(hoveredStep)].hint}
            {hoveredStep.note ? ` · ${hoveredStep.note}` : ""}
          </span>
        )}
        {!hover && Object.values(NEED).map((n) => (
          <span key={n.label} title={n.hint}><Badge tone={n.tone}>{n.label}</Badge></span>
        ))}
      </div>
    </div>
  );
}

function truncate(text, n) {
  return text.length > n ? `${text.slice(0, Math.max(1, n - 1))}…` : text;
}

function StepCard({ step, x, dim, onEnter, onLeave }) {
  const v = VERDICT[stepKind(step)];
  const t = TONE[v.tone];
  const f = step.feature;
  const where = stepWhere(step);
  const card = (
    <g transform={`translate(${x},0)`} opacity={dim ? 0.3 : 1} onMouseEnter={onEnter} onMouseLeave={onLeave}
      style={{ cursor: f ? "pointer" : "default" }}>
      <title>{`${step.label}\n${where}\n${v.label}: ${v.hint}${step.note ? `\n${step.note}` : ""}`}</title>
      <rect width={STEP_W} height={STEP_H} rx="8" fill="var(--surface-card)" stroke="var(--border-default)"
        strokeDasharray={f ? undefined : "4,3"} />
      <rect width="4" height={STEP_H - 16} x="0" y="8" rx="2" fill={t.fg} />
      <text x="14" y="18" fontSize="10" fill="var(--text-secondary)" fontFamily="var(--font-mono)">{String(step.position + 1).padStart(2, "0")}</text>
      <text x={STEP_W - 10} y="18" fontSize="10" textAnchor="end" fill={t.fg}>{v.label}</text>
      <foreignObject x="12" y="24" width={STEP_W - 22} height="40">
        <div xmlns="http://www.w3.org/1999/xhtml" style={{
          fontSize: 12, lineHeight: "16px", color: "var(--text-heading)", fontWeight: 500,
          overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
        }}>{step.label}</div>
      </foreignObject>
      <text x="14" y={STEP_H - 12} fontSize="10.5" fill="var(--text-secondary)">{truncate(where, 28)}</text>
    </g>
  );
  return f ? <a href={`/features?feature=${f.id}`} onFocus={onEnter} onBlur={onLeave}>{card}</a> : card;
}

// Mirrors the backend's slugify: step needs resolve by exact slug.
const slugify = (v) => v.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

// The analysis's rule, while composing: live, else by what its capabilities are.
function needsVerdict(entries, incomplete) {
  if (entries.length === 0) return "unknown";
  if (entries.some((e) => !e?.ours)) return "missing";
  return incomplete ? "partly" : "buildable";
}

function JourneyEditor({ base, draft: start, features, productById, inventory, onCancel, onSave }) {
  const [draft, setDraft] = React.useState(start);
  const [query, setQuery] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [confirmDiscard, setConfirmDiscard] = React.useState(false);
  const featureById = React.useMemo(() => new Map(features.map((f) => [f.id, f])), [features]);
  const byId = React.useMemo(() => new Map(inventory.map((c) => [c.id, c])), [inventory]);
  const bySlug = React.useMemo(() => new Map(inventory.map((c) => [c.slug, c])), [inventory]);
  const options = React.useMemo(() => inventory.map((c) => ({
    id: c.id, name: c.name, slug: c.slug, hint: NEED[c.ours ? "ours" : "elsewhere"].label,
  })), [inventory]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(base);

  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const setStep = (i, patch) => setDraft((d) => ({ ...d, steps: d.steps.map((s, k) => (k === i ? { ...s, ...patch } : s)) }));
  const move = (i, by) => setDraft((d) => {
    const steps = [...d.steps];
    const j = i + by;
    if (j < 0 || j >= steps.length) return d;
    [steps[i], steps[j]] = [steps[j], steps[i]];
    return { ...d, steps };
  });
  const drop = (i) => setDraft((d) => ({ ...d, steps: d.steps.filter((_, k) => k !== i) }));
  const addFeature = (f) => {
    setDraft((d) => ({ ...d, steps: [...d.steps, { feature_id: f.id, label: f.name, needs: [], note: "" }] }));
    setQuery("");
  };
  const addUnbuilt = () => {
    setDraft((d) => ({ ...d, steps: [...d.steps, { feature_id: null, label: query.trim(), needs: [], note: "" }] }));
    setQuery("");
  };
  const cancel = () => (dirty ? setConfirmDiscard(true) : onCancel());

  const allMatches = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    return features.filter((f) => {
      const p = productById.get(f.product_id)?.name ?? "";
      return f.name.toLowerCase().includes(q) || p.toLowerCase().includes(q);
    });
  }, [query, features, productById]);
  const matches = allMatches.slice(0, 8);

  // Live verdicts while composing, by the same rule the saved analysis uses.
  const kinds = draft.steps.map((s) => {
    if (!s.feature_id) return needsVerdict(s.needs.map((n) => bySlug.get(slugify(n))), false);
    const f = featureById.get(s.feature_id);
    if (!f) return "unknown";
    if (!f.external && f.status === "done") return "live";
    return needsVerdict(f.capability_ids.map((id) => byId.get(id)), f.unknown_capabilities);
  });

  const blocker = !draft.name.trim() ? "Give it a name to save it."
    : draft.steps.some((s) => !s.feature_id && !s.label.trim()) ? "Every step needs a name to save it."
      : null;

  async function submit() {
    setSaving(true);
    setError(null);
    try {
      await onSave(draft);
    } catch (e) {
      setError(e.message);
      setSaving(false);
    }
  }

  return (
    <div
      onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); cancel(); } }}
      style={{ ...PANEL, padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div style={{ fontSize: "var(--text-lg)", color: "var(--text-heading)", fontWeight: "var(--weight-semibold)", flex: 1 }}>
          {draft.id ? "Edit" : "New idea or journey"}
        </div>
        {draft.steps.length > 0 && <Tally kinds={kinds} />}
      </div>

      <Input autoFocus label="Name" value={draft.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Plan a Saturday climb" />
      <Input label="Who walks it (optional)" value={draft.persona} onChange={(e) => set({ persona: e.target.value })} placeholder="e.g. a rider new to the hills" />
      <Input label="What they're after (optional)" value={draft.description} onChange={(e) => set({ description: e.target.value })} />

      <div style={CAPS}>Steps, in order</div>
      {draft.steps.length === 0 && <div style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>Add a feature from any product, or a step nobody has built yet.</div>}
      {draft.steps.map((s, i) => {
        const f = s.feature_id ? featureById.get(s.feature_id) : null;
        const product = f ? productById.get(f.product_id) : null;
        const v = VERDICT[kinds[i]];
        const elsewhere = s.feature_id ? [] : s.needs.filter((n) => bySlug.get(slugify(n))?.ours === false);
        return (
          <div key={i} style={{ display: "grid", gridTemplateColumns: "24px minmax(0,1fr) auto", gap: 8, alignItems: "start", padding: 10, border: "1px solid var(--border-hairline)", borderRadius: "var(--radius-sm)", borderStyle: s.feature_id ? "solid" : "dashed" }}>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-secondary)", paddingTop: 9 }}>{i + 1}</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <Input aria-label={`Step ${i + 1} name`} value={s.label} onChange={(e) => setStep(i, { label: e.target.value })} placeholder={f?.name ?? "What the person does"} />
              {!s.feature_id && (
                // The picker closes its own list on Escape; don't let that close the editor too.
                <div onKeyDown={(e) => { if (e.key === "Escape") e.stopPropagation(); }}>
                  <CapabilityPicker id={`step-${i}-needs`} label={`Step ${i + 1} capabilities`} allowNew
                    options={options} value={s.needs} onChange={(needs) => setStep(i, { needs })}
                    placeholder="Not built yet: capabilities it would need (optional)" />
                </div>
              )}
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>
                <span title={v.hint}><Badge tone={v.tone}>{v.label}</Badge></span>
                {s.feature_id && (
                  <span>
                    {f ? (product ? `${product.name}${product.external ? " (external)" : ""}` : "no product") : "This feature was removed"}
                    {f && s.label.trim() && s.label.trim() !== f.name ? ` · feature: ${f.name}` : ""}
                  </span>
                )}
                {elsewhere.length > 0 && <>
                  <span title={NEED.elsewhere.hint}><Badge tone={NEED.elsewhere.tone}>{NEED.elsewhere.label}</Badge></span>
                  <span>{elsewhere.join(", ")}</span>
                </>}
              </div>
              <Input aria-label={`Step ${i + 1} note`} value={s.note} onChange={(e) => setStep(i, { note: e.target.value })} placeholder="Note (optional)" />
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <Button size="sm" variant="ghost" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move step ${i + 1} up`}>↑</Button>
              <Button size="sm" variant="ghost" disabled={i === draft.steps.length - 1} onClick={() => move(i, 1)} aria-label={`Move step ${i + 1} down`}>↓</Button>
              <Button size="sm" variant="ghost" onClick={() => drop(i)} aria-label={`Remove step ${i + 1}`}>✕</Button>
            </div>
          </div>
        );
      })}

      <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: 10, background: "var(--surface-inset)", borderRadius: "var(--radius-sm)" }}>
        <Input label="Add a step" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search features by name or product…" />
        {matches.map((f) => {
          const p = productById.get(f.product_id);
          return (
            <button key={f.id} type="button" onClick={() => addFeature(f)}
              style={{ textAlign: "left", border: "none", background: "transparent", cursor: "pointer", padding: "4px 2px", fontFamily: "var(--font-body)", fontSize: "var(--text-sm)", color: "var(--text-heading)" }}>
              + {f.name}
              <span style={{ color: "var(--text-secondary)", fontSize: "var(--text-xs)" }}> · {p ? `${p.name}${p.external ? " (external)" : ""}` : "no product"} · {statusLabel(f.status)}</span>
            </button>
          );
        })}
        {allMatches.length > matches.length && (
          <div style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>
            {allMatches.length - matches.length} more match. Keep typing to narrow it down.
          </div>
        )}
        <div>
          <Button size="sm" variant="secondary" disabled={!query.trim()} onClick={addUnbuilt}>
            {query.trim() ? `Add “${truncate(query.trim(), 40)}” as a step nobody has built` : "Type a step to add one nobody has built"}
          </Button>
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", borderTop: "1px solid var(--border-hairline)", paddingTop: 12 }}>
        {error && <span role="alert" style={{ color: "var(--danger-fg)", fontSize: "var(--text-xs)" }}>{error}</span>}
        {!error && blocker && <span style={{ color: "var(--text-secondary)", fontSize: "var(--text-xs)" }}>{blocker}</span>}
        <span style={{ flex: 1 }} />
        {confirmDiscard ? (
          <>
            <span style={{ fontSize: "var(--text-xs)", color: "var(--text-body)" }}>Discard your changes?</span>
            <Button size="sm" variant="secondary" onClick={() => setConfirmDiscard(false)}>Keep editing</Button>
            <Button size="sm" variant="danger" onClick={onCancel}>Discard</Button>
          </>
        ) : (
          <>
            <Button size="sm" variant="secondary" onClick={cancel}>Cancel</Button>
            <Button size="sm" variant="accent" disabled={!!blocker || saving} onClick={submit}>{saving ? "Saving…" : "Save"}</Button>
          </>
        )}
      </div>
    </div>
  );
}
