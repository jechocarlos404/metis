import React from "react";
import { Button, DeleteConfirm, Select } from "../../ds";
import { api } from "../../lib/api.js";
import { andList, count, productOptions } from "../../lib/words.js";

// Seed files: how a repo gets into metis (a coding agent describes it as a
// metis-seed/v1 JSON file), and how a project moves between instances.
// Inline panels, not dialogs — they live on Get started and Settings.

// The importer's collections and actions in people's words, as [one, many];
// the raw key stays one hover away.
const COLLECTION_WORDS = {
  goals: ["goal", "goals"],
  capabilities: ["capability", "capabilities"],
  motivations: ["goal link", "goal links"],
  features: ["feature", "features"],
  edges: ["link between features", "links between features"],
  products: ["product", "products"],
  bundles: ["capability added by hand", "capabilities added by hand"],
  decompositions: ["plan document", "plan documents"],
  technologies: ["technology", "technologies"],
  tech_usage: ["technology in use", "technologies in use"],
  satisfactions: ["technology link", "technology links"],
  guesses: ["guess", "guesses"],
};
const ACTION_WORDS = { reused: "already in metis", absent: "not in metis" };

function formatCounts(collection, counts) {
  const entries = Object.entries(counts || {}).filter(([, value]) => value > 0);
  if (entries.length === 0) return null;
  return {
    key: collection,
    text: `${COLLECTION_WORDS[collection][1]}: ${entries.map(([action, value]) => `${value} ${ACTION_WORDS[action] ?? action}`).join(", ")}`,
    raw: `${collection}: ${entries.map(([action, value]) => `${value} ${action}`).join(", ")}`,
  };
}

/** An import that adds, links or updates nothing: every row was reused or
 * skipped. */
const changesNothing = (counts) =>
  Object.values(counts || {}).every((actions) =>
    Object.entries(actions).every(([action, n]) => n === 0 || action === "reused" || action === "skipped"));

export const summarizeCounts = (counts) =>
  Object.keys(COLLECTION_WORDS)
    .map((k) => formatCounts(k, counts?.[k]))
    .filter(Boolean);

const textareaStyle = {
  width: "100%", boxSizing: "border-box", resize: "vertical",
  border: "1px solid var(--border-control)", borderRadius: "var(--radius-md)",
  background: "var(--surface-card)", color: "var(--text-body)",
  fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)", padding: 12, lineHeight: 1.5,
};

const SMALL = { fontSize: "var(--text-xs)", color: "var(--text-secondary)" };
const BOX = { border: "1px solid var(--border-hairline)", borderRadius: "var(--radius-md)", background: "var(--surface-inset)", padding: 12, display: "flex", flexDirection: "column", gap: 8 };
const Title = ({ tone, children }) => (
  <div style={{ fontSize: "var(--text-sm)", fontWeight: "var(--weight-semibold)", color: tone === "danger" ? "var(--danger-fg)" : "var(--text-heading)" }}>{children}</div>
);
const Warnings = ({ result }) => (result.warnings || []).map((w, i) => (
  <div key={`w${i}`} style={{ fontSize: "var(--text-xs)", color: "var(--danger-fg)" }}>{w}</div>
));

/** A note trimmed to fit carries its full text, opened in place so it can be
 * read by touch too, not only on hover. */
function Note({ note, full }) {
  if (!full) return <div style={SMALL}>{note}</div>;
  return (
    <details style={SMALL}>
      <summary style={{ cursor: "pointer" }}>{note}</summary>
      <div style={{ whiteSpace: "pre-line", marginTop: 6, paddingLeft: 12, borderLeft: "2px solid var(--border-default)", color: "var(--text-body)" }}>{full}</div>
    </details>
  );
}

function ResultBox({ title, result, tone }) {
  return (
    <div role="status" style={BOX}>
      <Title tone={tone}>{title}</Title>
      {result.counts && (
        <div style={SMALL}>
          {summarizeCounts(result.counts).map((c, i) => (
            <React.Fragment key={c.key}>{i > 0 && " · "}<span title={c.raw}>{c.text}</span></React.Fragment>
          ))}
          {summarizeCounts(result.counts).length === 0 && "Nothing would change."}
        </div>
      )}
      {(result.notes || []).map((note, i) => <Note key={`n${i}`} note={note} full={result.fullText?.[note]} />)}
      <Warnings result={result} />
    </div>
  );
}

