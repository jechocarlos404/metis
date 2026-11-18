import React from "react";
import { PageHeader } from "../shell/PageHeader.jsx";
import { Badge } from "../../ds";
import { api } from "../../lib/api.js";
import { CARD, FIT_TONE, MICRO, MONO, STANCE_TONE, formatAsOf } from "../../lib/ontology.js";

/**
 * `/capabilities/[slug]` — the supply frame.
 *
 * The only surface where both sides of supply share a frame, and where the
 * extension's central claim gets argued: a Feature REALIZES this capability,
 * a Technology SATISFIES it, and Capability is the currency both are priced
 * in. Build or buy, in one view, at the moment the question is live.
 *
 * Three rules the layout exists to enforce:
 *   - the currently-bound technology stays in the list, marked. You cannot
 *     re-evaluate a decision you cannot see.
 *   - `workaround` fits are shown and graded, never hidden.
 *   - an empty answer with a reason is a real answer, not an error state.
 */

const FRAME_HALF = {
  flex: "1 1 320px",
  minWidth: 0,
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
};

function Row({ children, accent = false }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-3)",
        padding: "10px 12px",
        borderRadius: "var(--radius-sm)",
        border: "1px solid var(--border-hairline)",
        background: accent ? "var(--accent-wash)" : "var(--surface-card)",
        minWidth: 0,
      }}
    >
      {children}
    </div>
  );
}

function Empty({ children }) {
  return (
    <div
      style={{
        padding: "var(--space-4)",
        border: "1px dashed var(--border-default)",
        borderRadius: "var(--radius-sm)",
        color: "var(--text-disabled)",
        fontSize: "var(--text-sm)",
      }}
    >
      {children}
    </div>
  );
}

