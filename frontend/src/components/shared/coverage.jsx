import React from "react";
import { Badge } from "../../ds";
import { MATURITY, NEED, VERDICT, count, coverageHeadline, needKey, scoreGroups } from "../../lib/words.js";
import { Term } from "./Term.jsx";

export const MATURITY_TONES = {
  planned: "neutral",
  alpha: "warn",
  beta: "accent",
  ga: "ok",
  deprecated: "danger",
  retired: "danger",
};

export function MaturityBadge({ maturity }) {
  if (!maturity) return null;
  return <Badge tone={MATURITY_TONES[maturity] ?? "neutral"}><Term dict={MATURITY} value={maturity} /></Badge>;
}

function VerdictBadge({ kind }) {
  const v = VERDICT[kind];
  return <span title={v.hint}><Badge tone={v.tone}>{v.label}</Badge></span>;
}

// Features of a scored product, grouped by the shared verdict vocabulary.
export function ProductScore({ score }) {
  const groups = scoreGroups(score).filter((g) => g.names.length > 0);
  return (
    <div style={{ borderTop: "1px solid var(--border-hairline)", padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10, fontSize: "var(--text-xs)" }}>
      <div style={{ fontSize: "var(--text-sm)", color: "var(--text-heading)", fontWeight: "var(--weight-medium)" }}>
        {score.product.name}: {score.total_features} feature{score.total_features === 1 ? "" : "s"}
      </div>
      {score.buildable.length === 0 && score.partly.length > 0 && (
        <div style={{ color: "var(--text-secondary)" }}>
          Nothing counts as buildable yet: its features still have capabilities nobody has named. Partly known is the useful number here.
        </div>
      )}
      {groups.map((g) => (
        <details key={g.key} open={g.names.length <= 8}>
          <summary style={{ cursor: "pointer", color: "var(--text-heading)", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontFamily: "var(--font-mono)" }}>{g.names.length}</span>
            <VerdictBadge kind={g.key} />
            <span style={{ color: "var(--text-secondary)" }}>{VERDICT[g.key].hint}</span>
          </summary>
          {g.key === "missing" && score.missing_incomplete.length > 0 && (
            <div style={{ margin: "6px 0 0", color: "var(--text-secondary)" }}>
              {score.missing_incomplete.length === g.names.length ? `All ${g.names.length}` : `${score.missing_incomplete.length} of these`}
              {" "}also have capabilities nobody has named yet, so adding what's named may not be enough.
            </div>
          )}
          <ul style={{ margin: "6px 0 0", paddingLeft: 18, columns: g.names.length > 6 ? 2 : 1, columnGap: 24, color: "var(--text-body)" }}>
            {g.names.map((n) => <li key={n} style={{ breakInside: "avoid" }}>{n}</li>)}
          </ul>
        </details>
      ))}
    </div>
  );
}