// A removal's outcomes in people's words, in the order a summary reads them.
const OUTCOMES = [
  ["would delete", "Would delete"], ["deleted", "Deleted"], ["kept", "Keeps"],
  ["can't tell", "Can't tell about"], ["absent", "Not in metis:"], ["failed", "Failed to delete"],
];
// Each line starts with what happens to its row.
const LINE_GROUPS = [
  ["kept ", "Kept, and why"], ["can't tell ", "Can't tell"], ["would delete ", "Would delete"], ["deleted ", "Deleted"],
];

/** A removal reads as a short summary by outcome, then its lines grouped the
 * same way, kept ones first and marked apart from the deletes. */
function RemovalBox({ title, result, tone }) {
  const said = {};
  for (const [kind, words] of Object.entries(COLLECTION_WORDS)) {
    for (const [action, n] of Object.entries(result.counts?.[kind] || {})) {
      if (n > 0) (said[action] ??= []).push(count(n, ...words));
    }
  }
  const raw = summarizeCounts(result.counts).map((c) => c.raw).join("; ");
  const notes = result.notes || [];
  const general = notes.filter((note) => !LINE_GROUPS.some(([prefix]) => note.startsWith(prefix)));
  return (
    <div role="status" style={BOX}>
      <Title tone={tone}>{title}</Title>
      <div title={raw} style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: "var(--text-sm)", color: "var(--text-body)" }}>
        {OUTCOMES.filter(([action]) => said[action]).map(([action, words]) => (
          <div key={action}>{action === "kept" && !result.dryRun ? "Kept" : words} {andList(said[action])}.</div>
        ))}
        {Object.keys(said).length === 0 && "Nothing would change."}
      </div>
      {general.map((note, i) => <div key={`g${i}`} style={SMALL}>{note}</div>)}
      {LINE_GROUPS.map(([prefix, heading]) => {
        const lines = notes.filter((note) => note.startsWith(prefix));
        if (lines.length === 0) return null;
        const kept = prefix === "kept ";
        return (
          <div key={prefix} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ ...SMALL, fontWeight: "var(--weight-semibold)", color: "var(--text-heading)" }}>{heading}</div>
            {lines.map((line, i) => (
              <div key={i} style={kept
                ? { fontSize: "var(--text-xs)", color: "var(--text-body)", background: "var(--ok-bg)", borderLeft: "3px solid var(--ok-fg)", padding: "4px 8px", borderRadius: "var(--radius-xs)" }
                : { ...SMALL, paddingLeft: 11 }}>
                {line.slice(prefix.length)}
              </div>
            ))}
          </div>
        );
      })}
      <Warnings result={result} />
    </div>
  );
}

/** A refusal that lists several errors puts each on its own line. */
const failure = (what, message) => `${what}:${String(message).includes("\n") ? "\n" : " "}${message}`;

/** The browser's file button can't be styled, so it stays hidden and a
 * button like every other opens it. */
function FileOrPaste({ id, value, onChange, label }) {
  const input = React.useRef(null);
  const [fileName, setFileName] = React.useState(null);
  const load = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    onChange(await file.text());
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div id={`${id}-label`} style={{ fontSize: "var(--text-sm)", color: "var(--text-body)" }}>{label}</div>
      <input ref={input} id={`${id}-file`} type="file" accept=".json,application/json" onChange={load} hidden />
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", minWidth: 0 }}>
        <Button size="sm" variant="secondary" id={`${id}-choose`} aria-labelledby={`${id}-choose ${id}-label`}
          onClick={() => input.current?.click()}>
          Choose file
        </Button>
        <span style={{ ...SMALL, overflowWrap: "anywhere" }}>{fileName ?? "No file chosen"}</span>
      </div>
      <details>
        <summary style={{ cursor: "pointer", fontSize: "var(--text-xs)", color: "var(--text-accent)" }}>Or paste the file's contents</summary>
        <textarea id={`${id}-text`} aria-label="Seed file contents" rows={10} value={value}
          onChange={(e) => { setFileName(null); onChange(e.target.value); }} placeholder='{"format":"metis-seed/v1", ...}'
          style={{ ...textareaStyle, marginTop: 8 }} />
      </details>
      {value.trim() && <div style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>File loaded ({value.length.toLocaleString()} characters).</div>}
    </div>
  );
}

