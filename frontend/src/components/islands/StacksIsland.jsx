import React from "react";
import { PageHeader } from "../shell/PageHeader.jsx";
import { Badge, Button, Select } from "../../ds";
import { api } from "../../lib/api.js";
import { CARD, FIT_TONE, FLAG_TONE, LAYERS, MICRO, MONO, STANCE_TONE } from "../../lib/ontology.js";

/**
 * `/stacks` — a product's stack as layers of slots, and the resolver.
 *
 * Gaps, drift and redundancy are not three features on this screen. They are
 * three predicates over one slot row, computed by the API and rendered as
 * flags. Get the slot right and the reports write themselves.
 *
 * The resolver never auto-fills. An empty required slot is information the PRD
 * has to answer before tickets are cut; a plausible wrong binding is not. The
 * only write here is a human clicking bind.
 */

const SLOT_COLUMNS = "140px 150px minmax(240px,1fr) 92px";

function LayerCard({ layer, slots, activeId, onPick }) {
  const gaps = slots.filter((s) => s.flags.includes("gap")).length;
  const redundant = slots.filter((s) => s.flags.includes("redundant")).length;
  return (
    <div style={{ ...CARD, overflow: "hidden" }}>
      <div style={{ display: "flex", gap: "var(--space-3)", alignItems: "baseline", padding: "8px 14px", background: "var(--surface-inset)", borderBottom: "1px solid var(--border-hairline)" }}>
        <span style={{ ...MICRO, color: "var(--text-heading)", fontWeight: "var(--weight-semibold)" }}>{layer}</span>
        <span style={MONO}>
          {slots.length} slot(s){gaps ? ` · ${gaps} gap` : ""}{redundant ? ` · ${redundant} redundancy` : ""}
        </span>
      </div>
      <div style={{ overflowX: "auto" }}>
        <div style={{ minWidth: 660 }}>
          {slots.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => onPick(s)}
              style={{
                display: "grid",
                gridTemplateColumns: SLOT_COLUMNS,
                gap: 12,
                alignItems: "center",
                width: "100%",
                textAlign: "left",
                padding: "7px 8px",
                border: "none",
                cursor: "pointer",
                borderRadius: "var(--radius-sm)",
                background: s.id === activeId ? "var(--accent-wash)" : "transparent",
                boxShadow: s.id === activeId ? "inset 2px 0 0 var(--accent)" : "none",
                transition: "background 120ms var(--ease-out)",
              }}
            >
              <span style={{ fontSize: "var(--text-sm)", color: "var(--text-heading)" }}>{s.role}</span>
              <span style={MONO}>{s.capability ?? "—"}</span>
              <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                {s.tech ? (
                  <span style={{ ...MONO, fontSize: "var(--text-xs)", border: "1px solid var(--border-default)", borderRadius: "var(--radius-xs)", padding: "2px 8px", color: "var(--text-heading)" }}>
                    {s.tech}
                  </span>
                ) : (
                  <span style={{ ...MONO, fontSize: "var(--text-xs)", border: "1px dashed var(--ink-4)", borderRadius: "var(--radius-xs)", padding: "2px 8px", color: "var(--text-disabled)" }}>
                    unfilled
                  </span>
                )}
                {s.fit && <span style={MONO}>fit {s.fit}</span>}
              </span>
              <span style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                {s.flags.map((f) => (
                  <Badge key={f} tone={FLAG_TONE[f] ?? "neutral"}>{f}</Badge>
                ))}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function StacksIsland({ initialSlot = "", canWrite = false }) {
  const [stacks, setStacks] = React.useState([]);
  const [products, setProducts] = React.useState([]);
  const [productId, setProductId] = React.useState("");
  const [view, setView] = React.useState(null);
  const [activeSlot, setActiveSlot] = React.useState(null);
  const [offers, setOffers] = React.useState(null);
  const [binding, setBinding] = React.useState(false);
  const [error, setError] = React.useState(null);

  React.useEffect(() => {
    Promise.all([api("/stacks"), api("/products")])
      .then(([s, p]) => {
        setStacks(s);
        setProducts(p);
        const first = s.find((x) => x.product_id);
        if (first) setProductId(first.product_id);
      })
      .catch((e) => setError(e.detail ?? e.message));
  }, []);

  const archetypes = stacks.filter((s) => s.is_archetype);
  const productStack = stacks.find((s) => s.product_id === productId) ?? null;

  const loadView = React.useCallback(() => {
    if (!productStack) return setView(null);
    api(`/stacks/${productStack.id}`)
      .then(setView)
      .catch((e) => setError(e.detail ?? e.message));
  }, [productStack?.id]);

  React.useEffect(loadView, [loadView]);

  // The active slot lives in the URL, so a resolved slot is linkable.
  React.useEffect(() => {
    const url = new URL(window.location.href);
    if (activeSlot) url.searchParams.set("slot", activeSlot.id);
    else url.searchParams.delete("slot");
    window.history.replaceState(null, "", url);
  }, [activeSlot]);

  React.useEffect(() => {
    if (!view || !initialSlot) return;
    const found = view.slots.find((s) => s.id === initialSlot);
    if (found && !activeSlot) setActiveSlot(found);
  }, [view, initialSlot]);

  React.useEffect(() => {
    if (!activeSlot) return setOffers(null);
    setOffers(null);
    api(`/stacks/slots/${activeSlot.id}/offers`)
      .then(setOffers)
      .catch((e) => setError(e.detail ?? e.message));
  }, [activeSlot?.id]);

  async function bind(techId) {
    setBinding(true);
    setError(null);
    try {
      await api(`/stacks/slots/${activeSlot.id}/bind`, { method: "POST", body: { tech_id: techId } });
      loadView();
      const refreshed = await api(`/stacks/${productStack.id}`);
      setActiveSlot(refreshed.slots.find((s) => s.id === activeSlot.id) ?? null);
    } catch (e) {
      setError(e.detail?.message ?? e.detail ?? e.message);
    } finally {
      setBinding(false);
    }
  }

  const byLayer = LAYERS.map((l) => [l, (view?.slots ?? []).filter((s) => s.layer === l)]).filter(
    ([, s]) => s.length > 0,
  );
  const gaps = (view?.slots ?? []).filter((s) => s.flags.includes("gap")).length;

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, overflowY: "auto" }}>
      <PageHeader
        title="Stacks"
        meta={
          <span style={MONO}>
            {archetypes.length} archetype(s) · {stacks.length - archetypes.length} product stack(s) ·{" "}
            {gaps} gap(s) · {view?.drift.length ?? 0} drift
          </span>
        }
        actions={
          <Select value={productId} onChange={(e) => { setProductId(e.target.value); setActiveSlot(null); }}>
            {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        }
      />

      {error && (
        <div style={{ padding: "8px 24px", fontSize: "var(--text-sm)", color: "var(--danger-fg)" }}>{String(error)}</div>
      )}

      <div style={{ padding: "var(--space-5)", display: "flex", flexDirection: "column", gap: "var(--space-5)" }}>
        <section style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
          <div style={MICRO}>archetypes — slots with capabilities, tech unbound</div>
          {archetypes.length === 0 ? (
            <span style={{ fontSize: "var(--text-sm)", color: "var(--text-disabled)" }}>No archetypes defined.</span>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px,1fr))", gap: "var(--space-3)" }}>
              {archetypes.map((a) => (
                <div key={a.id} style={{ ...CARD, padding: 14 }}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                    <span style={{ flex: 1, fontSize: 15, fontWeight: "var(--weight-semibold)", color: "var(--text-heading)" }}>{a.name}</span>
                    <span style={{ ...MONO, color: "var(--text-disabled)" }}>{a.display_id}</span>
                  </div>
                  {a.description && (
                    <div style={{ marginTop: 6, fontSize: "var(--text-sm)", color: "var(--text-secondary)" }}>{a.description}</div>
                  )}
                  <div style={{ ...MONO, marginTop: 8 }}>
                    {a.slots} slot(s) · {a.required_slots} required · {a.instances} instance(s)
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-5)", alignItems: "flex-start" }}>
          <div style={{ flex: "1 1 620px", minWidth: 0, display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: "var(--space-3)" }}>
              <span style={MICRO}>
                product stack{productStack ? ` · ${productStack.name}` : ""}
              </span>
              <span style={{ flex: 1 }} />
              <span style={{ ...MONO, color: "var(--text-disabled)" }}>click a slot to resolve it</span>
            </div>

            {!productStack ? (
              <div style={{ ...CARD, padding: "var(--space-4)", color: "var(--text-disabled)", fontSize: "var(--text-sm)" }}>
                This product has no stack yet.
              </div>
            ) : (
              byLayer.map(([layer, slots]) => (
                <LayerCard key={layer} layer={layer} slots={slots} activeId={activeSlot?.id} onPick={setActiveSlot} />
              ))
            )}

            {(view?.drift.length ?? 0) > 0 && (
              <div style={{ ...CARD, padding: "var(--space-4)" }}>
                <div style={MICRO}>drift — used, but no slot ever declared it</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
                  {view.drift.map((d) => (
                    <a key={d.tech_id} href={`/tech/${d.slug}`} style={{ ...MONO, textDecoration: "none", border: "1px solid var(--border-default)", borderRadius: "var(--radius-xs)", padding: "2px 8px" }}>
                      {d.slug}
                    </a>
                  ))}
                </div>
              </div>
            )}

            {(view?.unanswered_concerns.length ?? 0) > 0 && (
              <div style={{ ...CARD, padding: "var(--space-4)" }}>
                <div style={MICRO}>unanswered concerns — review blockers, not roadmap items</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
                  {view.unanswered_concerns.map((c) => <Badge key={c} tone="warn">{c}</Badge>)}
                </div>
              </div>
            )}
          </div>

          {/* The resolver: the one raised surface on the page. */}
          <aside style={{ flex: "1 1 300px", maxWidth: 420, position: "sticky", top: 80, ...CARD, border: "1.5px solid var(--accent)", boxShadow: "var(--shadow-raised)", padding: "var(--space-4)", display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
            <div style={{ ...MICRO, color: "var(--text-accent)" }}>stack_recommender</div>
            {!activeSlot ? (
              <div style={{ fontSize: "var(--text-sm)", color: "var(--text-disabled)" }}>Select a slot.</div>
            ) : (
              <>
                <div style={{ fontSize: "var(--text-lg)", fontWeight: "var(--weight-semibold)", color: "var(--text-heading)" }}>
                  {activeSlot.capability ?? activeSlot.role}
                </div>
                <div style={MONO}>
                  {activeSlot.layer} · {activeSlot.role} · {offers?.offers.length ?? 0} offer(s)
                </div>

                {offers === null ? (
                  <div style={MICRO}>loading</div>
                ) : offers.offers.length === 0 ? (
                  <div style={{ padding: "var(--space-4)", border: "1px dashed var(--border-default)", borderRadius: "var(--radius-sm)", color: "var(--text-disabled)", fontSize: "var(--text-sm)" }}>
                    No offer survives the constraints on this product.
                    {offers.blocked_by.length > 0 && (
                      <div style={{ ...MONO, marginTop: 6 }}>blocked_by {offers.blocked_by.join(", ")}</div>
                    )}
                  </div>
                ) : (
                  offers.offers.map((o) => {
                    const bound = o.tech_id === activeSlot.tech_id;
                    return (
                      <div key={o.tech_id} style={{ border: `1px solid ${bound ? "var(--accent)" : "var(--border-hairline)"}`, background: bound ? "var(--accent-wash)" : "var(--surface-card)", borderRadius: "var(--radius-sm)", padding: "10px 12px", display: "flex", flexDirection: "column", gap: 6 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <a href={`/tech/${o.slug}`} style={{ flex: 1, fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)", color: "var(--text-heading)", textDecoration: "none" }}>{o.slug}</a>
                          <Badge tone={o.stance ? STANCE_TONE[o.stance] : "neutral"}>{o.stance ?? "no stance"}</Badge>
                        </div>
                        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                          <Badge tone={FIT_TONE[o.fit] ?? "neutral"}>fit {o.fit}</Badge>
                          {typeof o.cost?.ops_burden === "number" && <span style={MONO}>ops {o.cost.ops_burden}</span>}
                          {o.experience && <span style={MONO}>{o.experience} here</span>}
                          <span style={{ flex: 1 }} />
                          {bound ? (
                            <span style={{ ...MONO, color: "var(--text-accent)" }}>bound</span>
                          ) : canWrite ? (
                            <Button size="sm" variant="accent" disabled={binding} onClick={() => bind(o.tech_id)}>bind</Button>
                          ) : null}
                        </div>
                        {o.notes && <div style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)", textWrap: "pretty" }}>{o.notes}</div>}
                      </div>
                    );
                  })
                )}

                <div style={{ borderTop: "1px solid var(--border-hairline)", paddingTop: "var(--space-3)", fontSize: "var(--text-xs)", color: "var(--text-secondary)", textWrap: "pretty" }}>
                  {activeSlot.tech_id ? (
                    <>
                      Ranked by fit, then adoption, then ops burden.
                      {canWrite && (
                        <Button size="sm" style={{ marginTop: 8 }} disabled={binding} onClick={() => bind(null)}>
                          unbind
                        </Button>
                      )}
                    </>
                  ) : (
                    "No offer is bound to this slot. Nothing is auto-filled — an empty required slot is a gap the PRD has to answer before tickets are cut."
                  )}
                </div>
              </>
            )}
          </aside>
        </section>
      </div>
    </div>
  );
}