// A scored product's missing capabilities, the ones that would cover the most
// features first, and the products of ours that already have the most of what
// it names. Both come ranked from the API.
export function BuildNext({ score }) {
  const gaps = score.missing_capabilities;
  const closest = score.closest_products;
  if (gaps.length === 0 && closest.length === 0) return null;
  const shown = 5;
  const quiet = { color: "var(--text-secondary)" };
  const gapRow = (g) => (
    <li key={g.slug ?? g.name}>
      {g.slug ? <a href={`/capabilities/${g.slug}`} style={{ color: "var(--text-body)" }}>{g.name}</a> : g.name}
      <span style={quiet}>
        {" "}· needed by {count(g.features, "feature")}
        {g.only_gap > 0 && `; adding it covers everything named for ${g.only_gap} of them`}
        {" "}· {g.elsewhere.length > 0 ? `also in ${g.elsewhere.map((p) => p.name).join(", ")}` : "in no other product"}
      </span>
    </li>
  );
  const list = { margin: "6px 0 0", paddingLeft: 18, display: "flex", flexDirection: "column", gap: 2, color: "var(--text-body)" };
  return (
    <div style={{ borderTop: "1px solid var(--border-hairline)", padding: "14px 16px", display: "flex", flexDirection: "column", gap: 12, fontSize: "var(--text-xs)" }}>
      {gaps.length > 0 && (
        <div>
          <div style={{ color: "var(--text-heading)", fontWeight: "var(--weight-medium)" }}>
            {count(gaps.length, "capability", "capabilities")} we don't have, most useful first
          </div>
          <ul style={list}>{gaps.slice(0, shown).map(gapRow)}</ul>
          {gaps.length > shown && (
            <details>
              <summary style={{ cursor: "pointer", marginTop: 4, color: "var(--text-accent)" }}>{gaps.length - shown} more</summary>
              <ul style={list}>{gaps.slice(shown).map(gapRow)}</ul>
            </details>
          )}
        </div>
      )}
      {closest.length > 0 && (
        <div>
          <div style={{ color: "var(--text-heading)", fontWeight: "var(--weight-medium)" }}>Closest of our products</div>
          <ul style={list}>
            {closest.map((c) => (
              <li key={c.product.id}>
                <a href={`/products?product=${c.product.id}`} style={{ color: "var(--text-body)" }}>{c.product.name}</a>
                <span style={quiet}> has {c.capabilities} of the {score.report.needed} capabilities {score.product.name}'s features name</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// onCandidate(needName, candidateName) swaps a near name in; without it, a
// candidate is a link to that capability so the person can judge it.
export function CoverageReport({ report, onCandidate }) {
  return (
    <div style={{ borderTop: "1px solid var(--border-hairline)", padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ fontSize: "var(--text-sm)", color: "var(--text-heading)" }}>{coverageHeadline(report)}</div>
      {report.missing.length > 0 && (
        <div style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>
          To build: {report.missing.join(", ")}
        </div>
      )}
      {report.features.map((f, i) => (
        <div key={`${i}:${f.name}`} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
            <span style={{ fontSize: "var(--text-sm)", fontWeight: "var(--weight-medium)", color: "var(--text-heading)" }}>{f.name}</span>
            <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>{f.existing} of {f.total} ours</span>
          </div>
          {f.capabilities.map((need, j) => (
            <NeedRow key={`${j}:${need.name}`} need={need} onCandidate={onCandidate} />
          ))}
        </div>
      ))}
    </div>
  );
}

function NeedRow({ need, onCandidate }) {
  const kind = needKey(need.match);
  const n = NEED[kind];
  const chip = { font: "inherit", fontSize: 11, color: "var(--text-accent)", background: "var(--accent-wash)", border: "none", borderRadius: "var(--radius-pill)", padding: "1px 8px", cursor: "pointer", textDecoration: "none" };
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", paddingLeft: 10, fontSize: "var(--text-xs)" }}>
      <span title={n.hint}><Badge tone={n.tone}>{n.label}</Badge></span>
      {need.match ? (
        <>
          <a href={`/capabilities/${need.match.slug}`} style={{ color: "var(--text-body)" }}>{need.match.name}</a>
          {kind === "ours" && <MaturityBadge maturity={need.match.maturity} />}
          {kind === "ours" && need.match.products.length > 0 && (
            <span style={{ color: "var(--text-secondary)" }}>in {need.match.products.map((p) => p.name).join(", ")}</span>
          )}
          {kind === "elsewhere" && (
            <span style={{ color: "var(--text-secondary)" }}>known from {need.match.external_products.map((p) => p.name).join(", ")}</span>
          )}
        </>
      ) : (
        <>
          <span style={{ color: "var(--text-body)" }}>{need.name}</span>
          {need.candidates.length > 0 && <span style={{ color: "var(--text-secondary)" }}>did you mean</span>}
          {need.candidates.map((c) =>
            onCandidate ? (
              <button key={c.id} type="button" onClick={() => onCandidate(need.name, c.name)} style={chip}>{c.name}</button>
            ) : (
              <a key={c.id} href={`/capabilities/${c.slug}`} style={chip}>{c.name}</a>
            )
          )}
        </>
      )}
    </div>
  );
}