// The prompt a coding agent needs to describe a repo as a seed file — built by
// the backend from the format spec and the live inventory, so the agent reuses
// today's exact capability names.
export function AgentPromptPanel() {
  const [prompt, setPrompt] = React.useState(null);
  const [capabilities, setCapabilities] = React.useState(0);
  const [state, setState] = React.useState("idle"); // idle | loading | copied | error
  const [error, setError] = React.useState(null);

  const load = async () => {
    setState("loading");
    setError(null);
    try {
      const r = await api("/ontology/agent-export-prompt");
      setPrompt(r.prompt);
      setCapabilities(r.capabilities);
      return r.prompt;
    } catch (e) {
      setError(`Couldn't build the prompt: ${e.message}`);
      setState("error");
      return null;
    }
  };
  const copy = async () => {
    const text = prompt ?? (await load());
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("idle");
      setError("Your browser blocked copying. Open the prompt below and copy it by hand.");
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <ol style={{ margin: 0, paddingLeft: 18, fontSize: "var(--text-sm)", color: "var(--text-body)", lineHeight: "var(--leading-body)" }}>
        <li>Copy the prompt and paste it into a coding agent (Claude Code, Codex, Cursor…) opened in the product's repo.</li>
        <li>It reads the repo and writes <code>metis-seed.json</code>, reusing the capability names metis already has.</li>
        <li>Import that file below.</li>
      </ol>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <Button size="sm" variant="accent" disabled={state === "loading"} onClick={copy}>
          {state === "loading" ? "Building the prompt…" : state === "copied" ? "Copied" : "Copy prompt for a coding agent"}
        </Button>
        {state === "copied" && <span role="status" style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>Includes {capabilities} capability names and the full file format.</span>}
      </div>
      {error && <div role="alert" style={{ fontSize: "var(--text-xs)", color: "var(--danger-fg)" }}>{error}</div>}
      <details onToggle={(e) => { if (e.currentTarget.open && !prompt) load().then(() => setState("idle")); }}>
        <summary style={{ cursor: "pointer", fontSize: "var(--text-xs)", color: "var(--text-accent)" }}>See the prompt</summary>
        <textarea readOnly aria-label="Prompt for a coding agent" value={prompt ?? "Building the prompt…"} rows={12}
          style={{ ...textareaStyle, marginTop: 8, fontSize: 11 }} />
      </details>
    </div>
  );
}

/** Check, then import, a seed file. Check is a dry run with the loader's own rules. */
export function SeedImportPanel({ onImported }) {
  const [text, setText] = React.useState("");
  const [result, setResult] = React.useState(null);
  const [action, setAction] = React.useState(null); // null | "check" | "import"
  const [error, setError] = React.useState(null);

  const run = async (dryRun) => {
    setAction(dryRun ? "check" : "import");
    setError(null);
    try {
      const r = await api("/seed/import", { method: "POST", body: { document: text, dryRun } });
      setResult(r);
      if (!dryRun) onImported?.(r);
    } catch (e) {
      setResult(null);
      setError(failure(dryRun ? "The check failed" : "The import failed", e.message));
    } finally {
      setAction(null);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <FileOrPaste id="seed-import" label="Seed file (metis-seed.json)" value={text} onChange={(v) => { setText(v); setResult(null); setError(null); }} />
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Button size="sm" variant="secondary" disabled={action != null || !text.trim()} onClick={() => run(true)}>
          {action === "check" ? "Checking…" : "Check file"}
        </Button>
        <Button size="sm" variant="accent" disabled={action != null || !text.trim()} onClick={() => run(false)}>
          {action === "import" ? "Importing…" : "Import"}
        </Button>
      </div>
      <div style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>
        Importing adds what's new and updates the status and description of features already in metis. Check file lists every change first.
      </div>
      {error && <div role="alert" style={{ fontSize: "var(--text-xs)", color: "var(--danger-fg)", whiteSpace: "pre-line" }}>{error}</div>}
      {result && (
        <ResultBox result={result} title={
          changesNothing(result.counts)
            ? `${result.dryRun ? "Check passed. " : ""}Nothing new: everything in this file ${result.dryRun ? "is" : "was"} already in metis.`
            : result.dryRun ? "Check passed. This is what the import would do:" : "Imported"
        } />
      )}
      <SeedExport />
    </div>
  );
}

/** Export sits beside import: download one product as a seed file, to keep a
 * copy or import it into another metis. Hidden until there is a product. */
function SeedExport() {
  const [products, setProducts] = React.useState([]);
  const [productId, setProductId] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [status, setStatus] = React.useState(null); // { tone, text }

  React.useEffect(() => {
    api("/products").then(setProducts).catch(() => setProducts([]));
  }, []);
  if (products.length === 0) return null;

  const download = async () => {
    setBusy(true);
    setStatus(null);
    try {
      const filename = await exportSeedFile(productId);
      setStatus({ tone: "ok", text: `Downloaded ${filename}.` });
    } catch (e) {
      setStatus({ tone: "danger", text: `The export failed: ${e.message}` });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, borderTop: "1px solid var(--border-hairline)", paddingTop: 12 }}>
      <div style={{ fontSize: "var(--text-sm)", color: "var(--text-body)" }}>
        Or download a product as a seed file, to keep a copy or import it into another metis.
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <Select aria-label="Product to download" value={productId} onChange={(e) => { setProductId(e.target.value); setStatus(null); }}
          style={{ flex: "1 1 200px", maxWidth: 320 }}
          options={[{ value: "", label: "Choose a product" }, ...productOptions(products)]} />
        <Button size="sm" variant="secondary" disabled={busy || !productId} onClick={download}>
          {busy ? "Downloading…" : "Download seed file"}
        </Button>
      </div>
      {status && (
        <div role={status.tone === "danger" ? "alert" : "status"} style={{ fontSize: "var(--text-xs)", color: status.tone === "danger" ? "var(--danger-fg)" : "var(--text-secondary)" }}>
          {status.text}
        </div>
      )}
    </div>
  );
}

