import React from "react";
import { Button, Icon, StatusBadge, TicketCard } from "../../ds";
import { count } from "../../lib/words.js";
import { pressable } from "../../lib/pressable.js";

export const SIZE_HINT = "S: one file · M: 2 to 4 files · L: must be split";

const panel = { background: "var(--surface-card)", border: "1px solid var(--border-hairline)", borderRadius: "var(--radius-md)", padding: 16, display: "flex", flexDirection: "column", gap: 10 };
const muted = { fontSize: "var(--text-sm)", color: "var(--text-secondary)" };
const mono = { fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-secondary)" };
const sparkle = (label, onClick) => (
  <Button size="sm" variant="secondary" style={{ gap: 6 }} onClick={onClick}><Icon name="sparkles" size={13} />{label}</Button>
);

function SectionHead({ title, meta, children }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
      <span style={{ fontSize: "var(--text-sm)", fontWeight: "var(--weight-semibold)", color: "var(--text-heading)" }}>{title}</span>
      {meta}
      <span style={{ flex: 1 }} />
      {children}
    </div>
  );
}

// Delivery planning for a product we build: spec, plan document (PRD),
// tickets and strategy. Shown only once one of them exists.
export function ProductPlan({ product, prd, epics, tickets, strategy, capabilities, features, canWrite, actions }) {
  // A written spec (body) counts, so a draft spec can be approved before planning.
  const hasPlan = product.status === "approved" || product.body || prd || epics.length > 0 || tickets.length > 0 || strategy;
  if (!hasPlan) {
    return canWrite ? (
      <div style={{ ...panel, alignItems: "flex-start" }}>
        <div style={muted}>A plan breaks this product into a plan document, tickets sized for one coding session each, and a delivery timeline, drafted in Chat.</div>
        <Button size="sm" variant="accent" style={{ gap: 6 }} onClick={actions.decompose}><Icon name="sparkles" size={13} />Plan this product</Button>
      </div>
    ) : (
      <div style={muted}>No plan yet. An editor can create one.</div>
    );
  }

  const capName = (id) => capabilities.find((c) => c.id === id)?.name;
  const feature = (id) => (features ?? []).find((f) => f.id === id);
  const doneIn = (epicId) => {
    const list = tickets.filter((t) => t.epic_id === epicId);
    return { total: list.length, done: list.filter((t) => t.status === "done").length };
  };
  const phases = strategy?.phases ?? [];
  const end = Math.max(1, ...phases.map((p) => (p.start || 0) + (p.length || 0)));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <section style={panel}>
        <SectionHead title="Spec" meta={<><StatusBadge status={product.status} /><span style={mono}>{product.display_id} v{product.version}</span></>}>
          {canWrite && product.status === "draft" && <Button size="sm" onClick={actions.approveSpec}>Approve spec</Button>}
        </SectionHead>
      </section>

      <section style={panel}>
        <SectionHead title="Plan document (PRD)"
          meta={prd && <><StatusBadge status={prd.status} /><span style={mono}>{prd.display_id} v{prd.version} · {prd.created_by}</span></>}>
          {canWrite && sparkle(epics.length === 0 ? "Draft plan document" : "Regenerate", actions.decompose)}
          {canWrite && prd?.status === "draft" && sparkle("Refresh draft", actions.refreshPrd)}
          {canWrite && prd?.status === "draft" && <Button size="sm" onClick={actions.approvePrd}>Approve</Button>}
        </SectionHead>
        {prd?.status === "draft" && (
          <div style={{ fontSize: "var(--text-xs)", color: "var(--text-accent)" }}>
            {canWrite ? "Draft until approved. L tickets must be split first." : "Draft, awaiting approval."}
          </div>
        )}
        {epics.length === 0 && <div style={muted}>No plan document yet.</div>}
        {epics.map((e, i) => {
          const c = doneIn(e.id);
          const pin = capName(e.capability_id);
          return (
            <div key={e.id} style={{ borderTop: "1px solid var(--border-hairline)", paddingTop: 10, display: "flex", flexDirection: "column", gap: 4 }}>
              <div style={{ display: "flex", gap: 12, alignItems: "baseline" }}>
                <span style={{ flex: 1, minWidth: 0, fontSize: "var(--text-sm)", fontWeight: "var(--weight-semibold)", color: "var(--text-heading)" }}>{i + 1}. {e.title}</span>
                {c.total > 0 && <span style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>{c.done} of {count(c.total, "ticket")} done</span>}
              </div>
              {e.acceptance_criteria && <div style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>Acceptance: {e.acceptance_criteria}</div>}
              {pin && <div style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>pins {pin}</div>}
              {(e.stories ?? []).length > 0 && (
                <ul style={{ margin: "4px 0 0", paddingLeft: 18, fontSize: "var(--text-sm)", color: "var(--text-body)", display: "flex", flexDirection: "column", gap: 2 }}>
                  {e.stories.map((s) => {
                    const f = feature(s.feature_id);
                    return (
                      <li key={s.id}>
                        {s.title}
                        {f && <span style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}> · pins <a href={`/features?feature=${f.id}`}>{f.name}</a></span>}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          );
        })}
      </section>

      <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <SectionHead title={`Tickets · ${tickets.length}`} meta={<span style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>{SIZE_HINT}</span>} />
        {tickets.length === 0 && !canWrite && <div style={muted}>No tickets yet.</div>}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 12 }}>
          {tickets.map((t) => (
            <TicketCard key={t.id} id={t.display_id} title={t.title} description={t.description}
              status={t.status} budget={t.context_budget} files={t.affected_files} onClick={() => actions.openTicket(t)} />
          ))}
          {canWrite && (
            <div {...pressable(actions.newTicket)}
              style={{ border: "1px dashed var(--border-default)", borderRadius: "var(--radius-md)", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, color: "var(--text-secondary)", fontSize: "var(--text-sm)", minHeight: 90, cursor: "pointer" }}>
              <Icon name="plus" size={14} /> New ticket
            </div>
          )}
        </div>
      </section>

      <section style={panel}>
        <SectionHead title="Delivery strategy"
          meta={strategy && <span style={mono}>Timeline · v{strategy.version} · {strategy.created_by}</span>}>
          {canWrite && sparkle(strategy ? "Regenerate" : "Create strategy", actions.strategy)}
        </SectionHead>
        {!strategy && <div style={muted}>No delivery strategy yet.</div>}
        {phases.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 640 }}>
            {phases.map((p, i) => (
              <div key={i} style={{ display: "grid", gridTemplateColumns: "16px minmax(0, 1fr) 180px", alignItems: "center", gap: 12 }}>
                <span style={{ ...mono, fontSize: 10 }}>{i + 1}</span>
                <div style={{ display: "flex" }}>
                  <div style={{ width: `${((p.start || 0) / end) * 100}%` }} />
                  <div style={{ height: 10, borderRadius: 5, background: i === 0 ? "var(--stage-prd)" : "var(--ink-2)", width: `${((p.length || 0) / end) * 100}%` }} />
                </div>
                <span style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>{p.name}</span>
              </div>
            ))}
            <div style={{ display: "grid", gridTemplateColumns: "16px minmax(0, 1fr) 180px", gap: 12 }}>
              <span />
              <div style={{ display: "flex", justifyContent: "space-between", borderTop: "1px solid var(--border-hairline)", paddingTop: 4, ...mono, fontSize: 10 }}>
                <span>start</span><span>time, relative</span><span>end</span>
              </div>
            </div>
          </div>
        )}
        {strategy?.rationale && <div style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>{strategy.rationale}</div>}
      </section>
    </div>
  );
}
