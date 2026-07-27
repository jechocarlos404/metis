import React from "react";
import { PageHeader } from "../shell/PageHeader.jsx";
import { Badge, Button, Input, Select } from "../../ds";
import { api } from "../../lib/api.js";
import { CARD, FIT_TONE, MICRO, MONO, STANCE_TONE } from "../../lib/ontology.js";

/**
 * `/tech/[slug]` — everything known about one technology, plus the two things
 * you need before touching it: what breaks, and who to ask.
 *
 * The blast radius is count-led and never collapsed into a score: `required`
 * is a break, `required: false` is an inconvenience, and `off_stack` means
 * nobody signed off on the dependency in the first place. Three different
 * facts, three different responses.
 *
 * The encounters strip is deliberately the thinnest surface in the product —
 * a handle and a depth. Add ratings and it becomes a performance-review
 * artifact, and people stop recording encounters at all.
 */

const DEPTHS = ["shipped", "touched", "evaluated"];

function Section({ label, children, meta }) {
  return (
    <section style={{ ...CARD, padding: "var(--space-4)", display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: "var(--space-3)" }}>
        <span style={MICRO}>{label}</span>
        {meta && <span style={MONO}>{meta}</span>}
      </div>
      {children}
    </section>
  );
}

function Fact({ label, children }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 120 }}>
      <span style={MICRO}>{label}</span>
      <span style={{ fontSize: "var(--text-sm)", color: "var(--text-heading)" }}>{children}</span>
    </div>
  );
}

