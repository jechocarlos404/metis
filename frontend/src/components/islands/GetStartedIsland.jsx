import React from "react";
import { api } from "../../lib/api.js";
import { AgentPromptPanel, SeedImportPanel } from "../shared/SeedFiles.jsx";

// Shown instead of Home on an instance with no products of ours and no
// capabilities. Every tick comes from real state, re-read after an import.

const LINK = { color: "var(--text-accent)" };

function Step({ n, done, title, optional, children }) {
  return (
    <li style={{ display: "flex", gap: 14, padding: "16px 0", borderTop: "1px solid var(--border-hairline)" }}>
      <span aria-hidden="true" style={{
        flex: "none", width: 24, height: 24, borderRadius: "var(--radius-pill)", display: "inline-flex", alignItems: "center", justifyContent: "center",
        fontSize: "var(--text-xs)", fontFamily: "var(--font-mono)",
        background: done ? "var(--ok-bg)" : "var(--surface-inset)", color: done ? "var(--ok-fg)" : "var(--text-secondary)",
      }}>{done ? "✓" : n}</span>
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ fontSize: "var(--text-sm)", fontWeight: "var(--weight-semibold)", color: "var(--text-heading)" }}>
          {title}
          {optional && <span style={{ fontWeight: "var(--weight-regular)", color: "var(--text-secondary)" }}> (optional)</span>}
          {done && <span style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}> (done)</span>}
        </div>
        {children}
      </div>
    </li>
  );
}

const TEXT = { fontSize: "var(--text-sm)", color: "var(--text-body)", lineHeight: "var(--leading-body)", margin: 0 };

export default function GetStartedIsland({ canWrite, isAdmin, products, onReload }) {
  const [model, setModel] = React.useState(null); // null while checking
  const [asked, setAsked] = React.useState(false);

  React.useEffect(() => {
    api("/chat/status").then((s) => setModel(!!s.available)).catch(() => setModel(false));
    api("/chat/threads").then((t) => setAsked(t.length > 0)).catch(() => {});
  }, []);

  const ours = products.filter((p) => !p.external);
  const external = products.filter((p) => p.external);
  const described = ours.length > 0;

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: 24 }}>
      <div style={{ maxWidth: 720, margin: "0 auto", display: "flex", flexDirection: "column", gap: 8 }}>
        <h2 style={{ fontSize: "var(--text-lg)", fontWeight: "var(--weight-semibold)", color: "var(--text-heading)", margin: 0 }}>Get started</h2>
        <p style={{ ...TEXT, color: "var(--text-secondary)" }}>
          Metis needs at least one of your products before it can say what you could build next.
        </p>
        {!canWrite ? (
          <p style={{ ...TEXT, marginTop: 8 }}>
            Nothing is here yet. An editor needs to add the first product; once they do, this page shows what could be built from it.
          </p>
        ) : (
          <ol style={{ listStyle: "none", margin: "8px 0 0", padding: 0 }}>
            <Step n={1} done={model === true} title="Connect an AI model">
              <p style={TEXT}>
                {model === null ? "Checking…" : model ? "A model is connected." : isAdmin
                  ? <>No model is connected yet. <a href="/admin" style={LINK}>Connect one</a>.</>
                  : "No model is connected yet. Ask an admin to connect one."}
              </p>
            </Step>
            <Step n={2} done={described} title="Describe a product from its repo">
              <AgentPromptPanel />
            </Step>
            <Step n={3} done={described} title="Import the file it writes">
              <SeedImportPanel onImported={onReload} />
              {described && (
                <p style={TEXT}>
                  {ours.length === 1 ? `${ours[0].name} is in.` : `${ours.length} products are in.`}{" "}
                  <a href="/home" style={LINK}>See what you could build next</a>.
                </p>
              )}
            </Step>
            <Step n={4} done={external.length > 0} optional title="Add a product you don't own to compare against">
              <p style={TEXT}>
                On <a href="/products" style={LINK}>Products</a>, choose New product and tick External.
              </p>
            </Step>
            <Step n={5} done={asked} title="Ask your first question">
              <p style={TEXT}>
                <a href="/chat" style={LINK}>Open Chat</a> and ask about your products in your own words.
              </p>
            </Step>
          </ol>
        )}
      </div>
    </div>
  );
}
