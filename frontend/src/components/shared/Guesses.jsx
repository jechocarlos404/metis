import React from "react";
import { Badge, Button } from "../../ds";
import { api } from "../../lib/api.js";
import { CONFIDENCE } from "../../lib/words.js";

/**
 * Guessed capability links for editors and admins: confirm one to make it a
 * fact, or reject it. Renders nothing when there are none, and nothing for
 * viewers (the API refuses them, so callers mount it only when canWrite).
 *
 *   query:       { feature_id } | { capability_id } | { product_id } | { tech_id }
 *   name:        "capability" shows the guessed capability; "subject" the feature or
 *                technology; "both" shows "feature probably uses capability"
 *   onConfirmed: called after a confirm, so the caller can reload its facts
 */
export function Guesses({ query, name = "capability", title = "Guesses", onConfirmed }) {
  const [rows, setRows] = React.useState([]);
  const [busy, setBusy] = React.useState(null);
  const [error, setError] = React.useState(null);
  const key = new URLSearchParams(query).toString();

  React.useEffect(() => {
    let live = true;
    setRows([]);
    api(`/guesses?${key}`).then((r) => { if (live) setRows(r); }).catch((e) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [key]);

  const act = async (guess, confirm) => {
    setBusy(guess.id);
    setError(null);
    try {
      await api(confirm ? `/guesses/${guess.id}/confirm` : `/guesses/${guess.id}`, { method: confirm ? "POST" : "DELETE" });
      setRows((r) => r.filter((g) => g.id !== guess.id));
      if (confirm) onConfirmed?.(guess);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  };

  if (rows.length === 0 && !error) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>
        {title}: not counted anywhere until you confirm. Only editors and admins see these.
      </div>
      {error && <div role="alert" style={{ fontSize: "var(--text-xs)", color: "var(--danger-fg)" }}>{error}</div>}
      {rows.map((g) => {
        const c = CONFIDENCE[g.confidence];
        return (
          <div key={g.id} style={{ border: "1px dashed var(--border-default)", borderRadius: "var(--radius-sm)", padding: "8px 10px", display: "flex", flexDirection: "column", gap: 6, fontSize: "var(--text-xs)" }}>
            <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
              {name !== "capability" && <Subject guess={g} />}
              {name === "both" && <span style={{ color: "var(--text-secondary)" }}>probably uses</span>}
              {name !== "subject" && <a href={`/capabilities/${g.capability_slug}`} style={{ color: "var(--text-accent)" }}>{g.capability_name}</a>}
              <span title={c.hint}><Badge tone={c.tone}>{c.label}</Badge></span>
            </div>
            {g.basis && <div style={{ color: "var(--text-secondary)" }}>{g.basis}</div>}
            <div style={{ display: "flex", gap: 6 }}>
              <Button size="sm" variant="secondary" disabled={busy === g.id} onClick={() => act(g, true)}>Confirm</Button>
              <Button size="sm" variant="ghost" disabled={busy === g.id} onClick={() => act(g, false)}>Not right</Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Subject({ guess }) {
  return guess.feature_id
    ? <a href={`/features?feature=${guess.feature_id}`} style={{ color: "var(--text-accent)" }}>{guess.subject_name}</a>
    : <span style={{ color: "var(--text-heading)" }}>{guess.subject_name}</span>;
}