export default function TechDetailIsland({ slug, canWrite = false }) {
  const [detail, setDetail] = React.useState(null);
  const [radius, setRadius] = React.useState(null);
  const [encounters, setEncounters] = React.useState(null);
  const [capabilities, setCapabilities] = React.useState([]);
  const [draft, setDraft] = React.useState({ person: "", depth: "touched" });
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState(null);

  const load = React.useCallback(() => {
    Promise.all([
      api(`/tech/${slug}`),
      api(`/tech/${slug}/blast-radius`),
      api(`/tech/${slug}/encounters`),
      api("/capabilities"),
    ])
      .then(([d, r, e, caps]) => {
        setDetail(d);
        setRadius(r);
        setEncounters(e);
        setCapabilities(caps);
      })
      .catch((e) => setError(e.detail ?? e.message));
  }, [slug]);

  React.useEffect(load, [load]);

  async function addEncounter(event) {
    event.preventDefault();
    if (!draft.person.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await api("/tech/encounters", {
        method: "POST",
        body: {
          tech_id: detail.id,
          person: draft.person.trim(),
          depth: draft.depth,
          last_at: new Date().toISOString().slice(0, 10),
        },
      });
      setDraft({ person: "", depth: "touched" });
      load();
    } catch (e) {
      setError(e.detail ?? e.message);
    } finally {
      setSaving(false);
    }
  }

  if (error && !detail) {
    return <div style={{ padding: "var(--space-6)", color: "var(--danger-fg)" }}>{String(error)}</div>;
  }
  if (!detail) return <div style={{ padding: "var(--space-6)", ...MICRO }}>loading</div>;

  const breaks = radius?.answer ?? [];
  const required = breaks.filter((b) => b.required).length;
  const offStack = breaks.filter((b) => b.off_stack).length;
  const capName = (id) => capabilities.find((c) => c.id === id);

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
      <PageHeader
        title={detail.name}
        meta={
          <span style={MONO}>
            {detail.slug} · {detail.kind} · {detail.layer ?? "no layer"} · {detail.display_id}
          </span>
        }
        actions={
          detail.adoption ? (
            <Badge tone={STANCE_TONE[detail.adoption]}>{detail.adoption}</Badge>
          ) : (
            <span style={{ ...MONO, color: "var(--text-disabled)" }}>no stance taken</span>
          )
        }
      />

      {error && (
        <div style={{ padding: "8px 24px", fontSize: "var(--text-sm)", color: "var(--danger-fg)" }}>{String(error)}</div>
      )}

      <div style={{ padding: "var(--space-5)", display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
        <Section label="facts">
          <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-5)" }}>
            <Fact label="slug"><code style={{ fontFamily: "var(--font-mono)" }}>{detail.slug}</code></Fact>
            <Fact label="kind">{detail.kind}</Fact>
            <Fact label="layer">{detail.layer ?? "—"}</Fact>
            <Fact label="vendor">{detail.vendor?.name ?? "—"}</Fact>
            <Fact label="bus factor">
              {detail.vendor?.bus_factor ?? "—"}
              {detail.vendor?.bus_factor === 1 && (
                <span style={{ marginLeft: 6 }}><Badge tone="danger">one maintainer</Badge></span>
              )}
            </Fact>
            <Fact label="used by">{detail.used_by} product(s)</Fact>
          </div>
          {detail.versions.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)" }}>
              {detail.versions.map((v) => (
                <span key={v.id} style={{ ...MONO, border: "1px solid var(--border-default)", borderRadius: "var(--radius-xs)", padding: "2px 8px" }}>
                  {v.label}
                  {v.eol_on && <span style={{ color: "var(--text-disabled)" }}> · eol {v.eol_on}</span>}
                </span>
              ))}
            </div>
          )}
        </Section>

        <Section label="satisfies" meta={`${detail.satisfactions.length} capabilit(ies)`}>
          {detail.satisfactions.length === 0 ? (
            <span style={{ fontSize: "var(--text-sm)", color: "var(--text-disabled)" }}>
              In the catalog, not a candidate for anything. That is a normal state.
            </span>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {detail.satisfactions.map((s) => {
                const cap = capName(s.capability_id);
                return (
                  <div key={s.id} style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
                    <a href={cap ? `/capabilities/${cap.slug}` : "#"} style={{ flex: 1, fontSize: "var(--text-sm)", color: "var(--text-heading)", textDecoration: "none", minWidth: 0 }}>
                      {cap?.name ?? s.capability_id}
                    </a>
                    <Badge tone={FIT_TONE[s.fit] ?? "neutral"}>{s.fit}</Badge>
                    {s.notes && <span style={{ ...MONO, flex: 2, minWidth: 0 }}>{s.notes}</span>}
                  </div>
                );
              })}
            </div>
          )}
        </Section>

        {/* Count-led. required is a break; optional is an inconvenience. */}
        <Section
          label="blast radius"
          meta={`${breaks.length} product(s) · ${required} required slot(s) · ${offStack} off_stack`}
        >
          {breaks.length === 0 ? (
            <span style={{ fontSize: "var(--text-sm)", color: "var(--text-disabled)" }}>
              {radius?.unresolved?.[0]?.reason ?? "No product records using this."}
            </span>
          ) : (
            breaks.map((b, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
                <span style={{ flex: 1, fontSize: "var(--text-sm)", color: "var(--text-heading)", minWidth: 0 }}>{b.product}</span>
                <span style={MONO}>{b.layer ?? "—"}</span>
                <span style={{ ...MONO, flex: 1, minWidth: 0 }}>{b.role ?? "—"}</span>
                <Badge tone={b.required ? "danger" : "neutral"}>{b.required ? "required" : "optional"}</Badge>
                {b.off_stack && <Badge tone="warn">off_stack</Badge>}
              </div>
            ))
          )}
          {(radius?.alternatives?.length ?? 0) > 0 && (
            <div style={{ borderTop: "1px solid var(--border-hairline)", paddingTop: "var(--space-3)", display: "flex", flexWrap: "wrap", gap: "var(--space-2)", alignItems: "center" }}>
              <span style={MICRO}>alternatives</span>
              {radius.alternatives.map((a) => (
                <a key={a.tech} href={`/tech/${a.tech}`} style={{ ...MONO, textDecoration: "none", border: "1px solid var(--border-default)", borderRadius: "var(--radius-xs)", padding: "2px 8px" }}>
                  {a.tech} · {a.fit} · {a.stance ?? "no stance"}
                </a>
              ))}
            </div>
          )}
        </Section>

        <Section label="who has touched this" meta={`${encounters?.answer.length ?? 0} person(s)`}>
          {(encounters?.answer.length ?? 0) === 0 ? (
            <span style={{ fontSize: "var(--text-sm)", color: "var(--text-disabled)" }}>
              Nobody has recorded touching this.
            </span>
          ) : (
            <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)" }}>
              {encounters.answer.map((e, i) => (
                <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 8, border: "1px solid var(--border-default)", borderRadius: "var(--radius-xs)", padding: "4px 10px" }}>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)", color: "var(--text-heading)" }}>{e.person}</span>
                  <span style={MONO}>{e.depth}</span>
                  <span style={{ ...MONO, color: "var(--text-disabled)" }}>{e.last_at}</span>
                  {e.on_product && <span style={{ ...MONO, color: "var(--text-disabled)" }}>{e.on_product}</span>}
                </span>
              ))}
            </div>
          )}

          {canWrite && (
            <form onSubmit={addEncounter} style={{ display: "flex", gap: "var(--space-2)", alignItems: "center", flexWrap: "wrap" }}>
              <Input
                placeholder="handle"
                value={draft.person}
                onChange={(e) => setDraft({ ...draft, person: e.target.value })}
                style={{ maxWidth: 200 }}
              />
              <Select value={draft.depth} onChange={(e) => setDraft({ ...draft, depth: e.target.value })}>
                {DEPTHS.map((d) => <option key={d} value={d}>{d}</option>)}
              </Select>
              <Button type="submit" size="sm" disabled={saving || !draft.person.trim()}>
                {saving ? "recording" : "record"}
              </Button>
              <span style={{ ...MONO, color: "var(--text-disabled)" }}>
                a handle and a depth — no levels, no endorsements
              </span>
            </form>
          )}
        </Section>
      </div>
    </div>
  );
}
