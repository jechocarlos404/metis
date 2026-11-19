import React from "react";
import { Select, StatusBadge, Tag } from "../../ds";
import { count } from "../../lib/words.js";
import { CoverageReport, ProductScore } from "../shared/coverage.jsx";

const heading = { fontSize: "var(--text-sm)", fontWeight: "var(--weight-semibold)", color: "var(--text-heading)", marginBottom: 8 };
const muted = { fontSize: "var(--text-sm)", color: "var(--text-secondary)" };
const panel = { background: "var(--surface-card)", border: "1px solid var(--border-hairline)", borderRadius: "var(--radius-md)" };

// The product's profile: how much of it we could build, its features by
// capability, the journeys that pass through it, and hand-added capabilities.
export function WhatItDoes({ product, features, score, capabilities, journeys, bundles, canWrite, onAddBundle, onRemoveBundle }) {
  const capById = React.useMemo(() => new Map(capabilities.map((c) => [c.id, c])), [capabilities]);
  if (features == null) {
    return <div role="status" style={muted}>Loading {product.name}'s features…</div>;
  }

  // A feature realizing several capabilities is listed under each.
  const groups = new Map();
  const unnamed = [];
  for (const f of features) {
    const caps = (f.capability_ids ?? []).filter((id) => capById.has(id));
    if (caps.length === 0) unnamed.push(f);
    for (const id of caps) {
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(f);
    }
  }
  const grouped = [...groups.entries()]
    .map(([id, list]) => ({ cap: capById.get(id), list }))
    .sort((a, b) => b.list.length - a.list.length || a.cap.name.localeCompare(b.cap.name));

  const featureIds = new Set(features.map((f) => f.id));
  const through = (journeys ?? [])
    .map((j) => ({ j, here: j.steps.filter((s) => s.feature_id && featureIds.has(s.feature_id)).length }))
    .filter((x) => x.here > 0);

  const sharedWith = (cap) => {
    const others = [...(cap.products ?? []), ...(cap.external_products ?? [])].filter((p) => p.id !== product.id);
    return others.length;
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <section style={panel}>
        <div style={{ padding: "12px 16px", fontSize: "var(--text-sm)", fontWeight: "var(--weight-semibold)", color: "var(--text-heading)" }}>
          {product.external ? `How much of ${product.name} we could build` : "Coverage"}
        </div>
        {score == null && <div role="status" style={{ padding: "0 16px 14px", fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>Scoring…</div>}
        {score === false && <div style={{ padding: "0 16px 14px", fontSize: "var(--text-xs)", color: "var(--danger-fg)" }}>Couldn't score this product.</div>}
        {score && <ProductScore score={score} />}
        {score && score.report && (
          <details style={{ borderTop: "1px solid var(--border-hairline)" }}>
            <summary style={{ padding: "10px 16px", cursor: "pointer", fontSize: "var(--text-xs)", color: "var(--text-accent)" }}>Capability by capability</summary>
            <CoverageReport report={score.report} />
          </details>
        )}
        {score && !score.report && <div style={{ padding: "0 16px 14px", fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>No capability links known for this product yet.</div>}
      </section>

      <section>
        <div style={heading}>Features by capability</div>
        {features.length === 0 ? (
          <div style={muted}>
            No features recorded for {product.name} yet.
            {canWrite ? (
              <>
                {" "}The quickest way in is a seed file: <a href="/settings">add one from its repo</a>. To map it by hand instead, go in this order:
                <ol style={{ margin: "6px 0 0", paddingLeft: 20, display: "flex", flexDirection: "column", gap: 2 }}>
                  <li>Name the capabilities it uses on <a href="/capabilities">Capabilities</a>.</li>
                  <li>Add its features on <a href="/features">Features</a> and pick a capability for each.</li>
                  <li>Say why: create a goal on <a href="/goals">Goals</a>, then link it from each capability's page.</li>
                </ol>
              </>
            ) : " An editor or admin can add them."}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {grouped.map(({ cap, list }) => {
              const n = sharedWith(cap);
              return (
                <FeatureGroup key={cap.id} features={list} showStatus={!product.external}
                  title={<a href={`/capabilities/${cap.slug}`} style={{ color: "var(--text-heading)" }}>{cap.name}</a>}
                  note={n > 0 ? `shared with ${count(n, "other product")}` : null} />
              );
            })}
            {unnamed.length > 0 && (
              <FeatureGroup features={unnamed} showStatus={!product.external}
                title={<span style={{ color: "var(--text-secondary)" }}>No capability named yet</span>} />
            )}
          </div>
        )}
      </section>

      {through.length > 0 && (
        <section>
          <div style={heading}>Journeys through {product.name} · {through.length}</div>
          <div style={panel}>
            {through.map(({ j, here }, i) => (
              <a key={j.id} href={`/journeys?id=${j.id}`}
                style={{ display: "flex", gap: 12, alignItems: "baseline", padding: "9px 14px", borderBottom: i < through.length - 1 ? "1px solid var(--border-hairline)" : "none", textDecoration: "none", fontSize: "var(--text-sm)" }}>
                <span style={{ flex: 1, minWidth: 0, color: "var(--text-heading)" }}>{j.name}</span>
                <span style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>{here} of {count(j.steps.length, "step")} here</span>
              </a>
            ))}
          </div>
        </section>
      )}

      {(bundles.length > 0 || canWrite) && (
        <Bundles bundles={bundles} capabilities={capabilities} canWrite={canWrite} onAdd={onAddBundle} onRemove={onRemoveBundle} />
      )}
    </div>
  );
}

function FeatureGroup({ title, note, features, showStatus }) {
  return (
    <div style={panel}>
      <div style={{ display: "flex", gap: 8, alignItems: "baseline", padding: "9px 14px", borderBottom: "1px solid var(--border-hairline)", fontSize: "var(--text-sm)", fontWeight: "var(--weight-medium)" }}>
        {title}
        {note && <span style={{ fontSize: "var(--text-xs)", fontWeight: "var(--weight-regular)", color: "var(--text-secondary)" }}>{note}</span>}
      </div>
      {features.map((f, i) => (
        <a key={f.id} href={`/features?feature=${f.id}`}
          style={{ display: "flex", gap: 12, alignItems: "center", padding: "8px 14px 8px 24px", borderBottom: i < features.length - 1 ? "1px solid var(--border-hairline)" : "none", textDecoration: "none", fontSize: "var(--text-sm)" }}>
          <span style={{ flex: 1, minWidth: 0, color: "var(--text-body)" }}>{f.name}</span>
          {showStatus && <StatusBadge status={f.status} />}
        </a>
      ))}
    </div>
  );
}

function Bundles({ bundles, capabilities, canWrite, onAdd, onRemove }) {
  const have = new Set(bundles.map((c) => c.id));
  const addable = capabilities.filter((c) => !have.has(c.id)).sort((a, b) => a.name.localeCompare(b.name));
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ fontSize: "var(--text-xs)", fontWeight: "var(--weight-semibold)", color: "var(--text-secondary)" }}>Capabilities added by hand</div>
      {bundles.length > 0 ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {bundles.map((c) => (
            <Tag key={c.id} onRemove={canWrite ? () => onRemove(c.id) : undefined}>
              <a href={`/capabilities/${c.slug}`} style={{ color: "inherit", textDecoration: "none" }}>{c.name}</a>
            </Tag>
          ))}
        </div>
      ) : (
        <div style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>For a capability it offers without a feature.</div>
      )}
      {canWrite && addable.length > 0 && (
        <details>
          <summary style={{ cursor: "pointer", fontSize: "var(--text-xs)", color: "var(--text-accent)" }}>Add one</summary>
          <div style={{ maxWidth: 320, marginTop: 8 }}>
            <Select aria-label="Capability to add" value="" onChange={(e) => e.target.value && onAdd(e.target.value)}
              options={[{ value: "", label: "Choose a capability" }, ...addable.map((c) => ({ value: c.id, label: c.name }))]} />
          </div>
        </details>
      )}
    </section>
  );
}
