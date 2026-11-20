import React from "react";
import { PageHeader } from "../shell/PageHeader.jsx";
import { Badge, Button, Input } from "../../ds";
import { api } from "../../lib/api.js";
import { NEED, VERDICT, count, freshness, needKey, scoreGroups } from "../../lib/words.js";
import { CapabilityPicker } from "../shared/CapabilityPicker.jsx";
import { CoverageReport } from "../shared/coverage.jsx";
import GetStartedIsland from "./GetStartedIsland.jsx";
import { readParam } from "../../lib/url-state.js";
import { parseIdeaParams } from "../../lib/idea-link.js";

const PANEL = {
  background: "var(--surface-card)", border: "1px solid var(--border-hairline)",
  borderRadius: "var(--radius-md)",
};
const HEAD = { padding: "10px 16px", borderBottom: "1px solid var(--border-hairline)", fontSize: "var(--text-sm)", fontWeight: "var(--weight-semibold)", color: "var(--text-heading)" };
const QUIET = { fontSize: "var(--text-xs)", color: "var(--text-secondary)" };
const LINK = { color: "var(--text-accent)" };
const SCORING_AT_ONCE = 4;

let nextKey = 1;
const newRow = () => ({ key: nextKey++, name: "", caps: [] });

export default function HomeIsland({ canWrite = false, isAdmin = false }) {
  const [products, setProducts] = React.useState(null);
  const [inventory, setInventory] = React.useState(null);
  const [loadError, setLoadError] = React.useState(null);
  const [firstRun, setFirstRun] = React.useState(null); // decided once, on the first load

  const load = React.useCallback(async () => {
    try {
      const [p, inv] = await Promise.all([api("/products"), api("/capabilities/inventory")]);
      setProducts(p);
      setInventory(inv);
      setFirstRun((was) => was ?? (!p.some((x) => !x.external) && inv.length === 0));
    } catch (e) {
      setLoadError(String(e.message));
    }
  }, []);
  React.useEffect(() => { load(); }, [load]);

  if (loadError) {
    return (
      <>
        <PageHeader title="Home" />
        <div role="alert" style={{ padding: 24, fontSize: "var(--text-sm)", color: "var(--danger-fg)" }}>Couldn't load the inventory: {loadError}</div>
      </>
    );
  }
  if (firstRun == null) {
    return (
      <>
        <PageHeader title="Home" meta="loading" />
        <div role="status" style={{ padding: 24, ...QUIET }}>Loading…</div>
      </>
    );
  }
  if (firstRun) {
    return (
      <>
        <PageHeader title="Home" />
        <GetStartedIsland canWrite={canWrite} isAdmin={isAdmin} products={products} onReload={load} />
      </>
    );
  }

  const ours = inventory.filter((c) => c.ours);
  const ourProducts = products.filter((p) => !p.external).length;
  return (
    <>
      <PageHeader
        title="Home"
        meta={`${count(ourProducts, "product")} of ours · ${count(products.length - ourProducts, "external product")} · ${count(ours.length, "capability", "capabilities")} of ours`}
      />
      <div style={{ flex: 1, overflowY: "auto", padding: 20, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(340px, 100%), 1fr))", gap: 20, alignItems: "start" }}>
        <IdeaChecker inventory={inventory} canWrite={canWrite} />
        <div style={{ display: "flex", flexDirection: "column", gap: 20, minWidth: 0 }}>
          <Portfolio products={products} />
          <MostReused inventory={inventory} />
        </div>
      </div>
    </>
  );
}

// ---- What could we build next? -------------------------------------------

