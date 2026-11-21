import React from "react";
import { Badge, Button, DeleteConfirm } from "../../ds";
import { api } from "../../lib/api.js";
import { CONFIDENCE } from "../../lib/words.js";

// Rejecting deletes the row; a seed file that still lists the guess makes it again.
const REJECT_NOTE = "Importing a seed file that still lists it brings it back.";

/**
 * Guessed capability links for editors and admins: confirm one to make it a
 * fact, or reject it. Renders nothing when there are none, and nothing for
 * viewers (the API refuses them, so callers mount it only when canWrite).
 *
 * A confirmed or rejected guess keeps its card, with the buttons swapped for
 * what happened, so the card below never moves under the pointer. Rejecting
 * deletes the guess, so it asks first.
 *
 *   query:       { feature_id } | { capability_id } | { product_id } | { tech_id }
 *   name:        "capability" shows the guessed capability; "subject" the feature or
 *                technology; "both" shows "feature guessed to use capability", with
 *                the pill beside it saying how sure
 *   onConfirmed: called after a confirm, so the caller can reload its facts
 *   onCount:     called with how many guesses still wait for a decision
 */
export function Guesses({ query, name = "capability", title = "Guesses", onConfirmed, onCount }) {
  const [rows, setRows] = React.useState([]);
  const [busy, setBusy] = React.useState(null);
  const [rejecting, setRejecting] = React.useState(null); // guess id armed for reject
  const [done, setDone] = React.useState({}); // guess id → "confirmed" | "rejected"
  const [error, setError] = React.useState(null);
  const key = new URLSearchParams(query).toString();

  React.useEffect(() => {
    let live = true;
    setRows([]);
    setDone({});
    api(`/guesses?${key}`).then((r) => { if (live) setRows(r); }).catch((e) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [key]);

  const act = async (guess, confirm) => {
    setBusy(guess.id);
    setError(null);
    try {
      await api(confirm ? `/guesses/${guess.id}/confirm` : `/guesses/${guess.id}`, { method: confirm ? "POST" : "DELETE" });
      setDone((d) => ({ ...d, [guess.id]: confirm ? "confirmed" : "rejected" }));
      if (confirm) onConfirmed?.(guess);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
      setRejecting(null);
    }
  };

  // The product a guessed feature belongs to, so a card reads on its own.
  const showSubject = name !== "capability";
  const [productNames, setProductNames] = React.useState({});
  const needProducts = showSubject && rows.some((g) => g.product_id);
  React.useEffect(() => {
    if (!needProducts) return;
    api("/products").then((ps) => setProductNames(Object.fromEntries(ps.map((p) => [p.id, p.name])))).catch(() => {});
  }, [needProducts]);

  const open = rows.filter((g) => !done[g.id]).length;
  React.useEffect(() => { if (rows.length) onCount?.(open); }, [open, rows.length]);

  if (rows.length === 0 && !error) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>
        {title}: not counted anywhere until you confirm. Only editors and admins see these.
      </div>
      {error && <div role="alert" style={{ fontSize: "var(--text-xs)", color: "var(--danger-fg)" }}>{error}</div>}
      {rows.map((g) => {
        const c = CONFIDENCE[g.confidence];
        const state = done[g.id];
        return (
          <div key={g.id} style={{ border: "1px dashed var(--border-default)", borderRadius: "var(--radius-sm)", padding: "8px 10px", display: "flex", flexDirection: "column", gap: 6, fontSize: "var(--text-xs)", opacity: state === "rejected" ? 0.6 : 1 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
              {showSubject && <Subject guess={g} product={productNames[g.product_id]} />}
              {name === "both" && <span style={{ color: "var(--text-secondary)" }}>guessed to use</span>}
              {name !== "subject" && <a href={`/capabilities/${g.capability_slug}`} style={{ color: "var(--text-accent)" }}>{g.capability_name}</a>}
              <span title={c.hint}><Badge tone={c.tone}>{c.label}</Badge></span>
            </div>
            {g.basis && <div style={{ color: "var(--text-secondary)" }}>{g.basis}</div>}
            <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", minHeight: 28 }}>
              {!state && (
                <>
                  <Button size="sm" variant="secondary" disabled={busy === g.id} onClick={() => act(g, true)}>Confirm</Button>
                  <DeleteConfirm armed={rejecting === g.id} onArm={() => setRejecting(g.id)} onCancel={() => setRejecting(null)}
                    onConfirm={() => act(g, false)} disabled={busy === g.id} label="Reject" confirmLabel="Reject guess" />
                  {rejecting === g.id && <span style={{ color: "var(--text-secondary)" }}>{REJECT_NOTE}</span>}
                </>
              )}
              <span role="status" style={{ color: state === "confirmed" ? "var(--ok-fg)" : "var(--text-secondary)" }}>
                {state === "confirmed" && <>Confirmed. {g.subject_name} now counts as using <a href={`/capabilities/${g.capability_slug}`}>{g.capability_name}</a>.</>}
                {state === "rejected" && `Removed. ${REJECT_NOTE}`}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Subject({ guess, product }) {
  return (
    <>
      {guess.feature_id
        ? <a href={`/features?feature=${guess.feature_id}`} style={{ color: "var(--text-accent)" }}>{guess.subject_name}</a>
        : <span style={{ color: "var(--text-heading)" }}>{guess.subject_name}</span>}
      {product && <span style={{ color: "var(--text-secondary)" }}>in {product}</span>}
    </>
  );
}
