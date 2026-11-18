import React from "react";
import { PageHeader } from "../shell/PageHeader.jsx";
import { Badge, Button, Dialog, Input } from "../../ds";
import { api } from "../../lib/api.js";

// A journey is an ordered path of features. The map draws the steps in order
// across the top and the capabilities they stand on below, so it shows at a
// glance which parts of a journey already exist (and in which product), which
// capabilities carry several steps, and where the path breaks.

const CAPS = {
  fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "var(--tracking-caps)",
  textTransform: "uppercase", color: "var(--text-secondary)",
};
const PANEL = {
  background: "var(--surface-card)", border: "1px solid var(--border-hairline)",
  borderRadius: "var(--radius-md)",
};

// Same vocabulary as the product score.
const VERDICT = {
  buildable: { color: "var(--ok-fg)", label: "buildable", hint: "every capability it needs is ours" },
  known_covered: { color: "var(--warn-fg)", label: "named parts ours", hint: "what anyone named is ours, but the list is incomplete" },
  missing: { color: "var(--danger-fg)", label: "missing", hint: "needs a capability we don't have" },
  unknown: { color: "var(--text-secondary)", label: "unknown", hint: "nobody named its capabilities" },
};

const STEP_W = 176;
const STEP_H = 92;
const GAP = 44;
const CAP_H = 26;
const CAP_Y = STEP_H + 120;

function readQueryId() {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("id");
}

function writeQueryId(id) {
  const url = new URL(window.location.href);
  if (id) url.searchParams.set("id", id);
  else url.searchParams.delete("id");
  window.history.replaceState(null, "", url);
}

export default function JourneysIsland({ canWrite }) {
  const [journeys, setJourneys] = React.useState(null);
  const [selected, setSelected] = React.useState(readQueryId);
  const [analysis, setAnalysis] = React.useState(null);
  const [features, setFeatures] = React.useState([]);
  const [products, setProducts] = React.useState([]);
  const [editing, setEditing] = React.useState(null); // draft or null
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [error, setError] = React.useState(null);

  const loadList = React.useCallback(async () => {
    const list = await api("/journeys");
    setJourneys(list);
    return list;
  }, []);

  React.useEffect(() => {
    loadList().catch((e) => setError(e.message));
    Promise.all([api("/features"), api("/products")])
      .then(([f, p]) => { setFeatures(f); setProducts(p); })
      .catch((e) => setError(e.message));
  }, [loadList]);

  React.useEffect(() => {
    if (journeys && !selected && journeys.length) setSelected(journeys[0].id);
  }, [journeys, selected]);

  React.useEffect(() => {
    setAnalysis(null);
    if (!selected) return;
    writeQueryId(selected);
    api(`/journeys/${selected}/analysis`).then(setAnalysis).catch((e) => setError(e.message));
  }, [selected]);

  const productById = React.useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  function startNew() {
    setEditing({ id: null, name: "", persona: "", description: "", steps: [] });
  }

  function startEdit() {
    const j = analysis.journey;
    setEditing({
      id: j.id,
      name: j.name,
      persona: j.persona ?? "",
      description: j.description ?? "",
      steps: j.steps.map((s) => ({
        feature_id: s.feature_id,
        label: s.label,
        needs: s.needs.join(", "),
        note: s.note ?? "",
      })),
    });
  }

  async function save(draft) {
    const body = {
      name: draft.name.trim(),
      persona: draft.persona.trim() || null,
      description: draft.description.trim() || null,
      steps: draft.steps.map((s) => ({
        feature_id: s.feature_id,
        label: s.label.trim() || null,
        needs: s.feature_id ? [] : s.needs.split(",").map((n) => n.trim()).filter(Boolean),
        note: s.note.trim() || null,
      })),
    };
    const saved = draft.id
      ? await api(`/journeys/${draft.id}`, { method: "PATCH", body })
      : await api("/journeys", { method: "POST", body });
    setEditing(null);
    await loadList();
    if (saved.id === selected) {
      setAnalysis(await api(`/journeys/${saved.id}/analysis`));
    } else {
      setSelected(saved.id);
    }
  }

  async function remove() {
    await api(`/journeys/${selected}`, { method: "DELETE" });
    setConfirmDelete(false);
    setSelected(null);
    writeQueryId(null);
    const list = await loadList();
    setSelected(list[0]?.id ?? null);
  }

  return (
    <>
      <PageHeader
        title="Journeys"
        meta={journeys ? `${journeys.length} journey${journeys.length === 1 ? "" : "s"}` : "loading…"}
        actions={canWrite && <Button size="sm" onClick={startNew}>New journey</Button>}
      />
      {error && <div style={{ padding: "8px 24px", color: "var(--danger-fg)", fontSize: "var(--text-xs)" }}>{error}</div>}
      <div style={{ display: "grid", gridTemplateColumns: "260px minmax(0,1fr)", gap: 16, padding: "16px 24px", alignItems: "start" }}>
        <JourneyList journeys={journeys} selected={selected} onSelect={setSelected} canWrite={canWrite} onNew={startNew} />
        <div style={{ minWidth: 0 }}>
          {analysis && (
            <JourneyDetail
              analysis={analysis}
              canWrite={canWrite}
              onEdit={startEdit}
              onDelete={() => setConfirmDelete(true)}
            />
          )}
          {journeys && journeys.length === 0 && <EmptyState canWrite={canWrite} onNew={startNew} />}
        </div>
      </div>
      {editing && (
        <JourneyEditor
          draft={editing}
          features={features}
          productById={productById}
          onCancel={() => setEditing(null)}
          onSave={save}
        />
      )}
      {confirmDelete && analysis && (
        <Dialog open title="Delete journey" onClose={() => setConfirmDelete(false)}
          footer={<>
            <Button variant="secondary" onClick={() => setConfirmDelete(false)}>Cancel</Button>
            <Button variant="danger" onClick={() => remove().catch((e) => setError(e.message))}>Delete</Button>
          </>}>
          <div style={{ fontSize: "var(--text-sm)" }}>
            Delete “{analysis.journey.name}”? Its features stay; only the path is removed.
          </div>
        </Dialog>
      )}
    </>
  );
}

