import React from "react";
import { PageHeader } from "../shell/PageHeader.jsx";
import { Badge, Button, Icon, IconButton, Input, Select } from "../../ds";
import { api } from "../../lib/api.js";
import { CARD, FIT_TONE, MICRO, MONO, STANCE_TONE } from "../../lib/ontology.js";
import { FIT, count } from "../../lib/words.js";
import { Term } from "../shared/Term.jsx";

const OFF_STACK = "not in the product's stack";

/**
 * `/tech/[slug]` — everything known about one technology, plus the two things
 * you need before touching it: what breaks, and who to ask.
 *
 * The blast radius is count-led and never collapsed into a score: `required`
 * is a break, `required: false` is an inconvenience, and `off_stack` means
 * the product's stack never declared the dependency. Three different facts,
 * three different responses. A product with no stack has no slot to judge,
 * so its row says only that it uses the technology.
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
  const [capabilities, setCapabilities] = React.useState([]);
  const [products, setProducts] = React.useState([]);
  const [draft, setDraft] = React.useState({ person: "", depth: "touched" });
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState(null);

  const load = React.useCallback(() => {
    Promise.all([
      api(`/tech/${slug}`),
      api(`/tech/${slug}/blast-radius`),
      api("/capabilities"),
      api("/products"),
    ])
      .then(([d, r, caps, prods]) => {
        setDetail(d);
        setRadius(r);
        setCapabilities(caps);
        setProducts(prods);
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

  async function removeEncounter(id) {
    setError(null);
    try {
      await api(`/tech/encounters/${id}`, { method: "DELETE" });
      load();
    } catch (e) {
      setError(e.detail ?? e.message);
    }
  }

  if (error && !detail) {
    return <div style={{ padding: "var(--space-6)", color: "var(--danger-fg)" }}>{String(error)}</div>;
  }
  if (!detail) return <div style={{ padding: "var(--space-6)", ...MICRO }}>loading</div>;

  const breaks = radius?.answer ?? [];
  const required = breaks.filter((b) => b.required).length;
  const offStack = breaks.filter((b) => b.off_stack).length;
  const slotted = breaks.filter((b) => b.layer != null).length;
  const capName = (id) => capabilities.find((c) => c.id === id);
  const productByName = (name) => products.find((p) => p.name === name);
  const productName = (id) => products.find((p) => p.id === id)?.name;
  const encounters = detail.encounters ?? [];

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, overflowY: "auto" }}>
      <PageHeader
        title={detail.name}
        meta={<span style={MONO} title={detail.slug}>{detail.display_id}</span>}
        actions={
          detail.adoption ? (
            <Badge tone={STANCE_TONE[detail.adoption]}>{detail.adoption}</Badge>
          ) : (
            <span style={{ ...MONO, color: "var(--text-secondary)" }}>no stance yet</span>
          )
        }
      />

      {error && (
        <div style={{ padding: "8px 24px", fontSize: "var(--text-sm)", color: "var(--danger-fg)" }}>{String(error)}</div>
      )}

      <div style={{ padding: "var(--space-5)", display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
        <Section label="facts">
          <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-5)" }}>
            <Fact label="kind">{detail.kind}</Fact>
            <Fact label="layer">{detail.layer ?? "—"}</Fact>
            <Fact label="vendor">{detail.vendor?.name ?? "—"}</Fact>
            <Fact label="maintainers">
              {detail.vendor?.bus_factor ?? "—"}
              {detail.vendor?.bus_factor === 1 && (
                <span style={{ marginLeft: 6 }}><Badge tone="danger">one maintainer</Badge></span>
              )}
            </Fact>
            <Fact label="used by">{count(detail.used_by, "product")}</Fact>
          </div>
          {detail.versions.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)" }}>
              {detail.versions.map((v) => (
                <span key={v.id} style={{ ...MONO, border: "1px solid var(--border-default)", borderRadius: "var(--radius-xs)", padding: "2px 8px" }}>
                  {v.label}
                  {v.eol_on && <span style={{ color: "var(--text-secondary)" }}> · eol {v.eol_on}</span>}
                </span>
              ))}
            </div>
          )}
        </Section>

        <Section label="satisfies" meta={count(detail.satisfactions.length, "capability", "capabilities")}>
          {detail.satisfactions.length === 0 ? (
            <span style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)" }}>
              Not linked to any capability yet.
            </span>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {detail.satisfactions.map((s) => {
                const cap = capName(s.capability_id);
                return (
                  <div key={s.id} style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
                    {cap ? (
                      <a href={`/capabilities/${cap.slug}`} style={{ flex: 1, fontSize: "var(--text-sm)", minWidth: 0 }}>{cap.name}</a>
                    ) : (
                      <span style={{ flex: 1, fontSize: "var(--text-sm)", color: "var(--text-heading)", minWidth: 0 }}>{s.capability_id}</span>
                    )}
                    <Badge tone={FIT_TONE[s.fit] ?? "neutral"}><Term dict={FIT} value={s.fit} /></Badge>
                    {s.notes && <span style={{ ...MONO, flex: 2, minWidth: 0 }}>{s.notes}</span>}
                  </div>
                );
              })}
            </div>
          )}
        </Section>

        {/* Count-led. required is a break; optional is an inconvenience. */}
        <Section
          label="What breaks without it"
          meta={[
            count(breaks.length, "product"),
            slotted > 0 && count(required, "required slot"),
            offStack > 0 && `${offStack} ${OFF_STACK}`,
          ].filter(Boolean).join(" · ")}
        >
          {breaks.length === 0 ? (
            <span style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)" }}>
              No product records using it, so nothing breaks.
            </span>
          ) : (
            breaks.map((b, i) => {
              const product = productByName(b.product);
              return (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", flexWrap: "wrap" }}>
                  {product ? (
                    <a href={`/products?product=${product.id}`} style={{ flex: 1, fontSize: "var(--text-sm)", minWidth: 0 }}>{b.product}</a>
                  ) : (
                    <span style={{ flex: 1, fontSize: "var(--text-sm)", color: "var(--text-heading)", minWidth: 0 }}>{b.product}</span>
                  )}
                  {b.layer != null ? (
                    <>
                      <span style={MONO}>{b.layer}</span>
                      <span style={{ ...MONO, flex: 1, minWidth: 0 }}>{b.role ?? "—"}</span>
                      <Badge tone={b.required ? "danger" : "neutral"}>{b.required ? "required" : "optional"}</Badge>
                    </>
                  ) : b.off_stack ? (
                    <Badge tone="warn"><span title="off_stack" data-raw="off_stack">{OFF_STACK}</span></Badge>
                  ) : (
                    <span style={MONO} title="This product has no stack, so nothing records whether it needs this or could do without.">uses it</span>
                  )}
                </div>
              );
            })
          )}
          {(radius?.alternatives?.length ?? 0) > 0 && (
            <div style={{ borderTop: "1px solid var(--border-hairline)", paddingTop: "var(--space-3)", display: "flex", flexWrap: "wrap", gap: "var(--space-2)", alignItems: "center" }}>
              <span style={MICRO}>alternatives</span>
              {radius.alternatives.map((a) => (
                <a key={a.tech} href={`/tech/${a.tech}`} style={{ ...MONO, textDecoration: "none", border: "1px solid var(--border-default)", borderRadius: "var(--radius-xs)", padding: "2px 8px" }}>
                  {a.tech} · <Term dict={FIT} value={a.fit} />{a.stance ? ` · ${a.stance}` : ""}
                </a>
              ))}
            </div>
          )}
        </Section>

        <Section label="Who has used it" meta={count(encounters.length, "person", "people")}>
          {encounters.length === 0 ? (
            <span style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)" }}>
              Nobody has recorded using this yet.{canWrite ? " Add a handle below." : ""}
            </span>
          ) : (
            <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)" }}>
              {encounters.map((e) => (
                <span key={e.id} style={{ display: "inline-flex", alignItems: "center", gap: 8, border: "1px solid var(--border-default)", borderRadius: "var(--radius-xs)", padding: canWrite ? "2px 4px 2px 10px" : "4px 10px" }}>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)", color: "var(--text-heading)" }}>{e.person}</span>
                  <span style={MONO}>{e.depth}</span>
                  <span style={{ ...MONO, color: "var(--text-secondary)" }}>{e.last_at}</span>
                  {e.product_id && <span style={{ ...MONO, color: "var(--text-secondary)" }}>{productName(e.product_id) ?? ""}</span>}
                  {canWrite && (
                    <IconButton size="sm" label={`Remove ${e.person}`} onClick={() => removeEncounter(e.id)}>
                      <Icon name="x" size={12} />
                    </IconButton>
                  )}
                </span>
              ))}
            </div>
          )}

          {canWrite && (
            <form onSubmit={addEncounter} style={{ display: "flex", gap: "var(--space-2)", alignItems: "center", flexWrap: "wrap" }}>
              <Input
                aria-label="Handle"
                placeholder="handle"
                value={draft.person}
                onChange={(e) => setDraft({ ...draft, person: e.target.value })}
                style={{ maxWidth: 200 }}
              />
              <Select aria-label="How far" value={draft.depth} onChange={(e) => setDraft({ ...draft, depth: e.target.value })}>
                {DEPTHS.map((d) => <option key={d} value={d}>{d}</option>)}
              </Select>
              <Button type="submit" size="sm" disabled={saving || !draft.person.trim()}>
                {saving ? "recording" : "record"}
              </Button>
              <span style={{ ...MONO, color: "var(--text-secondary)" }}>
                your handle and how far you went with it
              </span>
            </form>
          )}
        </Section>
      </div>
    </div>
  );
}
