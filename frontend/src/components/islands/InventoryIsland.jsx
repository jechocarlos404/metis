import React from "react";
import { PageHeader } from "../shell/PageHeader.jsx";
import { Badge, Button, Select, Tag } from "../../ds";
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
  textTransform: "uppercase", color: "var(--text-secondary)",
};
const PANEL = {
  background: "var(--surface-card)", border: "1px solid var(--border-hairline)",
  borderRadius: "var(--radius-md)", overflow: "hidden",
};

const GRID = "minmax(0,1.4fr) 100px minmax(0,1.6fr) 70px";

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
  const [products, setProducts] = React.useState([]);
  const [scored, setScored] = React.useState(""); // product id being scored
  const [score, setScore] = React.useState(null);

  React.useEffect(() => {
    api("/capabilities/inventory").then(setInventory).catch((e) => setError(String(e.message)));
    api("/products").then(setProducts).catch(() => {});
  }, []);

  // An existing product's features become the idea: how much of it could we build?
  const scoreProduct = async (productId) => {
    setScored(productId);
    setScore(null);
    setReport(null);
    setError(null);
    if (!productId) return;
    setChecking(true);
    try {
      const result = await api(`/products/${productId}/coverage`);
      setScore(result);
      setReport(result.report);
    } catch (e) {
      setError(String(e.message));
    } finally {
      setChecking(false);
    }
  };

  const check = async (text = idea) => {
    const features = parseIdea(text);
    if (features.length === 0) {
      setError("Write at least one line as  Feature name: capability, capability");
      return;
    }
    setChecking(true);
    setError(null);
    setScored("");
    setScore(null);
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

  const ours = (inventory ?? []).filter((c) => c.ours);
  // Known only from someone else's product: it exists, we don't have it.
  const elsewhere = (inventory ?? []).filter((c) => !c.ours);
  const rows = ours.filter((c) => !reusedOnly || c.products.length > 1);
  const reused = ours.filter((c) => c.products.length > 1).length;

  return (
    <>
      <PageHeader
        title="Inventory"
        meta={inventory ? `${ours.length} capabilities of ours · ${reused} reused across products · ${elsewhere.length} known elsewhere` : "loading"}
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
          <div style={{ display: "grid", gridTemplateColumns: GRID, padding: "8px 16px", borderBottom: "1px solid var(--border-hairline)", ...CAPS }}>
            <span>Capability</span><span>Maturity</span><span>Products</span><span>Features</span>
          </div>
          {rows.map((c, i) => (
            <div key={c.id} style={{ display: "grid", gridTemplateColumns: GRID, alignItems: "center", gap: 8, padding: "10px 16px", borderBottom: i < rows.length - 1 ? "1px solid var(--border-hairline)" : "none", fontSize: "var(--text-sm)" }}>
              <a href={`/capabilities/${c.slug}`} style={{ color: "var(--text-heading)", fontWeight: "var(--weight-medium)", textDecoration: "none" }}>{c.name}</a>
              <span><Badge tone={MATURITY_TONES[c.maturity] ?? "neutral"}>{c.maturity}</Badge></span>
              <span style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center" }}>
                {c.products.length > 0
                  ? c.products.map((p) => <Tag key={p.id}>{p.name}</Tag>)
                  : <span style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>{c.features > 0 ? "no product" : "unused"}</span>}
                {c.external_products.length > 0 && (
                  <span style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>· also in {c.external_products.map((p) => p.name).join(", ")}</span>
                )}
              </span>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-secondary)" }}>{c.features}</span>
            </div>
          ))}
          {inventory && rows.length === 0 && (
            <div style={{ padding: 16, fontSize: "var(--text-sm)", color: "var(--text-secondary)" }}>
              {reusedOnly ? "0 capabilities are used by more than one product yet." : "0 capabilities. Seed a product to start the inventory."}
            </div>
          )}
          {elsewhere.length > 0 && (
            <>
              <div style={{ padding: "10px 16px", borderTop: "1px solid var(--border-hairline)", borderBottom: "1px solid var(--border-hairline)" }}>
                <div style={{ fontSize: "var(--text-sm)", fontWeight: "var(--weight-semibold)", color: "var(--text-heading)" }}>Known from other products</div>
                <div style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)", marginTop: 2 }}>External products have these; we don't yet.</div>
              </div>
              {elsewhere.map((c, i) => (
                <div key={c.id} style={{ display: "grid", gridTemplateColumns: GRID, alignItems: "center", gap: 8, padding: "10px 16px", borderBottom: i < elsewhere.length - 1 ? "1px solid var(--border-hairline)" : "none", fontSize: "var(--text-sm)" }}>
                  <a href={`/capabilities/${c.slug}`} style={{ color: "var(--text-body)", textDecoration: "none" }}>{c.name}</a>
                  <span style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>not ours</span>
                  <span style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                    {c.external_products.map((p) => <Tag key={p.id}>{p.name}</Tag>)}
                  </span>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-secondary)" }}>0</span>
                </div>
              ))}
            </>
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
              style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)", color: "var(--text-body)", background: "var(--surface-input, var(--surface-card))", border: "1px solid var(--border-control)", borderRadius: "var(--radius-md)", padding: "8px 10px", resize: "vertical" }} />
            <div><Button size="sm" variant="accent" disabled={checking || !idea.trim()} onClick={() => check()}>Check coverage</Button></div>
            {products.length > 0 && (
              <Select label="…or score an existing product" value={scored} onChange={(e) => scoreProduct(e.target.value)}
                options={[{ value: "", label: "— pick a product —" },
                  ...[...products].sort((a, b) => Number(b.external) - Number(a.external) || a.name.localeCompare(b.name))
                    .map((p) => ({ value: p.id, label: p.external ? `${p.name} (external)` : p.name }))]} />
            )}
            {checking && (
              <div role="status" style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>
                {scored ? `Scoring ${products.find((p) => p.id === scored)?.name ?? "product"}…` : "Checking coverage…"}
              </div>
            )}
            {error && <div style={{ fontSize: "var(--text-xs)", color: "var(--danger-fg)" }}>{error}</div>}
          </div>
          {score && <ProductScore score={score} />}
          {report && <CoverageReport report={report} onCandidate={useCandidate} />}
        </section>
      </div>
    </>
  );
}