function EmptyState({ canWrite, onNew }) {
  return (
    <div style={{ ...PANEL, padding: 24, display: "flex", flexDirection: "column", gap: 10, fontSize: "var(--text-sm)", color: "var(--text-secondary)", maxWidth: 620 }}>
      <div style={{ color: "var(--text-heading)", fontWeight: "var(--weight-medium)" }}>No journeys yet</div>
      <div>
        A journey is the path a person takes through features — “import a route, see the climb’s
        weather, pace it, pack the food”. Steps can come from any product, ours or someone else’s,
        and a step nobody has built yet can name the capabilities it would need. Metis then shows
        which steps exist today, which we could build from what we have, and what’s missing.
      </div>
      {canWrite && <div><Button size="sm" onClick={onNew}>New journey</Button></div>}
    </div>
  );
}

function JourneyList({ journeys, selected, onSelect }) {
  return (
    <div style={{ ...PANEL, overflow: "hidden" }}>
      <div style={{ ...CAPS, padding: "10px 12px", borderBottom: "1px solid var(--border-hairline)" }}>Journeys</div>
      {!journeys && <div style={{ padding: 12, fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>loading…</div>}
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
            {j.steps.length} step{j.steps.length === 1 ? "" : "s"}{j.persona ? ` · ${j.persona}` : ""}
          </div>
        </button>
      ))}
    </div>
  );
}

