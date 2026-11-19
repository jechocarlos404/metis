import React from "react";
import { PageHeader } from "../shell/PageHeader.jsx";
import { Badge, Input, Tabs } from "../../ds";
import { api } from "../../lib/api.js";
import {
  CARD,
  KINDS,
  LAYERS,
  MICRO,
  MONO,
  SCROLL_X,
  STANCES,
  STANCE_TONE,
  formatAsOf,
} from "../../lib/ontology.js";
import { count } from "../../lib/words.js";

/**
 * `/tech` — the catalog, and `?view=exposure` — what is dying.
 *
 * One route, two views, because exposure *is* the catalog filtered by three
 * death clocks. Keeping it in the URL makes a resolved view linkable, which is
 * the whole point of the `href` the API hands back.
 *
 * Facets rather than a tree: `kind` and `layer` are orthogonal, so a tree
 * would force an argument about where Redis goes. Capability satisfaction is
 * the real index, and search is the primary navigation.
 */

const PAGE = 50;

const COLUMNS = "minmax(180px,1.4fr) 96px 76px 110px minmax(200px,1.6fr) 96px";
const EXPOSURE_COLUMNS = "minmax(180px,1.4fr) 90px minmax(190px,1fr) 96px 130px";

const ADOPTION_LABEL = { none: "no stance" };

// The API's reason is `key:value` (eol_on:2026-04-30, stance:deprecated,
// bus_factor:1). People read a sentence; the raw value stays on hover.
function reasonWords(reason) {
  const at = String(reason).indexOf(":");
  const key = reason.slice(0, at);
  const value = reason.slice(at + 1);
  if (key === "eol_on") return `end of life on ${value}`;
  if (key === "stance") return `marked ${value}`;
  if (key === "bus_factor") return value === "1" ? "one maintainer" : `${value} maintainers`;
  return reason;
}

function FacetRow({ label, options, labels = {}, value, onPick, counts }) {
  return (
    <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
      <span style={{ ...MICRO, marginRight: 4 }}>{label}</span>
      {[{ v: "", l: "all" }, ...options.map((o) => ({ v: o, l: labels[o] ?? o }))].map(({ v, l }) => {
        const active = value === v;
        const n = v ? counts?.[v] : undefined;
        return (
          <button
            key={v || "all"}
            type="button"
            aria-pressed={active}
            onClick={() => onPick(active ? "" : v)}
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-2xs)",
              padding: "3px 8px",
              borderRadius: "var(--radius-xs)",
              cursor: "pointer",
              border: `1px solid ${active ? "var(--accent)" : "var(--border-default)"}`,
              background: active ? "var(--accent-wash)" : "var(--surface-card)",
              color: active ? "var(--text-accent)" : "var(--text-secondary)",
              transition: "background 120ms var(--ease-out), border-color 120ms var(--ease-out)",
            }}
          >
            {l}
            {n !== undefined && <span style={{ color: "var(--text-secondary)" }}> {n}</span>}
          </button>
        );
      })}
    </div>
  );
}

function Skeleton({ columns, rows = 12 }) {
  return Array.from({ length: rows }, (_, i) => (
    <div key={i} style={{ display: "grid", gridTemplateColumns: columns, gap: 12, padding: "10px 16px" }}>
      <span style={{ height: 10, background: "var(--surface-inset)", borderRadius: 2 }} />
    </div>
  ));
}

const EMPTY = { margin: 16, padding: "var(--space-4)", border: "1px dashed var(--border-default)", borderRadius: "var(--radius-sm)", color: "var(--text-secondary)", fontSize: "var(--text-sm)" };