function ProductScore({ score }) {
  return (
    <div style={{ borderTop: "1px solid var(--border-hairline)", padding: "14px 16px 0", display: "flex", flexDirection: "column", gap: 6, fontSize: "var(--text-xs)" }}>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)", color: "var(--text-heading)" }}>
        {score.buildable.length}/{score.total_features} of {score.product.name}'s features buildable from what we have
      </div>
      {score.buildable.length > 0 && (
        <div style={{ color: "var(--text-secondary)" }}>Buildable now: {score.buildable.join(", ")}</div>
      )}
      {score.known_covered.length > 0 && (
        <div style={{ color: "var(--text-secondary)" }}>
          <span style={{ fontFamily: "var(--font-mono)", color: "var(--text-heading)" }}>+{score.known_covered.length}</span> more where we have every capability anyone could name — weaker, since the unnamed ones may be missing: {score.known_covered.join(", ")}
        </div>
      )}
      {score.unknown_features.length > 0 && (
        <div style={{ color: "var(--text-secondary)" }}>
          A lower bound — {score.unknown_features.length} feature{score.unknown_features.length === 1 ? " has" : "s have"} capabilities nobody has identified yet: {score.unknown_features.join(", ")}
        </div>
      )}
      {!score.report && <div style={{ color: "var(--text-secondary)" }}>No capability links known for this product yet.</div>}
    </div>
  );
}

function CoverageReport({ report, onCandidate }) {
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