function IdeaChecker({ inventory, canWrite }) {
  // A link (/home?idea=…&caps=…, from MCP check_idea) fills one feature and checks it; saving stays the person's.
  const [prefill] = React.useState(() => parseIdeaParams(readParam("idea"), readParam("caps"), inventory));
  const [idea, setIdea] = React.useState(prefill.idea);
  const [rows, setRows] = React.useState(() => [{ ...newRow(), name: prefill.caps.length ? prefill.idea : "", caps: prefill.caps }]);
  const [report, setReport] = React.useState(null);
  const [busy, setBusy] = React.useState(null); // null | "check" | "save"
  const [error, setError] = React.useState(null);
  const [skipped, setSkipped] = React.useState(0); // named features left out of the last check

  const options = React.useMemo(() => inventory.map((c) => ({
    id: c.id, name: c.name, slug: c.slug,
    hint: c.ours ? (c.products.length ? `in ${count(c.products.length, "product")}` : "ours, in no product") : NEED[needKey(c)].label,
  })), [inventory]);

  const setRow = (key, patch) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const removeRow = (key) => setRows((rs) => (rs.length > 1 ? rs.filter((r) => r.key !== key) : rs));

  // Picks without a name, or two features with one name, would silently drop or merge.
  const rowProblem = (current) => {
    if (current.some((r) => !r.name.trim() && r.caps.length > 0)) return "Every feature with capabilities needs a name.";
    const names = current.map((r) => r.name.trim().toLowerCase()).filter(Boolean);
    if (new Set(names).size < names.length) return "Two features have the same name. Give each one its own.";
    return null;
  };

  const check = async (current = rows) => {
    const problem = rowProblem(current);
    if (problem) { setError(problem); return; }
    const features = current
      .filter((r) => r.name.trim() && r.caps.length > 0)
      .map((r) => ({ name: r.name.trim(), capabilities: r.caps }));
    if (features.length === 0) {
      setError("Name a feature and pick at least one capability it needs.");
      return;
    }
    setBusy("check");
    setError(null);
    setSkipped(current.filter((r) => r.name.trim() && r.caps.length === 0).length);
    try {
      setReport(await api("/capabilities/coverage", { method: "POST", body: { features } }));
    } catch (e) {
      setError(String(e.message));
    } finally {
      setBusy(null);
    }
  };

  React.useEffect(() => {
    if (prefill.idea && prefill.caps.length) check();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // A near name was confirmed: swap it in wherever that exact name was picked.
  const useCandidate = (from, to) => {
    const next = rows.map((r) => (r.caps.includes(from)
      ? { ...r, caps: [...new Set(r.caps.map((c) => (c === from ? to : c)))] }
      : r));
    setRows(next);
    check(next);
  };

  const save = async () => {
    const name = idea.trim();
    const steps = rows.filter((r) => r.name.trim()).map((r) => ({ label: r.name.trim(), needs: r.caps }));
    if (!name) { setError("Give the idea a name to save it."); return; }
    const problem = rowProblem(rows);
    if (problem) { setError(problem); return; }
    if (steps.length === 0) { setError("Name at least one feature to save the idea."); return; }
    setBusy("save");
    setError(null);
    try {
      const journey = await api("/journeys", { method: "POST", body: { name, steps } });
      window.location.href = `/journeys?id=${journey.id}`;
    } catch (e) {
      setError(`Couldn't save the idea: ${e.message}`);
      setBusy(null);
    }
  };

  return (
    <section style={{ ...PANEL, minWidth: 0 }} aria-labelledby="idea-title">
      <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border-hairline)" }}>
        <h2 id="idea-title" style={{ fontSize: "var(--text-md)", fontWeight: "var(--weight-semibold)", color: "var(--text-heading)", margin: 0 }}>What could we build next?</h2>
        <div style={{ ...QUIET, marginTop: 4 }}>
          Name an idea and the features it needs, then pick the capabilities each one uses. Names match exactly.
        </div>
      </div>
      <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
        <Input label="Idea" value={idea} onChange={(e) => setIdea(e.target.value)} />
        {rows.map((r, i) => (
          <div key={r.key} style={{ display: "flex", flexDirection: "column", gap: 6, paddingTop: 12, borderTop: "1px solid var(--border-hairline)" }}>
            <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
              <Input label={`Feature ${i + 1}`} value={r.name} style={{ flex: 1 }}
                onChange={(e) => setRow(r.key, { name: e.target.value })} />
              {rows.length > 1 && (
                <Button size="sm" variant="ghost" aria-label={`Remove feature ${i + 1}`} onClick={() => removeRow(r.key)}>Remove</Button>
              )}
            </div>
            <CapabilityPicker id={`idea-row-${r.key}`} label={`Capabilities feature ${i + 1} needs`} options={options} value={r.caps}
              onChange={(caps) => setRow(r.key, { caps })} allowNew placeholder="Capabilities it needs…" />
          </div>
        ))}
        <div>
          <Button size="sm" variant="ghost" onClick={() => setRows((rs) => [...rs, newRow()])}>+ Add a feature</Button>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <Button size="sm" variant="accent" disabled={busy != null} onClick={() => check()}>{busy === "check" ? "Checking…" : "Check"}</Button>
          {canWrite && (
            <Button size="sm" variant="secondary" disabled={busy != null} onClick={save}>{busy === "save" ? "Saving…" : "Save as idea"}</Button>
          )}
        </div>
        {error && <div role="alert" style={{ fontSize: "var(--text-xs)", color: "var(--danger-fg)" }}>{error}</div>}
        {report && skipped > 0 && (
          <div style={QUIET}>{count(skipped, "feature")} with no capabilities picked {skipped === 1 ? "is" : "are"} not in the check.</div>
        )}
      </div>
      {report && <CoverageReport report={report} onCandidate={useCandidate} />}
    </section>
  );
}

// ---- Portfolio -----------------------------------------------------------

function scoreCounts(score) {
  return {
    total: score.total_features,
    groups: scoreGroups(score).map((g) => [g.key, g.names.length]),
  };
}

function Portfolio({ products }) {
  const sorted = React.useMemo(
    () => [...products].sort((a, b) => Number(a.external) - Number(b.external) || a.name.localeCompare(b.name)),
    [products]
  );
  const [scores, setScores] = React.useState({}); // id → counts | "error"

  React.useEffect(() => {
    let cancelled = false;
    // Only external products: ours realize their own capabilities, so they
    // would always read "all buildable".
    const queue = sorted.filter((p) => p.external).map((p) => p.id);
    const worker = async () => {
      while (!cancelled && queue.length) {
        const id = queue.shift();
        let result;
        try {
          result = scoreCounts(await api(`/products/${id}/coverage`));
        } catch {
          result = "error";
        }
        if (!cancelled) setScores((s) => ({ ...s, [id]: result }));
      }
    };
    for (let i = 0; i < SCORING_AT_ONCE; i++) worker();
    return () => { cancelled = true; };
  }, [sorted]);

  return (
    <section style={PANEL} aria-labelledby="portfolio-title">
      <div id="portfolio-title" style={HEAD}>Products</div>
      {sorted.length === 0 ? (
        <div style={{ padding: 16, ...QUIET }}>
          Your products and the ones you compare against will appear here. <a href="/products" style={LINK}>Add a product</a>.
        </div>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {sorted.map((p, i) => (
            <li key={p.id} style={{ borderTop: i ? "1px solid var(--border-hairline)" : "none" }}>
              <a href={`/products?product=${p.id}`} style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap", padding: "9px 16px", textDecoration: "none" }}>
                <span style={{ fontSize: "var(--text-sm)", fontWeight: "var(--weight-medium)", color: "var(--text-heading)" }}>{p.name}</span>
                {p.external && <Badge>external</Badge>}
                {/* Only a real import date says something; "never imported" on every row was noise. */}
                {p.seeded_at && <span title="When its seed file was last imported" style={QUIET}>{freshness(p.seeded_at)}</span>}
                {/* Right-aligned, and on a line of its own when the row is too narrow, so scores line up. */}
                {p.external && <span style={{ marginLeft: "auto" }}><ScoreLine score={scores[p.id]} /></span>}
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ScoreLine({ score }) {
  if (score == null) return <span style={QUIET}>scoring…</span>;
  if (score === "error") return <span style={QUIET}>couldn't score</span>;
  if (score.total === 0) return <span style={QUIET}>no features yet</span>;
  const parts = score.groups.filter(([, n]) => n > 0);
  return (
    <span style={{ ...QUIET, display: "inline-flex", gap: 10, flexWrap: "wrap" }}>
      {parts.map(([kind, n]) => (
        <span key={kind} title={VERDICT[kind].hint}>
          <span style={{ fontFamily: "var(--font-mono)", color: "var(--text-heading)" }}>{n}</span> {VERDICT[kind].label}
        </span>
      ))}
      <span>of {count(score.total, "feature")}</span>
    </span>
  );
}

// ---- Most reused -----------------------------------------------------------

function MostReused({ inventory }) {
  // The inventory comes sorted: ours first, then by how many of our products use it.
  const top = inventory.filter((c) => c.ours && c.products.length > 0).slice(0, 8);
  return (
    <section style={PANEL} aria-labelledby="reused-title">
      <div id="reused-title" style={HEAD}>Most reused</div>
      {top.length === 0 ? (
        <div style={{ padding: 16, ...QUIET }}>
          Capabilities your products use will appear here, most used first. <a href="/capabilities" style={LINK}>See all capabilities</a>.
        </div>
      ) : (
        <>
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {top.map((c, i) => (
              <li key={c.id} style={{ display: "flex", gap: 8, alignItems: "baseline", padding: "8px 16px", borderTop: i ? "1px solid var(--border-hairline)" : "none" }}>
                <a href={`/capabilities/${c.slug}`} style={{ fontSize: "var(--text-sm)", color: "var(--text-heading)", textDecoration: "none" }}>{c.name}</a>
                <span style={{ flex: 1 }} />
                <span style={QUIET}>in {count(c.products.length, "product")}</span>
              </li>
            ))}
          </ul>
          <div style={{ padding: "10px 16px", borderTop: "1px solid var(--border-hairline)", fontSize: "var(--text-xs)" }}>
            <a href="/capabilities" style={LINK}>See all capabilities</a>
          </div>
        </>
      )}
    </section>
  );
}
