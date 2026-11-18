import React from "react";
import { PageHeader } from "../shell/PageHeader.jsx";
import { Badge, Input } from "../../ds";
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

function FacetRow({ label, options, value, onPick, counts }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={MICRO}>{label}</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
        {[{ v: "", l: "all" }, ...options.map((o) => ({ v: o, l: o }))].map(({ v, l }) => {
          const active = value === v;
          const n = v ? counts?.[v] : undefined;
          return (
            <button
              key={v || "all"}
              type="button"
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

export default function TechCatalogIsland({ initialView = "catalog", initialQuery = "" }) {
  const [view, setView] = React.useState(initialView);
  const [q, setQ] = React.useState(initialQuery);
  const [kind, setKind] = React.useState("");
  const [layer, setLayer] = React.useState("");
  const [adoption, setAdoption] = React.useState("");
  const [offset, setOffset] = React.useState(0);
  const [page, setPage] = React.useState(null);
  const [exposure, setExposure] = React.useState(null);
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
    set("adoption", adoption);
    window.history.replaceState(null, "", url);
  }, [view, q, kind, adoption]);

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
    api(`/exposure?window_days=${windowDays}`)
      .then((e) => live && setExposure(e))
      .catch((e) => live && setError(e.detail ?? e.message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [view, windowDays]);

  const total = page?.total ?? 0;
  const rows = page?.rows ?? [];
  const facets = page?.facet_counts ?? {};

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, overflowY: "auto" }}>
      <PageHeader
        title="Tech"
        meta={
          view === "exposure"
            ? `${exposure?.answer.length ?? 0} exposed · ${formatAsOf(exposure?.as_of)}`
            : `${total} technolog(ies)`
        }
        actions={
          <div style={{ display: "flex", gap: 4 }}>
            {["catalog", "exposure"].map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "var(--text-2xs)",
                  padding: "4px 10px",
                  borderRadius: "var(--radius-xs)",
                  cursor: "pointer",
                  border: `1px solid ${view === v ? "var(--accent)" : "var(--border-default)"}`,
                  background: view === v ? "var(--accent-wash)" : "var(--surface-card)",
                  color: view === v ? "var(--text-accent)" : "var(--text-secondary)",
                }}
              >
                {v}
              </button>
            ))}
          </div>
        }
      />

      {error && (
        <div style={{ padding: "8px 24px", fontSize: "var(--text-sm)", color: "var(--danger-fg)" }}>
          {String(error)}
        </div>
      )}

      {view === "catalog" ? (
        <div style={{ display: "flex", gap: "var(--space-5)", padding: "var(--space-5)", alignItems: "flex-start", flexWrap: "wrap" }}>
          <aside style={{ width: 212, flex: "none", display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
            <FacetRow label="kind" options={KINDS} value={kind} onPick={(v) => { setKind(v); setOffset(0); }} counts={facets.kind} />
            <FacetRow label="layer" options={LAYERS} value={layer} onPick={(v) => { setLayer(v); setOffset(0); }} counts={facets.layer} />
            <FacetRow label="adoption" options={[...STANCES, "none"]} value={adoption} onPick={(v) => { setAdoption(v); setOffset(0); }} counts={facets.adoption} />
          </aside>

          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
            <Input
              placeholder="Search name or slug"
              value={q}
              onChange={(e) => { setQ(e.target.value); setOffset(0); }}
            />
            <div style={{ ...CARD, overflow: "hidden" }}>
              <div style={SCROLL_X}>
                <div style={{ minWidth: 780 }}>
                  <div style={{ display: "grid", gridTemplateColumns: COLUMNS, gap: 12, padding: "8px 16px", background: "var(--surface-inset)", borderBottom: "1px solid var(--border-hairline)", ...MICRO }}>
                    <span>slug</span><span>kind</span><span>layer</span><span>adoption</span><span>satisfies</span><span>used by</span>
                  </div>
                  {loading ? (
                    <Skeleton columns={COLUMNS} />
                  ) : rows.length === 0 ? (
                    <div style={{ margin: 16, padding: "var(--space-4)", border: "1px dashed var(--border-default)", borderRadius: "var(--radius-sm)", color: "var(--text-secondary)", fontSize: "var(--text-sm)" }}>
                      No technology matches those facets.
                    </div>
                  ) : (
                    rows.map((r) => (
                      <a
                        key={r.id}
                        href={`/tech/${r.slug}`}
                        style={{ display: "grid", gridTemplateColumns: COLUMNS, gap: 12, padding: "10px 16px", borderBottom: "1px solid var(--border-hairline)", textDecoration: "none", alignItems: "center" }}
                      >
                        <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)", color: "var(--text-heading)", overflow: "hidden", textOverflow: "ellipsis" }}>{r.slug}</span>
                        <span style={MONO}>{r.kind}</span>
                        <span style={MONO}>{r.layer ?? "—"}</span>
                        <span>
                          {r.adoption ? (
                            <Badge tone={STANCE_TONE[r.adoption]}>{r.adoption}</Badge>
                          ) : (
                            <span style={{ ...MONO, color: "var(--text-secondary)" }}>no stance</span>
                          )}
                        </span>
                        <span style={{ ...MONO, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {r.satisfies.join(", ") || "—"}
                        </span>
                        <span style={MONO}>{r.used_by} product(s)</span>
                      </a>
                    ))
                  )}
                </div>
              </div>
            </div>

            {/* Pagination is required: the catalog is world-scope. */}
            <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", ...MONO }}>
              <button type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))} style={pagerStyle(offset === 0)}>previous</button>
              <span>{total === 0 ? 0 : offset + 1}–{Math.min(offset + PAGE, total)} of {total}</span>
              <button type="button" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)} style={pagerStyle(offset + PAGE >= total)}>next</button>
            </div>
          </div>
        </div>
      ) : (
        <div style={{ padding: "var(--space-5)", display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", flexWrap: "wrap" }}>
            <span style={MICRO}>window</span>
            {[90, 180, 365].map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setWindowDays(d)}
                style={{
                  fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", padding: "3px 8px",
                  borderRadius: "var(--radius-xs)", cursor: "pointer",
                  border: `1px solid ${windowDays === d ? "var(--accent)" : "var(--border-default)"}`,
                  background: windowDays === d ? "var(--accent-wash)" : "var(--surface-card)",
                  color: windowDays === d ? "var(--text-accent)" : "var(--text-secondary)",
                }}
              >
                {d}d
              </button>
            ))}
            <span style={{ ...MONO, color: "var(--text-accent)" }}>{formatAsOf(exposure?.as_of)}</span>
          </div>

          <p style={{ margin: 0, fontSize: "var(--text-sm)", color: "var(--text-secondary)", maxWidth: "72ch", textWrap: "pretty" }}>
            Three independent death modes: a release line expiring, a stance the
            group already gave up on, or one maintainer. Sorted by required
            slots, not by date — the unit of action is a row.
          </p>

          <div style={{ ...CARD, overflow: "hidden" }}>
            <div style={SCROLL_X}>
              <div style={{ minWidth: 680 }}>
                <div style={{ display: "grid", gridTemplateColumns: EXPOSURE_COLUMNS, gap: 12, padding: "8px 16px", background: "var(--surface-inset)", borderBottom: "1px solid var(--border-hairline)", ...MICRO }}>
                  <span>tech</span><span>version</span><span>reason</span><span>products</span><span>required slots</span>
                </div>
                {loading ? (
                  <Skeleton columns={EXPOSURE_COLUMNS} rows={6} />
                ) : (exposure?.answer.length ?? 0) === 0 ? (
                  <div style={{ margin: 16, padding: "var(--space-4)", border: "1px dashed var(--border-default)", borderRadius: "var(--radius-sm)", color: "var(--text-secondary)", fontSize: "var(--text-sm)" }}>
                    Nothing is exposed inside {windowDays} days.
                  </div>
                ) : (
                  exposure.answer.map((r) => (
                    <a key={r.tech} href={`/tech/${r.tech}`} style={{ display: "grid", gridTemplateColumns: EXPOSURE_COLUMNS, gap: 12, padding: "10px 16px", borderBottom: "1px solid var(--border-hairline)", textDecoration: "none", alignItems: "center" }}>
                      <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)", color: "var(--text-heading)" }}>{r.tech}</span>
                      <span style={MONO}>{r.version ?? "—"}</span>
                      {/* Verbatim key:value — identical on every surface. */}
                      <span style={MONO}>{r.reason}</span>
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

          <div style={{ ...CARD, padding: "var(--space-4)" }}>
            <div style={MICRO}>no score, no rollup</div>
            <p style={{ margin: "8px 0 0", fontSize: "var(--text-sm)", color: "var(--text-secondary)", maxWidth: "72ch", textWrap: "pretty" }}>
              There is no health percentage and no red/amber/green estate
              summary here on purpose. A number averaging three unrelated death
              modes tells you nothing you can act on. These same rows fail a
              build nightly via <code style={MONO}>GET /api/exposure</code>.
            </p>
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
