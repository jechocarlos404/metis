import React from "react";
import { Button } from "../../ds";
import { api } from "../../lib/api.js";

// Seed files: how a repo gets into metis (a coding agent describes it as a
// metis-seed/v1 JSON file), and how a project moves between instances.
// Inline panels, not dialogs — they live on Get started and Settings.

function formatCounts(collection, counts) {
  if (!counts) return null;
  const detail = Object.entries(counts)
    .filter(([, value]) => value > 0)
    .map(([action, value]) => `${value} ${action}`)
    .join(", ");
  return detail ? `${collection}: ${detail}` : null;
}

export const summarizeCounts = (counts) =>
  ["goals", "capabilities", "motivations", "features", "edges", "products", "bundles", "decompositions"]
    .map((k) => formatCounts(k, counts?.[k]))
    .filter(Boolean);

const textareaStyle = {
  width: "100%", boxSizing: "border-box", resize: "vertical",
  border: "1px solid var(--border-control)", borderRadius: "var(--radius-md)",
  background: "var(--surface-card)", color: "var(--text-body)",
  fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)", padding: 12, lineHeight: 1.5,
};

function ResultBox({ title, result, tone }) {
  return (
    <div role="status" style={{ border: "1px solid var(--border-hairline)", borderRadius: "var(--radius-md)", background: "var(--surface-inset)", padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ fontSize: "var(--text-sm)", fontWeight: "var(--weight-semibold)", color: tone === "danger" ? "var(--danger-fg)" : "var(--text-heading)" }}>{title}</div>
      {result.counts && (
        <div style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>{summarizeCounts(result.counts).join(" · ") || "Nothing would change."}</div>
      )}
      {(result.notes || []).map((note, i) => (
        <div key={`n${i}`} style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>{note}</div>
      ))}
      {(result.warnings || []).map((w, i) => (
        <div key={`w${i}`} style={{ fontSize: "var(--text-xs)", color: "var(--danger-fg)" }}>{w}</div>
      ))}
    </div>
  );
}

function FileOrPaste({ id, value, onChange, label }) {
  const load = async (event) => {
    const file = event.target.files?.[0];
    if (file) onChange(await file.text());
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <label htmlFor={`${id}-file`} style={{ fontSize: "var(--text-sm)", color: "var(--text-body)" }}>{label}</label>
      <input id={`${id}-file`} type="file" accept=".json,application/json" onChange={load} />
      <details>
        <summary style={{ cursor: "pointer", fontSize: "var(--text-xs)", color: "var(--text-accent)" }}>Or paste the file's contents</summary>
        <textarea id={`${id}-text`} aria-label="Seed file contents" rows={10} value={value}
          onChange={(e) => onChange(e.target.value)} placeholder='{"format":"metis-seed/v1", ...}'
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
      setError(`${dryRun ? "The check failed" : "The import failed"}: ${e.message}`);
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
        Importing only adds. Anything already in metis under the same name is kept as it is.
      </div>
      {error && <div role="alert" style={{ fontSize: "var(--text-xs)", color: "var(--danger-fg)" }}>{error}</div>}
      {result && <ResultBox title={result.dryRun ? "Check passed. This is what the import would do:" : "Imported"} result={result} />}
    </div>
  );
}

/** Remove what a seed file added. Preview is required before the delete unlocks. */
export function UnseedPanel({ onRemoved }) {
  const [text, setText] = React.useState("");
  const [result, setResult] = React.useState(null);
  const [action, setAction] = React.useState(null); // null | "preview" | "delete"
  const [error, setError] = React.useState(null);

  const run = async (dryRun) => {
    setAction(dryRun ? "preview" : "delete");
    setError(null);
    try {
      const r = await api("/seed/unseed", { method: "POST", body: { document: text, dryRun } });
      setResult(r);
      if (!dryRun) onRemoved?.(r);
    } catch (e) {
      setResult(null);
      setError(`${dryRun ? "The preview failed" : "The removal failed"}: ${e.message}`);
    } finally {
      setAction(null);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <FileOrPaste id="seed-remove" label="The seed file you imported" value={text} onChange={(v) => { setText(v); setResult(null); setError(null); }} />
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Button size="sm" variant="secondary" disabled={action != null || !text.trim()} onClick={() => run(true)}>
          {action === "preview" ? "Previewing…" : "Preview removal"}
        </Button>
        <Button size="sm" variant="danger" disabled={action != null || !text.trim() || !result?.dryRun} onClick={() => run(false)}>
          {action === "delete" ? "Removing…" : "Remove"}
        </Button>
      </div>
      <div style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>
        Capabilities and goals other products still use are kept, and reported as warnings.
      </div>
      {error && <div role="alert" style={{ fontSize: "var(--text-xs)", color: "var(--danger-fg)" }}>{error}</div>}
      {result && <ResultBox title={result.dryRun ? "Preview: this is what would be removed" : "Removed"} result={result} tone={result.warnings?.length ? "danger" : undefined} />}
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