/** Remove what a seed file added. Preview is required before the delete unlocks. */
export function UnseedPanel({ onRemoved }) {
  const [text, setText] = React.useState("");
  const [result, setResult] = React.useState(null);
  const [action, setAction] = React.useState(null); // null | "preview" | "delete"
  const [error, setError] = React.useState(null);
  // Armed, like every other delete: Remove asks once more.
  const [confirming, setConfirming] = React.useState(false);

  const run = async (dryRun) => {
    setAction(dryRun ? "preview" : "delete");
    setConfirming(false);
    setError(null);
    try {
      const r = await api("/seed/unseed", { method: "POST", body: { document: text, dryRun } });
      setResult(r);
      if (!dryRun) onRemoved?.(r);
    } catch (e) {
      setResult(null);
      setError(failure(dryRun ? "The preview failed" : "The removal failed", e.message));
    } finally {
      setAction(null);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <FileOrPaste id="seed-remove" label="The seed file you imported" value={text} onChange={(v) => { setText(v); setResult(null); setError(null); setConfirming(false); }} />
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <Button size="sm" variant="secondary" disabled={action != null || !text.trim()} onClick={() => run(true)}>
          {action === "preview" ? "Previewing…" : "Preview removal"}
        </Button>
        <DeleteConfirm armed={confirming} onArm={() => setConfirming(true)} onCancel={() => setConfirming(false)}
          onConfirm={() => run(false)} disabled={action != null || !text.trim() || !result?.dryRun}
          label="Remove" confirmLabel="Remove what the preview lists" style={{ flexWrap: "wrap" }} />
        {action === "delete" && <span role="status" style={SMALL}>Removing…</span>}
      </div>
      <div style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>
        Anything another product still uses is kept, and the preview says why.
      </div>
      {error && <div role="alert" style={{ fontSize: "var(--text-xs)", color: "var(--danger-fg)", whiteSpace: "pre-line" }}>{error}</div>}
      {result && <RemovalBox title={result.dryRun ? "Preview: this is what would be removed" : "Removed"} result={result} tone={result.warnings?.length ? "danger" : undefined} />}
    </div>
  );
}

/** Download one product as a seed file. */
export async function exportSeedFile(productId) {
  const res = await fetch(`/api/seed/export?productId=${encodeURIComponent(productId)}`);
  const body = await res.json();
  if (!res.ok) throw new Error(body.detail || "Export failed");
  const blob = new Blob([JSON.stringify(body.document, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = body.filename || "metis-seed.json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return body.filename || "metis-seed.json";
}
