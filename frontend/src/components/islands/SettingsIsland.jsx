import React from "react";
import { PageHeader } from "../shell/PageHeader.jsx";
import { AgentPromptPanel, SeedImportPanel, UnseedPanel } from "../shared/SeedFiles.jsx";

const ADMIN_LINKS = [
  { href: "/users", label: "Users and roles", text: "Add people, and choose who can view, edit or administer metis." },
  { href: "/admin", label: "AI models", text: "Pick the provider and model each Chat agent uses." },
  { href: "/data", label: "Raw data", text: "Every record in one place, for fixing data by hand." },
];

const SECTION = { display: "flex", flexDirection: "column", gap: 12, maxWidth: 640 };
const CARD = { background: "var(--surface-card)", border: "1px solid var(--border-hairline)", borderRadius: "var(--radius-md)", padding: 16, display: "flex", flexDirection: "column", gap: 12 };
const H2 = { fontSize: "var(--text-md)", fontWeight: "var(--weight-semibold)" };
const H3 = { fontSize: "var(--text-sm)", fontWeight: "var(--weight-semibold)", color: "var(--text-heading)" };

export default function SettingsIsland({ role }) {
  const canWrite = role === "editor" || role === "admin";
  const isAdmin = role === "admin";

  return (
    <>
      <PageHeader title="Settings" />
      <div style={{ flex: 1, overflowY: "auto", padding: 24, display: "flex", flexDirection: "column", gap: 28 }}>
        {!canWrite && (
          <p style={{ margin: 0, fontSize: "var(--text-sm)", color: "var(--text-secondary)" }}>
            Settings need an editor or admin role, which an admin of this metis can give you.
          </p>
        )}

        {canWrite && (
          <section style={SECTION} aria-labelledby="seed-files">
            <h2 id="seed-files" style={H2}>Seed files</h2>
            <div style={CARD}>
              <h3 style={H3}>Add a product from its repo</h3>
              <AgentPromptPanel />
              <SeedImportPanel />
            </div>
            <div style={CARD}>
              <h3 style={H3}>Remove a seeded product</h3>
              <UnseedPanel />
            </div>
          </section>
        )}

        {isAdmin && (
          <section style={SECTION} aria-labelledby="administration">
            <h2 id="administration" style={H2}>Administration</h2>
            <div style={{ ...CARD, padding: 0, gap: 0 }}>
              {ADMIN_LINKS.map((l, i) => (
                <a key={l.href} href={l.href}
                  style={{ display: "flex", flexDirection: "column", gap: 2, padding: "12px 16px", textDecoration: "none", borderBottom: i < ADMIN_LINKS.length - 1 ? "1px solid var(--border-hairline)" : "none" }}>
                  <span style={{ fontSize: "var(--text-sm)", fontWeight: "var(--weight-medium)", color: "var(--text-accent)" }}>{l.label}</span>
                  <span style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>{l.text}</span>
                </a>
              ))}
            </div>
          </section>
        )}
      </div>
    </>
  );
}