export default function CapabilitySupplyIsland({ slug }) {
  const [envelope, setEnvelope] = React.useState(null);
  const [capability, setCapability] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [noteDismissed, setNoteDismissed] = React.useState(false);

  React.useEffect(() => {
    let live = true;
    Promise.all([
      api(`/capabilities/${slug}/supply`),
      api("/capabilities").then((all) => all.find((c) => c.slug === slug) ?? null),
    ])
      .then(([supply, cap]) => {
        if (!live) return;
        setEnvelope(supply);
        setCapability(cap);
      })
      .catch((e) => live && setError(e.detail ?? e.message));
    return () => {
      live = false;
    };
  }, [slug]);

  if (error) {
    return (
      <div style={{ padding: "var(--space-6)", color: "var(--danger-fg)" }}>{String(error)}</div>
    );
  }
  if (!envelope) {
    return <div style={{ padding: "var(--space-6)", ...MICRO }}>loading</div>;
  }

  const offers = envelope.answer;
  const realizations = envelope.realizations ?? [];
  const unresolved = envelope.unresolved ?? [];

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, overflowY: "auto" }}>
      <PageHeader
        title={capability?.name ?? slug}
        meta={
          <span style={MONO}>
            {slug} · {offers.length} offer(s) · {realizations.length} feature(s) ·{" "}
            {formatAsOf(envelope.as_of)}
          </span>
        }
      />

      <div style={{ padding: "var(--space-5)", display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
        {!noteDismissed && (
          <div
            style={{
              ...CARD,
              padding: "12px 14px",
              display: "flex",
              gap: "var(--space-3)",
              alignItems: "flex-start",
              fontSize: "var(--text-sm)",
              color: "var(--text-secondary)",
            }}
          >
            <span style={{ flex: 1, textWrap: "pretty" }}>
              A Capability is the exchange currency. A Feature{" "}
              <code style={MONO}>REALIZES</code> it — the build side. A Technology{" "}
              <code style={MONO}>SATISFIES</code> it — the buy side. Same node, same
              currency, which is what makes build-vs-buy a query rather than a meeting.
            </span>
            <button
              type="button"
              onClick={() => setNoteDismissed(true)}
              style={{
                border: "none",
                background: "none",
                cursor: "pointer",
                color: "var(--text-disabled)",
                ...MICRO,
              }}
            >
              dismiss
            </button>
          </div>
        )}

        {capability?.description && (
          <div style={{ fontSize: "var(--text-md)", color: "var(--text-body)", maxWidth: "68ch", textWrap: "pretty" }}>
            {capability.description}
          </div>
        )}

        {/* The supply frame: the one raised surface on the page. */}
        <div
          style={{
            ...CARD,
            border: "1.5px solid var(--accent)",
            boxShadow: "var(--shadow-raised)",
            padding: "var(--space-4)",
            display: "flex",
            flexWrap: "wrap",
            gap: "var(--space-5)",
          }}
        >
          <section style={FRAME_HALF}>
            <div style={MICRO}>build · REALIZES</div>
            {realizations.length === 0 ? (
              <Empty>No feature realizes this capability yet.</Empty>
            ) : (
              realizations.map((r) => (
                <Row key={r.feature}>
                  <span style={{ flex: 1, fontSize: "var(--text-sm)", color: "var(--text-heading)", minWidth: 0 }}>
                    {r.feature}
                  </span>
                  <span style={MONO}>{r.tickets} ticket(s)</span>
                  {r.product && <span style={MONO}>{r.product}</span>}
                  <Badge tone={r.status === "done" ? "ok" : r.status === "in_progress" ? "accent" : "neutral"}>
                    {r.status}
                  </Badge>
                </Row>
              ))
            )}
          </section>

          <section style={FRAME_HALF}>
            <div style={MICRO}>buy · SATISFIES</div>
            {offers.length === 0 ? (
              <Empty>
                {unresolved[0]?.reason ?? "Nothing satisfies this capability."}
                {unresolved[0]?.blocked_by?.length > 0 && (
                  <div style={{ ...MONO, marginTop: 6 }}>
                    blocked_by {unresolved[0].blocked_by.join(", ")}
                  </div>
                )}
              </Empty>
            ) : (
              offers.map((o) => (
                <Row key={o.tech} accent={o.bound_in.length > 0}>
                  <a
                    href={`/tech/${o.tech}`}
                    style={{
                      flex: 1,
                      fontFamily: "var(--font-mono)",
                      fontSize: "var(--text-sm)",
                      color: "var(--text-heading)",
                      textDecoration: "none",
                      minWidth: 0,
                    }}
                  >
                    {o.tech}
                  </a>
                  {/* Graded, never hidden — a workaround is a known ceiling. */}
                  <Badge tone={FIT_TONE[o.fit] ?? "neutral"}>{o.fit}</Badge>
                  <Badge tone={o.stance ? STANCE_TONE[o.stance] : "neutral"}>
                    {o.stance ?? "no stance"}
                  </Badge>
                  {typeof o.cost?.ops_burden === "number" && (
                    <span style={MONO}>ops {o.cost.ops_burden}</span>
                  )}
                  {o.bound_in.length > 0 && (
                    <span style={{ ...MONO, color: "var(--text-accent)" }}>
                      bound in {o.bound_in.join(", ")}
                    </span>
                  )}
                </Row>
              ))
            )}
          </section>
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-3)" }}>
          <div style={{ ...CARD, flex: "1 1 300px", padding: "var(--space-4)" }}>
            <div style={MICRO}>why the bound offer stays in the list</div>
            <p style={{ margin: "8px 0 0", fontSize: "var(--text-sm)", color: "var(--text-secondary)", textWrap: "pretty" }}>
              Filtering out the current binding would make every alternative
              argue against nothing. You cannot re-evaluate a decision you
              cannot see, so it is marked in place rather than removed.
            </p>
          </div>
          <div style={{ ...CARD, flex: "1 1 300px", padding: "var(--space-4)" }}>
            <div style={MICRO}>why workarounds are shown</div>
            <p style={{ margin: "8px 0 0", fontSize: "var(--text-sm)", color: "var(--text-secondary)", textWrap: "pretty" }}>
              <code style={MONO}>workaround</code> means it can be made to do
              this and someone will be surprised. That is a known ceiling worth
              seeing — hiding it just moves the surprise later.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