export default function TechCatalogIsland({ initialView = "catalog", initialQuery = "", initialKind = "", initialLayer = "", initialAdoption = "" }) {
  const [view, setView] = React.useState(initialView);
  const [q, setQ] = React.useState(initialQuery);
  const [kind, setKind] = React.useState(initialKind);
  const [layer, setLayer] = React.useState(initialLayer);
  const [adoption, setAdoption] = React.useState(initialAdoption);
  const [offset, setOffset] = React.useState(0);
  const [page, setPage] = React.useState(null);
  const [exposure, setExposure] = React.useState(null);
  const [techTotal, setTechTotal] = React.useState(null);
  const [windowDays, setWindowDays] = React.useState(180);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(null);

  // The active view and its filters live in the URL so a resolved screen is
  // linkable — the same address the API hands back in `href`.
  React.useEffect(() => {
    const url = new URL(window.location.href);
    const set = (k, v) => (v ? url.searchParams.set(k, v) : url.searchParams.delete(k));
    set("view", view === "exposure" ? "exposure" : "");
    set("q", q);
    set("kind", kind);
    set("layer", layer);
    set("adoption", adoption);
    window.history.replaceState(null, "", url);
  }, [view, q, kind, layer, adoption]);

  React.useEffect(() => {
    if (view !== "catalog") return;
    let live = true;
    setLoading(true);
    const params = new URLSearchParams({ limit: PAGE, offset });
    if (q) params.set("q", q);
    if (kind) params.set("kind", kind);
    if (layer) params.set("layer", layer);
    if (adoption) params.set("adoption", adoption);
    const timer = setTimeout(() => {
      api(`/tech?${params}`)
        .then((p) => live && setPage(p))
        .catch((e) => live && setError(e.detail ?? e.message))
        .finally(() => live && setLoading(false));
    }, 200); // debounce, per the spec
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [view, q, kind, layer, adoption, offset]);

  React.useEffect(() => {
    if (view !== "exposure") return;
    let live = true;
    setLoading(true);
    // The catalog size tells "nothing recorded" apart from "nothing at risk".
    Promise.all([api(`/exposure?window_days=${windowDays}`), api("/tech?limit=1")])
      .then(([e, t]) => {
        if (!live) return;
        setExposure(e);
        setTechTotal(t.total);
      })
      .catch((e) => live && setError(e.detail ?? e.message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [view, windowDays]);

  const total = page?.total ?? 0;
  const rows = page?.rows ?? [];
  const facets = page?.facet_counts ?? {};
  const exposed = exposure?.answer.length ?? 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, overflowY: "auto" }}>
      <PageHeader
        title="Tech"
        meta={
          view === "exposure"
            ? `${exposed} at risk · ${formatAsOf(exposure?.as_of)}`
            : loading ? "loading" : count(total, "technology", "technologies")
        }
      />
      <div style={{ padding: "12px 24px 0", flex: "none" }}>
        <Tabs tabs={[{ value: "catalog", label: "Catalog" }, { value: "exposure", label: "Exposure" }]} value={view} onChange={setView} />
      </div>

      {error && (
        <div style={{ padding: "8px 24px", fontSize: "var(--text-sm)", color: "var(--danger-fg)" }}>
          {String(error)}
        </div>
      )}

      {view === "catalog" ? (
        <div style={{ padding: "var(--space-5)", display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
          <Input
            placeholder="Search by name"
            value={q}
            onChange={(e) => { setQ(e.target.value); setOffset(0); }}
          />
          <FacetRow label="stance" options={[...STANCES, "none"]} labels={ADOPTION_LABEL} value={adoption} onPick={(v) => { setAdoption(v); setOffset(0); }} counts={facets.adoption} />
          <details open={Boolean(initialKind || initialLayer) || undefined}>
            <summary style={{ cursor: "pointer", fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>
              More filters{kind || layer ? ` (${[kind, layer].filter(Boolean).join(", ")})` : ""}
            </summary>
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)", marginTop: "var(--space-2)" }}>
              <FacetRow label="kind" options={KINDS} value={kind} onPick={(v) => { setKind(v); setOffset(0); }} counts={facets.kind} />
              <FacetRow label="layer" options={LAYERS} value={layer} onPick={(v) => { setLayer(v); setOffset(0); }} counts={facets.layer} />
            </div>
          </details>

          <div style={{ ...CARD, overflow: "hidden" }}>
            <div style={SCROLL_X}>
              <div style={{ minWidth: 780 }}>
                <div style={{ display: "grid", gridTemplateColumns: COLUMNS, gap: 12, padding: "8px 16px", background: "var(--surface-inset)", borderBottom: "1px solid var(--border-hairline)", ...MICRO }}>
                  <span>Name</span><span>kind</span><span>layer</span><span>stance</span><span>satisfies</span><span>used by</span>
                </div>
                {loading ? (
                  <Skeleton columns={COLUMNS} />
                ) : rows.length === 0 ? (
                  <div style={EMPTY}>
                    {q || kind || layer || adoption
                      ? "No technology matches these filters."
                      : "No technologies recorded yet. They appear here once they're added through the metis API."}
                  </div>
                ) : (
                  rows.map((r) => (
                    <a
                      key={r.id}
                      href={`/tech/${r.slug}`}
                      style={{ display: "grid", gridTemplateColumns: COLUMNS, gap: 12, padding: "10px 16px", borderBottom: "1px solid var(--border-hairline)", textDecoration: "none", alignItems: "center" }}
                    >
                      <span title={r.slug} style={{ fontSize: "var(--text-sm)", color: "var(--text-heading)", overflow: "hidden", textOverflow: "ellipsis" }}>{r.name}</span>
                      <span style={MONO}>{r.kind}</span>
                      <span style={MONO}>{r.layer ?? "—"}</span>
                      <span>
                        {r.adoption ? (
                          <Badge tone={STANCE_TONE[r.adoption]}><span title={r.adoption}>{r.adoption}</span></Badge>
                        ) : (
                          <span style={{ ...MONO, color: "var(--text-secondary)" }}>—</span>
                        )}
                      </span>
                      <span style={{ ...MONO, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {r.satisfies.join(", ") || "—"}
                      </span>
                      <span style={MONO}>{count(r.used_by, "product")}</span>
                    </a>
                  ))
                )}
              </div>
            </div>
          </div>

          {/* Pagination is required: the catalog is world-scope. */}
          {total > PAGE && (
            <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", ...MONO }}>
              <button type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))} style={pagerStyle(offset === 0)}>previous</button>
              <span>{offset + 1}–{Math.min(offset + PAGE, total)} of {total}</span>
              <button type="button" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)} style={pagerStyle(offset + PAGE >= total)}>next</button>
            </div>
          )}
        </div>
      ) : (
        <div style={{ padding: "var(--space-5)", display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", flexWrap: "wrap" }}>
            <span style={MICRO}>within</span>
            {[90, 180, 365].map((d) => (
              <button
                key={d}
                type="button"
                aria-pressed={windowDays === d}
                onClick={() => setWindowDays(d)}
                style={{
                  fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", padding: "3px 8px",
                  borderRadius: "var(--radius-xs)", cursor: "pointer",
                  border: `1px solid ${windowDays === d ? "var(--accent)" : "var(--border-default)"}`,
                  background: windowDays === d ? "var(--accent-wash)" : "var(--surface-card)",
                  color: windowDays === d ? "var(--text-accent)" : "var(--text-secondary)",
                }}
              >
                {d} days
              </button>
            ))}
          </div>

          <p style={{ margin: 0, fontSize: "var(--text-sm)", color: "var(--text-secondary)", maxWidth: "72ch", textWrap: "pretty" }}>
            Technologies that reach end of life in this window, are marked
            deprecated or banned, or have one maintainer. Those that the most required slots use come first.
          </p>

          <div style={{ ...CARD, overflow: "hidden" }}>
            <div style={SCROLL_X}>
              <div style={{ minWidth: 680 }}>
                <div style={{ display: "grid", gridTemplateColumns: EXPOSURE_COLUMNS, gap: 12, padding: "8px 16px", background: "var(--surface-inset)", borderBottom: "1px solid var(--border-hairline)", ...MICRO }}>
                  <span>technology</span><span>version</span><span>why</span><span>products</span><span>required slots</span>
                </div>
                {loading ? (
                  <Skeleton columns={EXPOSURE_COLUMNS} rows={6} />
                ) : exposed === 0 ? (
                  <div style={EMPTY}>
                    {techTotal === 0
                      ? "No technologies recorded, so nothing to check."
                      : `Nothing expires or loses support within ${windowDays} days.`}
                  </div>
                ) : (
                  exposure.answer.map((r) => (
                    <a key={r.tech} href={`/tech/${r.tech}`} style={{ display: "grid", gridTemplateColumns: EXPOSURE_COLUMNS, gap: 12, padding: "10px 16px", borderBottom: "1px solid var(--border-hairline)", textDecoration: "none", alignItems: "center" }}>
                      <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)", color: "var(--text-heading)" }}>{r.tech}</span>
                      <span style={MONO}>{r.version ?? "—"}</span>
                      <span title={r.reason} data-raw={r.reason} style={{ fontSize: "var(--text-xs)", color: "var(--text-body)" }}>{reasonWords(r.reason)}</span>
                      <span style={MONO}>{r.products}</span>
                      <span style={{ ...MONO, color: r.required_slots > 0 ? "var(--danger-fg)" : "var(--text-secondary)" }}>
                        {r.required_slots}
                      </span>
                    </a>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function pagerStyle(disabled) {
  return {
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-2xs)",
    padding: "3px 10px",
    borderRadius: "var(--radius-xs)",
    border: "1px solid var(--border-default)",
    background: "var(--surface-card)",
    color: disabled ? "var(--text-disabled)" : "var(--text-secondary)",
    cursor: disabled ? "default" : "pointer",
  };
}
