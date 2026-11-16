import React from "react";
import { PageHeader } from "../shell/PageHeader.jsx";
import { Badge, Button, Tag } from "../../ds";
import { api } from "../../lib/api.js";

const MATURITY_TONES = {
  planned: "neutral",
  alpha: "warn",
  beta: "accent",
  ga: "ok",
  deprecated: "danger",
  retired: "danger",
};

const CAPS = {
  fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "var(--tracking-caps)",
  textTransform: "uppercase", color: "var(--text-disabled)",
};
const PANEL = {
  background: "var(--surface-card)", border: "1px solid var(--border-hairline)",
  borderRadius: "var(--radius-md)", overflow: "hidden",
};

const PLACEHOLDER = `Predict climb time from weather: Strava import, Physics model, Weather forecast
Import past rides: Strava import`;

/** One feature per line — "Feature name: capability, capability". */
function parseIdea(text) {
  return text
    .split("\n")
    .map((line) => {
      const at = line.indexOf(":");
      if (at < 0) return null;
      const name = line.slice(0, at).trim();
      const capabilities = line.slice(at + 1).split(",").map((c) => c.trim()).filter(Boolean);
      return name && capabilities.length ? { name, capabilities } : null;
    })
    .filter(Boolean);
}

/** Swap one capability name for another everywhere it is listed. */
function replaceNeed(text, from, to) {
  return text
    .split("\n")
    .map((line) => {
      const at = line.indexOf(":");
      if (at < 0) return line;
      const caps = line.slice(at + 1).split(",").map((c) => (c.trim() === from ? to : c.trim()));
      return `${line.slice(0, at)}: ${caps.filter(Boolean).join(", ")}`;
    })
    .join("\n");
}

export default function InventoryIsland() {
  const [inventory, setInventory] = React.useState(null);
  const [reusedOnly, setReusedOnly] = React.useState(false);
  const [idea, setIdea] = React.useState("");
  const [report, setReport] = React.useState(null);
  const [checking, setChecking] = React.useState(false);
  const [error, setError] = React.useState(null);

  React.useEffect(() => {
    api("/capabilities/inventory").then(setInventory).catch((e) => setError(String(e.message)));
  }, []);

  const check = async (text = idea) => {
    const features = parseIdea(text);
    if (features.length === 0) {
      setError("Write at least one line as  Feature name: capability, capability");
      return;
    }
    setChecking(true);
    setError(null);
    try {
      setReport(await api("/capabilities/coverage", { method: "POST", body: { features } }));
    } catch (e) {
      setError(String(e.message));
    } finally {
      setChecking(false);
    }
  };

  const useCandidate = (from, to) => {
    const next = replaceNeed(idea, from, to);
    setIdea(next);
    check(next);
  };

  const rows = (inventory ?? []).filter((c) => !reusedOnly || c.products.length > 1);
  const reused = (inventory ?? []).filter((c) => c.products.length > 1).length;

  return (
    <>
      <PageHeader
        title="Inventory"
        meta={inventory ? `${inventory.length} capabilities · ${reused} reused across products` : "loading"}
      />
      <div style={{ flex: 1, overflowY: "auto", padding: 20, display: "grid", gridTemplateColumns: "minmax(0,3fr) minmax(320px,2fr)", gap: 20, alignItems: "start" }}>
        <section style={PANEL}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 16px", borderBottom: "1px solid var(--border-hairline)" }}>
            <span style={{ fontSize: "var(--text-sm)", fontWeight: "var(--weight-semibold)", color: "var(--text-heading)" }}>What we can already do</span>
            <span style={{ flex: 1 }} />
            <label style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: "var(--text-xs)", color: "var(--text-secondary)", cursor: "pointer" }}>
              <input type="checkbox" checked={reusedOnly} onChange={(e) => setReusedOnly(e.target.checked)} />
              reused only
            </label>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1.4fr) 100px minmax(0,1.6fr) 70px", padding: "8px 16px", borderBottom: "1px solid var(--border-hairline)", ...CAPS }}>
            <span>Capability</span><span>Maturity</span><span>Products</span><span>Features</span>
          </div>
          {rows.map((c, i) => (
            <div key={c.id} style={{ display: "grid", gridTemplateColumns: "minmax(0,1.4fr) 100px minmax(0,1.6fr) 70px", alignItems: "center", gap: 8, padding: "10px 16px", borderBottom: i < rows.length - 1 ? "1px solid var(--border-hairline)" : "none", fontSize: "var(--text-sm)" }}>
              <a href={`/capabilities/${c.slug}`} style={{ color: "var(--text-heading)", fontWeight: "var(--weight-medium)", textDecoration: "none" }}>{c.name}</a>
              <span><Badge tone={MATURITY_TONES[c.maturity] ?? "neutral"}>{c.maturity}</Badge></span>
              <span style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                {c.products.length > 0
                  ? c.products.map((p) => <Tag key={p.id}>{p.name}</Tag>)
                  : <span style={{ fontSize: "var(--text-xs)", color: "var(--text-disabled)" }}>{c.features > 0 ? "no product" : "unused"}</span>}
              </span>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-secondary)" }}>{c.features}</span>
            </div>
          ))}
          {inventory && rows.length === 0 && (
            <div style={{ padding: 16, fontSize: "var(--text-sm)", color: "var(--text-disabled)" }}>
              {reusedOnly ? "0 capabilities are used by more than one product yet." : "0 capabilities. Seed a product to start the inventory."}
            </div>
          )}
        </section>

        <section style={{ ...PANEL, display: "flex", flexDirection: "column" }}>
          <div style={{ padding: "10px 16px", borderBottom: "1px solid var(--border-hairline)" }}>
            <div style={{ fontSize: "var(--text-sm)", fontWeight: "var(--weight-semibold)", color: "var(--text-heading)" }}>Could we build this?</div>
            <div style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)", marginTop: 4 }}>
              One feature per line — <code>Feature: capability, capability</code>. Names match exactly; near names are offered, never assumed.
            </div>
          </div>
          <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
            <textarea rows={6} value={idea} placeholder={PLACEHOLDER} onChange={(e) => setIdea(e.target.value)}
              style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)", color: "var(--text-body)", background: "var(--surface-input, var(--surface-card))", border: "1px solid var(--border-default)", borderRadius: "var(--radius-md)", padding: "8px 10px", resize: "vertical" }} />
            <div><Button size="sm" variant="accent" disabled={checking || !idea.trim()} onClick={() => check()}>Check coverage</Button></div>
            {error && <div style={{ fontSize: "var(--text-xs)", color: "var(--danger-fg)" }}>{error}</div>}
          </div>
          {report && <CoverageReport report={report} onCandidate={useCandidate} />}
        </section>
      </div>
    </>
  );
}

function CoverageReport({ report, onCandidate }) {
  return (
    <div style={{ borderTop: "1px solid var(--border-hairline)", padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)", color: "var(--text-heading)" }}>
        {report.existing}/{report.needed} capabilities exist · {report.mature} proven (beta+)
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
              {need.match ? (
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
