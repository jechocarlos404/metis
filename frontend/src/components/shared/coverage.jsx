import React from "react";
import { Badge } from "../../ds";

export const MATURITY_TONES = {
  planned: "neutral",
  alpha: "warn",
  beta: "accent",
  ga: "ok",
  deprecated: "danger",
  retired: "danger",
};

// Features of a scored product, grouped by how sure we are they're buildable.
export function ProductScore({ score }) {
  const groups = [
    { key: "buildable", label: "Buildable now", hint: "every capability known and ours", names: score.buildable },
    { key: "known", label: "Probably buildable", hint: "we have every capability named so far, but some aren't identified yet", names: score.known_covered },
    { key: "unknown", label: "Capabilities not identified yet", hint: "can't be scored until someone names them", names: score.unknown_features.filter((n) => !score.known_covered.includes(n)) },
  ].filter((g) => g.names.length > 0);
  return (
    <div style={{ borderTop: "1px solid var(--border-hairline)", padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10, fontSize: "var(--text-xs)" }}>
      <div style={{ fontSize: "var(--text-sm)", color: "var(--text-heading)", fontWeight: "var(--weight-medium)" }}>
        {score.product.name}: {score.total_features} feature{score.total_features === 1 ? "" : "s"}
      </div>
      {groups.map((g) => (
        <details key={g.key} open={g.names.length <= 8}>
          <summary style={{ cursor: "pointer", color: "var(--text-heading)" }}>
            <span style={{ fontFamily: "var(--font-mono)" }}>{g.names.length}</span> {g.label}
            <span style={{ color: "var(--text-secondary)" }}> · {g.hint}</span>
          </summary>
          <ul style={{ margin: "6px 0 0", paddingLeft: 18, columns: g.names.length > 6 ? 2 : 1, columnGap: 24, color: "var(--text-body)" }}>
            {g.names.map((n) => <li key={n} style={{ breakInside: "avoid" }}>{n}</li>)}
          </ul>
        </details>
      ))}
      {score.buildable.length === 0 && score.unknown_features.length > 0 && (
        <div style={{ color: "var(--text-secondary)" }}>
          Nothing counts as buildable yet because the features still have unidentified capabilities; that's a lower bound, not a verdict.
        </div>
      )}
    </div>
  );
}

export function CoverageReport({ report, onCandidate }) {
  return (
    <div style={{ borderTop: "1px solid var(--border-hairline)", padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)", color: "var(--text-heading)" }}>
        {report.existing}/{report.needed} capabilities we have · {report.mature} proven (beta+)
      </div>
      {report.missing.length > 0 && (
        <div style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>
          To build: {report.missing.join(", ")}
        </div>
      )}
      {report.features.map((f) => (
        <div key={f.name} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
            <span style={{ fontSize: "var(--text-sm)", fontWeight: "var(--weight-medium)", color: "var(--text-heading)" }}>{f.name}</span>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-secondary)" }}>{f.existing}/{f.total}</span>
          </div>
          {f.capabilities.map((need) => (
            <div key={need.name} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", paddingLeft: 10, fontSize: "var(--text-xs)" }}>
              {need.match && !need.match.ours ? (
                <>
                  <Badge tone="warn">missing</Badge>
                  <span style={{ color: "var(--text-body)" }}>{need.match.name}</span>
                  <span style={{ color: "var(--text-secondary)" }}>known from {need.match.external_products.map((p) => p.name).join(", ")}</span>
                </>
              ) : need.match ? (
                <>
                  <Badge tone="ok">exists</Badge>
                  <span style={{ color: "var(--text-body)" }}>{need.match.name}</span>
                  <Badge tone={MATURITY_TONES[need.match.maturity] ?? "neutral"}>{need.match.maturity}</Badge>
                  {need.match.products.length > 0 && (
                    <span style={{ color: "var(--text-secondary)" }}>in {need.match.products.map((p) => p.name).join(", ")}</span>
                  )}
                </>
              ) : (
                <>
                  <Badge tone="warn">missing</Badge>
                  <span style={{ color: "var(--text-body)" }}>{need.name}</span>
                  {need.candidates.length > 0 && <span style={{ color: "var(--text-secondary)" }}>did you mean</span>}
                  {need.candidates.map((c) => (
                    <button key={c.id} type="button" onClick={() => onCandidate(need.name, c.name)}
                      style={{ font: "inherit", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-accent)", background: "var(--accent-wash)", border: "none", borderRadius: "var(--radius-pill)", padding: "1px 8px", cursor: "pointer" }}>
                      {c.name}
                    </button>
                  ))}
                </>
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