function JourneyDetail({ analysis, canWrite, onEdit, onDelete }) {
  const { journey, steps, counts, live, products, external_products: external, report } = analysis;
  const missing = report?.missing ?? [];
  const candidates = new Map();
  for (const f of report?.features ?? []) {
    for (const need of f.capabilities) {
      if (!need.match && need.candidates?.length) candidates.set(need.name, need.candidates.map((c) => c.name));
    }
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ ...PANEL, padding: 16, display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
          <div style={{ fontSize: "var(--text-lg)", color: "var(--text-heading)", fontWeight: "var(--weight-semibold)", flex: 1 }}>{journey.name}</div>
          {canWrite && <>
            <Button size="sm" variant="secondary" onClick={onEdit}>Edit</Button>
            <Button size="sm" variant="ghost" onClick={onDelete}>Delete</Button>
          </>}
        </div>
        {journey.persona && <div style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)" }}>For {journey.persona}</div>}
        {journey.description && <div style={{ fontSize: "var(--text-sm)", color: "var(--text-body)" }}>{journey.description}</div>}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 14, fontSize: "var(--text-xs)", color: "var(--text-secondary)", marginTop: 4 }}>
          <span><b style={{ color: "var(--text-heading)", fontFamily: "var(--font-mono)" }}>{live}/{steps.length}</b> live in our products today</span>
          {Object.entries(VERDICT).map(([k, v]) => counts[k] > 0 && (
            <span key={k} title={v.hint}>
              <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 4, background: v.color, marginRight: 5 }} />
              {counts[k]} {v.label}
            </span>
          ))}
        </div>
        {(products.length > 0 || external.length > 0) && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>
            <span>Passes through</span>
            {products.map((p) => <Badge key={p.id} tone="accent">{p.name}</Badge>)}
            {external.map((p) => <Badge key={p.id} tone="neutral">{p.name} · external</Badge>)}
          </div>
        )}
      </div>

      {steps.length > 0 ? <JourneyMap steps={steps} /> : (
        <div style={{ ...PANEL, padding: 16, fontSize: "var(--text-sm)", color: "var(--text-secondary)" }}>No steps yet — edit the journey to add some.</div>
      )}

      {missing.length > 0 && (
        <div style={{ ...PANEL, padding: 16, display: "flex", flexDirection: "column", gap: 6, fontSize: "var(--text-xs)" }}>
          <div style={CAPS}>To complete this journey we'd need</div>
          {missing.map((name) => (
            <div key={name} style={{ color: "var(--text-body)" }}>
              <span style={{ color: "var(--danger-fg)", fontWeight: "var(--weight-medium)" }}>{name}</span>
              {candidates.get(name) && <span style={{ color: "var(--text-secondary)" }}> — did you mean {candidates.get(name).join(", ")}?</span>}
            </div>
          ))}
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

function capTone(need) {
  const m = need.match;
  if (!m) return { stroke: "var(--danger-fg)", fill: "transparent", text: "var(--danger-fg)", dash: "3,3", why: "nobody has this capability" };
  if (!m.ours) return { stroke: "var(--danger-fg)", fill: "transparent", text: "var(--danger-fg)", dash: null, why: `only ${m.external_products.map((p) => p.name).join(", ")} (external) has it` };
  if (m.products.length > 1) return { stroke: "var(--text-accent)", fill: "var(--accent-wash)", text: "var(--text-accent)", dash: null, why: `ours — reused across ${m.products.map((p) => p.name).join(", ")}` };
  return { stroke: "var(--ok-fg)", fill: "var(--ok-bg)", text: "var(--ok-fg)", dash: null, why: `ours — in ${m.products.map((p) => p.name).join(", ")}` };
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

  const hovered = hover?.kind === "cap" ? placed.find((c) => c.key === hover.key) : null;

  return (
    <div style={{ ...PANEL, padding: "12px 0 4px" }}>
      <div style={{ ...CAPS, padding: "0 16px 6px" }}>Steps, and the capabilities they stand on — hover either to trace it</div>
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
            const tone = capTone(c.need);
            const x1 = stepX(i) + STEP_W / 2;
            const x2 = c.x + c.w / 2;
            return (
              <path key={`${c.key}-${i}`}
                d={`M${x1},${STEP_H} C${x1},${STEP_H + 60} ${x2},${CAP_Y - 60} ${x2},${CAP_Y}`}
                fill="none" stroke={on && hover ? tone.stroke : "var(--border-default)"}
                strokeWidth={on && hover ? 1.8 : 1} strokeDasharray={tone.dash ?? undefined}
                opacity={on ? 1 : 0.15} />
            );
          }))}
          {steps.map((s, i) => (
            <StepCard key={i} step={s} x={stepX(i)} dim={!active(i, null)}
              onEnter={() => setHover({ kind: "step", key: i })} onLeave={() => setHover(null)} />
          ))}
          {placed.map((c) => {
            const tone = capTone(c.need);
            const on = active(null, c.key);
            return (
              <g key={c.key} transform={`translate(${c.x},${CAP_Y})`} opacity={on ? 1 : 0.2}
                onMouseEnter={() => setHover({ kind: "cap", key: c.key })} onMouseLeave={() => setHover(null)}
                style={{ cursor: "default" }}>
                <title>{`${c.need.match?.name ?? c.need.name}: ${tone.why}${c.need.match ? ` · ${c.need.match.maturity}` : ""} · used by ${c.steps.length} step${c.steps.length === 1 ? "" : "s"} here`}</title>
                <rect width={c.w} height={CAP_H} rx={CAP_H / 2} fill={tone.fill} stroke={tone.stroke}
                  strokeDasharray={tone.dash ?? undefined} />
                <text x={c.w / 2} y={CAP_H / 2 + 4} textAnchor="middle" fontSize="11" fill={tone.text}>
                  {truncate(c.need.match?.name ?? c.need.name, Math.floor((c.w - 16) / 6.4))}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 14, padding: "6px 16px 8px", fontSize: "var(--text-xs)", color: "var(--text-secondary)", minHeight: 22 }}>
        {hovered ? (
          <span><b style={{ color: "var(--text-heading)" }}>{hovered.need.match?.name ?? hovered.need.name}</b> — {capTone(hovered.need).why}{hovered.need.match ? ` · ${hovered.need.match.maturity}` : ""}</span>
        ) : (
          <>
            <Legend fill="var(--accent-wash)" stroke="var(--text-accent)" label="ours, reused across products" />
            <Legend fill="var(--ok-bg)" stroke="var(--ok-fg)" label="ours, one product" />
            <Legend fill="transparent" stroke="var(--danger-fg)" label="only external products have it" />
            <Legend fill="transparent" stroke="var(--danger-fg)" dash label="nobody has it" />
          </>
        )}
      </div>
    </div>
  );
}

