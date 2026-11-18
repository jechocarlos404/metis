import React from "react";

// A proposed change shown as the draft it is, so it can be reviewed before
// anyone approves it: PRDs as epics → stories → tickets, tickets and
// strategies in full. Anything else falls back to its fields.

const LABEL = { fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "var(--tracking-caps)", textTransform: "uppercase", color: "var(--text-secondary)" };
const BODY = { fontSize: "var(--text-xs)", color: "var(--text-body)", lineHeight: "var(--leading-body)", whiteSpace: "pre-wrap" };

function Field({ label, children }) {
  if (children == null || children === "" || (Array.isArray(children) && children.length === 0)) return null;
  return (
    <div>
      <div style={LABEL}>{label}</div>
      <div style={BODY}>{Array.isArray(children) ? children.join(", ") : String(children)}</div>
    </div>
  );
}

function Budget({ value }) {
  if (!value) return null;
  return (
    <span title="Context budget: how much one coding session it needs" style={{ fontFamily: "var(--font-mono)", fontSize: 10, padding: "0 5px", borderRadius: "var(--radius-xs)", border: `1px solid ${value === "L" ? "var(--danger-fg)" : "var(--border-default)"}`, color: value === "L" ? "var(--danger-fg)" : "var(--text-secondary)" }}>
      {value}
    </span>
  );
}

function TicketDraft({ t, open = false }) {
  return (
    <details open={open || undefined} style={{ fontSize: "var(--text-xs)" }}>
      <summary style={{ cursor: "pointer", color: "var(--text-heading)" }}>
        {t.title || "(untitled ticket)"} <Budget value={t.context_budget} />
      </summary>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "6px 0 4px 14px" }}>
        <Field label="Description">{t.description}</Field>
        <Field label="Approach">{t.technical_approach}</Field>
        <Field label="Done when">{t.acceptance_criteria}</Field>
        <Field label="Files">{t.affected_files}</Field>
        {t.context_budget === "L" && <div style={{ ...BODY, color: "var(--danger-fg)" }}>Size L: metis rejects these when the PRD is approved. Ask the agent to split it.</div>}
      </div>
    </details>
  );
}

function PrdDraft({ args }) {
  const doc = args.document ?? {};
  const epics = doc.epics ?? [];
  const tickets = epics.flatMap((e) => (e.stories ?? []).flatMap((s) => s.tickets ?? []));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={BODY}>
        PRD draft for <strong>{args.product}</strong>: {epics.length} epic{epics.length === 1 ? "" : "s"}, {tickets.length} ticket{tickets.length === 1 ? "" : "s"}.
        {" "}It replaces the product's current draft while that draft's tickets are all still planned.
      </div>
      {doc.summary && <div style={BODY}>{doc.summary}</div>}
      {epics.map((e, i) => (
        <div key={i} style={{ borderLeft: "1px solid var(--border-default)", paddingLeft: 10, display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ fontSize: "var(--text-xs)", fontWeight: "var(--weight-semibold)", color: "var(--text-heading)" }}>
            Epic: {e.title}{e.capability ? <span style={{ fontWeight: "normal", color: "var(--text-secondary)" }}> · capability: {e.capability}</span> : null}
          </div>
          {e.acceptance_criteria && <div style={{ ...BODY, color: "var(--text-secondary)" }}>Done when: {e.acceptance_criteria}</div>}
          {(e.stories ?? []).map((s, j) => (
            <div key={j} style={{ paddingLeft: 10, display: "flex", flexDirection: "column", gap: 2 }}>
              <div style={{ fontSize: "var(--text-xs)", color: "var(--text-heading)" }}>
                Story: {s.title}{s.feature ? <span style={{ color: "var(--text-secondary)" }}> · feature: {s.feature}</span> : null}
              </div>
              <div style={{ paddingLeft: 10, display: "flex", flexDirection: "column", gap: 2 }}>
                {(s.tickets ?? []).map((t, k) => <TicketDraft key={k} t={t} />)}
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function StrategyDraft({ args }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={BODY}>Delivery strategy for <strong>{args.product}</strong></div>
      <ol style={{ margin: 0, paddingLeft: 18, ...BODY }}>
        {(args.phases ?? []).map((p, i) => (
          <li key={i}>{p.name}{p.start != null ? ` · starts at ${p.start}` : ""}{p.length != null ? ` · lasts ${p.length}` : ""}</li>
        ))}
      </ol>
      <Field label="Why">{args.rationale}</Field>
    </div>
  );
}

function Fields({ args }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {Object.entries(args ?? {}).map(([k, v]) => (
        <Field key={k} label={k.replace(/_/g, " ")}>{typeof v === "object" && !Array.isArray(v) ? JSON.stringify(v) : v}</Field>
      ))}
    </div>
  );
}

export function ProposalDraft({ tool, args }) {
  if (tool === "create_prd_draft") return <PrdDraft args={args} />;
  if (tool === "create_delivery_strategy") return <StrategyDraft args={args} />;
  if (tool === "create_ticket") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <div style={BODY}>New ticket for <strong>{args.product}</strong></div>
        <TicketDraft t={args} open />
      </div>
    );
  }
  return <Fields args={args} />;
}
