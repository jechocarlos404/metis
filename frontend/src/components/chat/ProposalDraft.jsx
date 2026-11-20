import React from "react";
import { EDGE } from "../../lib/words.js";
import { Term } from "../shared/Term.jsx";
import { display, fieldRows, objects } from "./proposal-words.js";

// A proposed change shown as the draft it is, so it can be reviewed before
// anyone approves it: PRDs as epics → stories → tickets, tickets and
// strategies in full. Anything else falls back to its fields. `named` is the
// same arguments with each reference (goal, capability, feature, product,
// ticket) replaced by its name; what the agent passed stays in `title`.
// Arguments are model output: every value goes through display() and every
// list through objects(), so a wrong shape shows as text instead of breaking
// the page.

const LABEL = { fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "var(--tracking-caps)", textTransform: "uppercase", color: "var(--text-secondary)" };
const BODY = { fontSize: "var(--text-xs)", color: "var(--text-body)", lineHeight: "var(--leading-body)", whiteSpace: "pre-wrap" };

function Field({ label, children }) {
  if (children == null || children === "" || (Array.isArray(children) && children.length === 0)) return null;
  return (
    <div>
      <div style={LABEL}>{label}</div>
      <div style={BODY}>{display(children)}</div>
    </div>
  );
}

function Budget({ value }) {
  if (typeof value !== "string" || !value) return null;
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
        {display(t.title) || "(untitled ticket)"} <Budget value={t.context_budget} />
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
  const doc = objects([args.document])[0] ?? {};
  const epics = objects(doc.epics);
  const tickets = epics.flatMap((e) => objects(e.stories).flatMap((s) => objects(s.tickets)));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={BODY}>
        PRD draft for <strong>{display(args.product)}</strong>: {epics.length} epic{epics.length === 1 ? "" : "s"}, {tickets.length} ticket{tickets.length === 1 ? "" : "s"}.
        {" "}It replaces the product's current draft while that draft's tickets are all still planned.
      </div>
      {doc.summary && <div style={BODY}>{display(doc.summary)}</div>}
      {epics.map((e, i) => (
        <div key={i} style={{ borderLeft: "1px solid var(--border-default)", paddingLeft: 10, display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ fontSize: "var(--text-xs)", fontWeight: "var(--weight-semibold)", color: "var(--text-heading)" }}>
            Epic: {display(e.title)}{e.capability ? <span style={{ fontWeight: "normal", color: "var(--text-secondary)" }}> · capability: {display(e.capability)}</span> : null}
          </div>
          {e.acceptance_criteria && <div style={{ ...BODY, color: "var(--text-secondary)" }}>Done when: {display(e.acceptance_criteria)}</div>}
          {objects(e.stories).map((s, j) => (
            <div key={j} style={{ paddingLeft: 10, display: "flex", flexDirection: "column", gap: 2 }}>
              <div style={{ fontSize: "var(--text-xs)", color: "var(--text-heading)" }}>
                Story: {display(s.title)}{s.feature ? <span style={{ color: "var(--text-secondary)" }}> · feature: {display(s.feature)}</span> : null}
              </div>
              <div style={{ paddingLeft: 10, display: "flex", flexDirection: "column", gap: 2 }}>
                {objects(s.tickets).map((t, k) => <TicketDraft key={k} t={t} />)}
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
      <div style={BODY}>Delivery strategy for <strong>{display(args.product)}</strong></div>
      <ol style={{ margin: 0, paddingLeft: 18, ...BODY }}>
        {objects(args.phases).map((p, i) => (
          <li key={i}>{display(p.name)}{p.start != null ? ` · starts at ${display(p.start)}` : ""}{p.length != null ? ` · lasts ${display(p.length)}` : ""}</li>
        ))}
      </ol>
      <Field label="Why">{args.rationale}</Field>
    </div>
  );
}

function Fields({ args, named }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {fieldRows(args, named).filter((r) => r.text !== "").map((r) => (
        <div key={r.key}>
          <div style={LABEL}>{r.label}</div>
          <div style={BODY}><span title={r.raw ?? undefined}>{r.text}</span></div>
        </div>
      ))}
    </div>
  );
}

function LinkDraft({ named }) {
  return (
    <div style={BODY}>
      <strong>{display(named.src)}</strong> <Term dict={EDGE} value={typeof named.kind === "string" ? named.kind : "DEPENDS_ON"} /> <strong>{display(named.dst)}</strong>
    </div>
  );
}

export function ProposalDraft({ tool, args, named }) {
  const shown = named ?? args ?? {};
  if (tool === "create_prd_draft") return <PrdDraft args={shown} />;
  if (tool === "create_delivery_strategy") return <StrategyDraft args={shown} />;
  if (tool === "link_features") return <LinkDraft named={shown} />;
  if (tool === "create_ticket") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <div style={BODY}>New ticket for <strong>{display(shown.product)}</strong>{shown.epic_id ? ` · epic: ${display(shown.epic_id)}` : ""}{shown.story_id ? ` · story: ${display(shown.story_id)}` : ""}</div>
        <TicketDraft t={shown} open />
      </div>
    );
  }
  return <Fields args={args} named={named} />;
}
