import React from "react";
import { Badge } from "../../ds";
import {
  CLOSEST_TITLE, GAP_HINT, MATURITY, NEED, VERDICT, closestGroups, closestNote, count, coverageHeadline, gapNote, gapsTitle,
  incompleteNote, needKey, scoreGroups, scoreHeadline,
} from "../../lib/words.js";
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

// Features of a scored product, grouped by the shared verdict vocabulary,
// after the answer: how much of it we have.
export function ProductScore({ score }) {
  const groups = scoreGroups(score).filter((g) => g.names.length > 0);
  const headline = scoreHeadline(score);
  return (
    <div style={{ borderTop: "1px solid var(--border-hairline)", padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10, fontSize: "var(--text-xs)" }}>
      {headline && <div style={{ fontSize: "var(--text-sm)", color: "var(--text-heading)" }}>{headline}</div>}
      <div style={{ fontSize: "var(--text-sm)", color: "var(--text-heading)", fontWeight: "var(--weight-medium)" }}>
        {score.product.name}: {count(score.total_features, "feature")}
      </div>
      {groups.map((g) => (
        <details key={g.key} open={g.names.length <= 8}>
          <summary style={{ cursor: "pointer", color: "var(--text-heading)", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontFamily: "var(--font-mono)" }}>{g.names.length}</span>
            <VerdictBadge kind={g.key} />
            <span style={{ color: "var(--text-secondary)" }}>{VERDICT[g.key].hint}</span>
          </summary>
          {g.key === "missing" && incompleteNote(score) && (
            <div style={{ margin: "6px 0 0", color: "var(--text-secondary)" }}>{incompleteNote(score)}</div>
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
      {g.slug ? <a href={`/capabilities/${g.slug}`}>{g.name}</a> : g.name}
      <span style={quiet} title={g.only_gap > 0 ? GAP_HINT : undefined}> · {gapNote(g)}</span>
    </li>
  );
  const list = { margin: "6px 0 0", paddingLeft: 18, display: "flex", flexDirection: "column", gap: 2, color: "var(--text-body)" };
  return (
    <div style={{ borderTop: "1px solid var(--border-hairline)", padding: "14px 16px", display: "flex", flexDirection: "column", gap: 12, fontSize: "var(--text-xs)" }}>
      {gaps.length > 0 && (
        <div>
          <div style={{ color: "var(--text-heading)", fontWeight: "var(--weight-medium)" }}>{gapsTitle(gaps)}</div>
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
          <div style={{ color: "var(--text-heading)", fontWeight: "var(--weight-medium)" }}>{CLOSEST_TITLE}</div>
          <ul style={list}>
            {closestGroups(closest).map((group) => (
              <li key={group.products[0].id}>
                {group.products.map((p, i) => (
                  <React.Fragment key={p.id}>
                    {i > 0 && (i === group.products.length - 1 ? " and " : ", ")}
                    <a href={`/products?product=${p.id}`}>{p.name}</a>
                  </React.Fragment>
                ))}
                <span style={quiet}> {closestNote(group, score)}</span>
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
// `scored`: the product whose own features these are, never named as where a
// capability is "known from"; its score above already leads with the headline.
// `verdicts`: say per feature whether we could build it. Only for an idea
// whose every need is named (Home's check): a product's features can be
// partly known, and the report can't tell.
export function CoverageReport({ report, onCandidate, scored, verdicts = false }) {
  return (
    <div style={{ borderTop: "1px solid var(--border-hairline)", padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
      {!scored && <div style={{ fontSize: "var(--text-sm)", color: "var(--text-heading)" }}>{coverageHeadline(report)}</div>}
      {report.missing.length > 0 && (
        <div style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>
          To build: {report.missing.join(", ")}
        </div>
      )}
      {report.features.map((f, i) => (
        <div key={`${i}:${f.name}`} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
            <span style={{ fontSize: "var(--text-sm)", fontWeight: "var(--weight-medium)", color: "var(--text-heading)" }}>{f.name}</span>
            {verdicts && (() => {
              const v = VERDICT[f.existing === f.total ? "buildable" : "missing"];
              return <span title={v.hint}><Badge tone={v.tone}>{v.label}</Badge></span>;
            })()}
            <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>{f.existing} of {f.total} ours</span>
          </div>
          {f.capabilities.map((need, j) => (
            <NeedRow key={`${j}:${need.name}`} need={need} onCandidate={onCandidate} scored={scored} />
          ))}
        </div>
      ))}
    </div>
  );
}

function NeedRow({ need, onCandidate, scored }) {
  const kind = needKey(need.match);
  const n = NEED[kind];
  const quiet = { color: "var(--text-secondary)" };
  const names = (list) => list.map((p) => p.name).join(", ");
  const others = (need.match?.external_products ?? []).filter((p) => p.id !== scored?.id);
  // On the scored product's own page "elsewhere" would mean this product:
  // when nobody else has it, say whose it is instead.
  const onlyHere = kind === "elsewhere" && scored && others.length === 0;
  const chip = { font: "inherit", fontSize: 11, color: "var(--text-accent)", background: "var(--accent-wash)", border: "none", borderRadius: "var(--radius-pill)", padding: "1px 8px", cursor: "pointer", textDecoration: "none" };
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", paddingLeft: 10, fontSize: "var(--text-xs)" }}>
      <span title={n.hint}><Badge tone={n.tone}>{onlyHere ? `only in ${scored.name}` : n.label}</Badge></span>
      {need.match ? (
        <>
          <a href={`/capabilities/${need.match.slug}`}>{need.match.name}</a>
          {/* Maturity describes our implementation: only shown when it's ours. */}
          {kind === "ours" && <MaturityBadge maturity={need.match.maturity} />}
          {kind === "ours" && need.match.products.length > 0 && <span style={quiet}>in {names(need.match.products)}</span>}
          {kind === "elsewhere" && !onlyHere && <span style={quiet}>known from {names(others)}</span>}
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