function Legend({ fill, stroke, dash, label }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
      <svg width="18" height="10"><rect x="1" y="1" width="16" height="8" rx="4" fill={fill} stroke={stroke} strokeDasharray={dash ? "2,2" : undefined} /></svg>
      {label}
    </span>
  );
}

function truncate(text, n) {
  return text.length > n ? `${text.slice(0, Math.max(1, n - 1))}…` : text;
}

function StepCard({ step, x, dim, onEnter, onLeave }) {
  const v = VERDICT[step.verdict];
  const f = step.feature;
  const where = f
    ? `${f.product ? f.product.name : "no product"}${f.external ? " · external" : ""}`
    : "not built";
  const status = f ? (step.live ? "live" : f.external ? "theirs" : f.status.replace("_", " ")) : null;
  return (
    <g transform={`translate(${x},0)`} opacity={dim ? 0.3 : 1} onMouseEnter={onEnter} onMouseLeave={onLeave}>
      <title>{`${step.label}\n${where}${status ? ` · ${status}` : ""}\n${v.label}: ${v.hint}${step.note ? `\n${step.note}` : ""}`}</title>
      <rect width={STEP_W} height={STEP_H} rx="8" fill="var(--surface-card)"
        stroke={f ? "var(--border-default)" : "var(--border-default)"}
        strokeDasharray={f ? undefined : "4,3"} />
      <rect width="4" height={STEP_H - 16} x="0" y="8" rx="2" fill={v.color} />
      <text x="14" y="18" fontSize="10" fill="var(--text-secondary)" fontFamily="var(--font-mono)">{String(step.position + 1).padStart(2, "0")}</text>
      {step.live && <circle cx={STEP_W - 14} cy="14" r="4" fill="var(--ok-fg)"><title>live in our product today</title></circle>}
      <foreignObject x="12" y="24" width={STEP_W - 22} height="40">
        <div xmlns="http://www.w3.org/1999/xhtml" style={{
          fontSize: 12, lineHeight: "16px", color: "var(--text-heading)", fontWeight: 500,
          overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
        }}>{step.label}</div>
      </foreignObject>
      <text x="14" y={STEP_H - 12} fontSize="10.5" fill={f ? "var(--text-secondary)" : "var(--danger-fg)"}>
        {truncate(`${where}${status && !step.live ? ` · ${status}` : ""}`, 28)}
      </text>
    </g>
  );
}

