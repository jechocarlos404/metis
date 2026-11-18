import React from "react";
import { PageHeader } from "../shell/PageHeader.jsx";
import { Badge, Button, Select } from "../../ds";
import { productOptions } from "../../lib/words.js";
import { api } from "../../lib/api.js";
import { CoverageReport, MATURITY_TONES, ProductScore } from "../shared/coverage.jsx";


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
  const [find, setFind] = React.useState("");
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
    if (productId) setIdea(""); // the idea box would otherwise describe something other than the score shown
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
  const needle = find.trim().toLowerCase();
  const rows = ours.filter((c) => (!reusedOnly || c.products.length > 1) && (!needle || c.name.toLowerCase().includes(needle) || c.products.some((p) => p.name.toLowerCase().includes(needle))));
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
            <input type="search" value={find} onChange={(e) => setFind(e.target.value)} placeholder="Find a capability or product" aria-label="Find a capability or product"
              style={{ width: 220, height: 28, padding: "0 8px", fontSize: "var(--text-xs)", fontFamily: "var(--font-body)", color: "var(--text-body)", background: "var(--surface-card)", border: "1px solid var(--border-control)", borderRadius: "var(--radius-sm)" }} />
            <label style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: "var(--text-xs)", color: "var(--text-secondary)", cursor: "pointer" }}>
              <input type="checkbox" checked={reusedOnly} onChange={(e) => setReusedOnly(e.target.checked)} />
              reused only
            </label>
          </div>
          <div role="table" aria-label="Capabilities we have">
          <div role="row" style={{ display: "grid", gridTemplateColumns: GRID, padding: "8px 16px", borderBottom: "1px solid var(--border-hairline)", ...CAPS }}>
            <span role="columnheader">Capability</span><span role="columnheader">Maturity</span><span role="columnheader">Products</span><span role="columnheader">Features</span>
          </div>
          {rows.map((c, i) => (
            <div role="row" key={c.id} style={{ display: "grid", gridTemplateColumns: GRID, alignItems: "center", gap: 8, padding: "10px 16px", borderBottom: i < rows.length - 1 ? "1px solid var(--border-hairline)" : "none", fontSize: "var(--text-sm)" }}>
              <span role="cell"><a href={`/capabilities/${c.slug}`} style={{ color: "var(--text-heading)", fontWeight: "var(--weight-medium)", textDecoration: "none" }}>{c.name}</a></span>
              <span role="cell"><Badge tone={MATURITY_TONES[c.maturity] ?? "neutral"}>{c.maturity}</Badge></span>
              <span role="cell" style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center" }}>
                {c.products.length > 0
                  ? c.products.map((p, j) => <a key={p.id} href={`/products?product=${p.id}`} style={{ fontSize: "var(--text-xs)", color: "var(--text-accent)" }}>{p.name}{j < c.products.length - 1 ? "," : ""}</a>)
                  : <span style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>{c.features > 0 ? "no product" : "unused"}</span>}
                {c.external_products.length > 0 && (
                  <span style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>· also in {c.external_products.map((p) => p.name).join(", ")}</span>
                )}
              </span>
              <span role="cell" style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-secondary)" }}>{c.features}</span>
            </div>
          ))}
          </div>
          {!inventory && (
            <div role="status" style={{ padding: 16, fontSize: "var(--text-sm)", color: "var(--text-secondary)" }}>Loading the inventory…</div>
          )}
          {inventory && rows.length === 0 && (
            <div style={{ padding: 16, fontSize: "var(--text-sm)", color: "var(--text-secondary)" }}>
              {needle ? `No capability or product matches "${find.trim()}".` : reusedOnly ? "No capability is used by more than one product yet." : "No capabilities yet. Seed a product to start the inventory."}
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
                    {c.external_products.map((p, j) => <a key={p.id} href={`/products?product=${p.id}`} style={{ fontSize: "var(--text-xs)", color: "var(--text-accent)" }}>{p.name}{j < c.external_products.length - 1 ? "," : ""}</a>)}
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
                  ...productOptions(products)]} />
            )}
            {checking && (
              <div role="status" style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>
                {scored ? `Scoring ${products.find((p) => p.id === scored)?.name ?? "product"}…` : "Checking coverage…"}
              </div>
            )}
            {error && <div style={{ fontSize: "var(--text-xs)", color: "var(--danger-fg)" }}>{error}</div>}
          </div>
          {report && <CoverageReport report={report} onCandidate={useCandidate} />}
          {score && <ProductScore score={score} />}
          {score && !report && <div style={{ borderTop: "1px solid var(--border-hairline)", padding: 16, fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>No capability links known for this product yet.</div>}
        </section>
      </div>
    </>
  );
}