function JourneyEditor({ draft: initial, features, productById, onCancel, onSave }) {
  const [draft, setDraft] = React.useState(initial);
  const [query, setQuery] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState(null);
  const featureById = React.useMemo(() => new Map(features.map((f) => [f.id, f])), [features]);

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
    setDraft((d) => ({ ...d, steps: [...d.steps, { feature_id: f.id, label: f.name, needs: "", note: "" }] }));
    setQuery("");
  };
  const addUnbuilt = () => setDraft((d) => ({ ...d, steps: [...d.steps, { feature_id: null, label: query.trim(), needs: "", note: "" }] }));

  const matches = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    return features
      .filter((f) => {
        const p = productById.get(f.product_id)?.name ?? "";
        return f.name.toLowerCase().includes(q) || p.toLowerCase().includes(q);
      })
      .slice(0, 8);
  }, [query, features, productById]);

  const valid = draft.name.trim() && draft.steps.every((s) => s.feature_id || s.label.trim());

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
    <Dialog open title={draft.id ? "Edit journey" : "New journey"} onClose={onCancel} width="760px"
      footer={<>
        {error && <span style={{ color: "var(--danger-fg)", fontSize: "var(--text-xs)", marginRight: "auto" }}>{error}</span>}
        <Button variant="secondary" onClick={onCancel}>Cancel</Button>
        <Button disabled={!valid || saving} onClick={submit}>{saving ? "Saving…" : "Save"}</Button>
      </>}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12, maxHeight: "70vh", overflowY: "auto" }}>
        <Input label="Name" value={draft.name} onChange={(e) => set({ name: e.target.value })} placeholder="Plan a Saturday climb" />
        <Input label="Who walks it (optional)" value={draft.persona} onChange={(e) => set({ persona: e.target.value })} placeholder="a rider new to the hills" />
        <Input label="What they're after (optional)" value={draft.description} onChange={(e) => set({ description: e.target.value })} />

        <div style={CAPS}>Steps, in order</div>
        {draft.steps.length === 0 && <div style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>Add a feature from any product, or a step nobody has built yet.</div>}
        {draft.steps.map((s, i) => {
          const f = s.feature_id ? featureById.get(s.feature_id) : null;
          const product = f ? productById.get(f.product_id) : null;
          return (
            <div key={i} style={{ display: "grid", gridTemplateColumns: "24px minmax(0,1fr) auto", gap: 8, alignItems: "start", padding: 10, border: "1px solid var(--border-hairline)", borderRadius: "var(--radius-sm)", borderStyle: s.feature_id ? "solid" : "dashed" }}>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-secondary)", paddingTop: 9 }}>{String(i + 1).padStart(2, "0")}</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <Input value={s.label} onChange={(e) => setStep(i, { label: e.target.value })} placeholder={f?.name ?? "What the person does"} />
                {s.feature_id ? (
                  <div style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>
                    Feature: {f?.name ?? "(removed)"}{product ? ` · ${product.name}${product.external ? " (external)" : ""}` : ""}
                  </div>
                ) : (
                  <Input value={s.needs} onChange={(e) => setStep(i, { needs: e.target.value })}
                    placeholder="Not built yet — capabilities it would need, comma-separated (optional)" />
                )}
                <Input value={s.note} onChange={(e) => setStep(i, { note: e.target.value })} placeholder="Note (optional)" />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <Button size="sm" variant="ghost" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">↑</Button>
                <Button size="sm" variant="ghost" disabled={i === draft.steps.length - 1} onClick={() => move(i, 1)} aria-label="Move down">↓</Button>
                <Button size="sm" variant="ghost" onClick={() => drop(i)} aria-label="Remove step">✕</Button>
              </div>
            </div>
          );
        })}

        <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: 10, background: "var(--surface-inset)", borderRadius: "var(--radius-sm)" }}>
          <Input label="Add a step" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search features by name or product…" />
          {matches.map((f) => {
            const p = productById.get(f.product_id);
            return (
              <button key={f.id} onClick={() => addFeature(f)}
                style={{ textAlign: "left", border: "none", background: "transparent", cursor: "pointer", padding: "4px 2px", fontFamily: "var(--font-body)", fontSize: "var(--text-sm)", color: "var(--text-heading)" }}>
                + {f.name}
                <span style={{ color: "var(--text-secondary)", fontSize: "var(--text-xs)" }}> · {p ? `${p.name}${p.external ? " (external)" : ""}` : "no product"} · {f.status.replace("_", " ")}</span>
              </button>
            );
          })}
          <div>
            <Button size="sm" variant="secondary" onClick={addUnbuilt}>
              {query.trim() ? `Add “${truncate(query.trim(), 40)}” as a step nobody has built` : "Add a step nobody has built"}
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
