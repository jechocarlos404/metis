import React from "react";
import { PageHeader } from "../shell/PageHeader.jsx";
import { VizBlock } from "../chat/VizBlock.jsx";
import { ProposalDraft } from "../chat/ProposalDraft.jsx";
import { Badge, Button, Icon, IconButton, Select, DeleteConfirm } from "../../ds";
import { count } from "../../lib/words.js";
import { Term } from "../shared/Term.jsx";
import { api } from "../../lib/api.js";
import { renderChatMarkdown } from "../../lib/chat-markdown.js";

const stepLabel = (name) => name.replace(/_/g, " ");
const STEP_STATUS = { started: "running…", finished: "done", failed: "failed", proposed: "proposed" };

// Who answered, in people's words. The orchestrator is the one voice the
// reader talks to; specialists are named by the job they do.
const AGENT = {
  orchestrator: "Metis",
  spec_decomposer: "Specs and tickets",
  feature_manager: "Features and capabilities",
  graph_agent: "Dependencies",
  strategist: "Delivery strategy",
};
const agentLabel = (name) => AGENT[name] ?? (name ? stepLabel(name) : "Metis");

const argValue = (v) => {
  if (v == null) return "none";
  if (typeof v !== "object") return String(v);
  if (Array.isArray(v)) return v.every((x) => x == null || typeof x !== "object") ? v.join(", ") : count(v.length, "item");
  return count(Object.keys(v).length, "field");
};

// A step's arguments as readable lines; the exact JSON stays one click away.
function StepArgs({ args }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, color: "var(--text-secondary)" }}>
      {Object.entries(args).map(([k, v]) => (
        <div key={k} style={{ overflowWrap: "anywhere" }}>
          {stepLabel(k)}: <span style={{ color: "var(--text-body)" }}>{argValue(v)}</span>
        </div>
      ))}
      <details>
        <summary style={{ cursor: "pointer" }}>Raw</summary>
        <pre style={{ margin: "4px 0 0", fontFamily: "var(--font-mono)", fontSize: 11, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(args, null, 2)}</pre>
      </details>
    </div>
  );
}

// What an agent did on the way to its reply: each tool it called, whether
// that read or changed data, what it was given and what came back.
function AgentSteps({ tools }) {
  const proposed = tools.filter((t) => t.status === "proposed").length;
  const failed = tools.filter((t) => t.status === "failed").length;
  return (
    <details style={{ fontSize: "var(--text-xs)", border: "1px solid var(--border-hairline)", borderRadius: "var(--radius-sm)", background: "var(--surface-card)" }}>
      <summary style={{ cursor: "pointer", padding: "6px 10px", color: "var(--text-secondary)" }}>
        What it did: {count(tools.length, "step", "steps")}
        {proposed > 0 && <span style={{ color: "var(--warn-fg)", fontWeight: "var(--weight-medium)" }}> · proposed {count(proposed, "change", "changes")}</span>}
        {failed > 0 && <span style={{ color: "var(--danger-fg)" }}> · {failed} failed</span>}
      </summary>
      <ol style={{ margin: 0, padding: "0 10px 8px 30px", display: "flex", flexDirection: "column", gap: 6 }}>
        {tools.map((t, i) => (
          <li key={i} style={{ color: "var(--text-body)" }}>
            <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
              <span title={t.name} style={{ color: "var(--text-heading)" }}>{stepLabel(t.name)}</span>
              {t.changes && <Badge tone="warn">changes data</Badge>}
              <span style={{ color: t.status === "failed" ? "var(--danger-fg)" : "var(--text-secondary)" }}>
                {STEP_STATUS[t.status] ?? t.status}
              </span>
            </span>
            {t.arguments && Object.keys(t.arguments).length > 0 && <StepArgs args={t.arguments} />}
            {t.summary && <div style={{ color: t.status === "failed" ? "var(--danger-fg)" : "var(--text-body)" }}>→ {t.summary}</div>}
          </li>
        ))}
      </ol>
    </details>
  );
}

const RUN_NOTE = {
  interrupted: "Stopped: the server restarted before this finished.",
  failed: "This agent couldn't finish.",
};

function Dot() {
  return <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--accent)", animation: "pulse 1s infinite" }} />;
}

function AgentMessage({ agent, text, viz, tools, status }) {
  const running = status === "running";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ width: 22, height: 22, borderRadius: "var(--radius-sm)", background: "var(--accent-wash)", color: "var(--text-accent)", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <Icon name="sparkles" size={12} />
        </span>
        <span title={agent} style={{ fontSize: "var(--text-xs)", fontWeight: "var(--weight-medium)", color: "var(--text-secondary)" }}>{agentLabel(agent)}</span>
        {running && <Dot />}
        {running && !text && <span style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>working…</span>}
      </div>
      {tools && tools.length > 0 && <AgentSteps tools={tools} />}
      {text && (
        // renderChatMarkdown escapes raw HTML and unsafe links; see lib/chat-markdown.js.
        <div className="chat-md" style={{ fontSize: "var(--text-sm)", color: "var(--text-body)", lineHeight: "var(--leading-body)" }}
          dangerouslySetInnerHTML={{ __html: renderChatMarkdown(text) }} />
      )}
      {RUN_NOTE[status] && <div style={{ fontSize: "var(--text-xs)", color: status === "failed" ? "var(--danger-fg)" : "var(--text-secondary)" }}>{RUN_NOTE[status]}</div>}
      {(viz || []).map((block, i) => (
        <VizBlock key={i} block={block} />
      ))}
    </div>
  );
}

const PROPOSAL_TONE = { pending: "warn", applying: "accent", applied: "ok", rejected: "neutral", failed: "danger" };
const PROPOSAL_STATUS = { pending: "waiting for you", applying: "applying", applied: "applied", rejected: "rejected", failed: "failed" };

// Changes an agent wants to make. Nothing is written until someone with edit
// access approves; within one reply they are decided in the order proposed.
function Proposals({ message, canWrite, onDecided }) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);
  const list = message.proposals ?? [];
  if (list.length === 0) return null;
  const pending = list.filter((p) => p.status === "pending");
  const next = pending[0];
  const agentDone = message.status !== "running";

  const decide = async (path) => {
    setBusy(true);
    setError(null);
    try {
      await api(path, { method: "POST" });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
      onDecided();
    }
  };

  return (
    <div style={{ border: "1px solid var(--border-default)", borderRadius: "var(--radius-md)", background: "var(--surface-card)", padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: "var(--text-sm)", fontWeight: "var(--weight-semibold)", color: "var(--text-heading)", flex: 1 }}>
          {pending.length > 0 ? `${count(pending.length, "change", "changes")} waiting for approval` : "Proposed changes"}
        </span>
        {canWrite && agentDone && pending.length > 1 && (
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => decide(`/chat/messages/${message.id}/approve-all`)}>
            Approve all {pending.length} in order
          </Button>
        )}
      </div>
      {!agentDone && pending.length > 0 && <div style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>You can decide once the agent finishes.</div>}
      {pending.length > 1 && <div style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>Changes apply in order; each waits for the one before it.</div>}
      <ol style={{ margin: 0, paddingLeft: 20, display: "flex", flexDirection: "column", gap: 8 }}>
        {list.map((p) => (
          <li key={p.id} style={{ fontSize: "var(--text-xs)", color: "var(--text-body)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <span title={p.tool_name} style={{ fontWeight: "var(--weight-medium)", color: "var(--text-heading)" }}>{stepLabel(p.tool_name)}</span>
              <Badge tone={PROPOSAL_TONE[p.status] ?? "neutral"}><Term dict={PROPOSAL_STATUS} value={p.status} /></Badge>
              <span style={{ flex: 1 }} />
              {canWrite && agentDone && p === next && (
                <>
                  <Button size="sm" variant="secondary" disabled={busy} onClick={() => decide(`/chat/proposals/${p.id}/reject`)}>Reject</Button>
                  <Button size="sm" variant="accent" disabled={busy} onClick={() => decide(`/chat/proposals/${p.id}/approve`)}>Approve</Button>
                </>
              )}
              {canWrite && agentDone && p.status === "pending" && p !== next && (
                <span style={{ color: "var(--text-secondary)" }}>after the one above</span>
              )}
            </div>
            <div style={{ margin: "6px 0 2px", padding: 8, background: "var(--surface-inset)", borderRadius: "var(--radius-sm)" }}>
              <ProposalDraft tool={p.tool_name} args={p.arguments} />
            </div>
            {p.result && <div style={{ color: p.status === "failed" ? "var(--danger-fg)" : "var(--text-body)" }}>→ {p.result}</div>}
          </li>
        ))}
      </ol>
      {error && <div role="alert" style={{ fontSize: "var(--text-xs)", color: "var(--danger-fg)" }}>{error}</div>}
    </div>
  );
}

function SpecialistCard({ message, canWrite, onDecided }) {
  const running = message.status === "running";
  const waiting = (message.proposals ?? []).filter((p) => p.status === "pending").length;
  return (
    <details style={{ border: "1px solid var(--border-hairline)", borderRadius: "var(--radius-md)", background: "var(--surface-inset)" }}>
      <summary style={{ cursor: "pointer", padding: "8px 12px", fontSize: "var(--text-xs)", color: "var(--text-secondary)", lineHeight: 1.8 }}>
        <span title={message.agent_name} style={{ fontWeight: "var(--weight-medium)", color: "var(--text-heading)", marginRight: 8 }}>{agentLabel(message.agent_name)}</span>
        <Badge tone={running ? "accent" : message.status === "done" ? "ok" : "danger"}><Term dict={SPECIALIST_STATUS} value={message.status} /></Badge>
        {message.task && <span style={{ marginLeft: 8 }}>{message.task.length > 90 ? `${message.task.slice(0, 90)}…` : message.task}</span>}
        {waiting > 0 && <span style={{ marginLeft: 8, color: "var(--warn-fg)", fontWeight: "var(--weight-medium)" }}>· {count(waiting, "change", "changes")} waiting for you</span>}
      </summary>
      <div style={{ padding: "0 12px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
        {message.task && <div style={{ fontSize: "var(--text-xs)", color: "var(--text-body)" }}>Task: {message.task}</div>}
        {message.tool_calls?.length > 0 && <AgentSteps tools={message.tool_calls} />}
        {message.content && (
          <div className="chat-md" style={{ fontSize: "var(--text-sm)", color: "var(--text-body)", lineHeight: "var(--leading-body)" }}
            dangerouslySetInnerHTML={{ __html: renderChatMarkdown(message.content) }} />
        )}
        {RUN_NOTE[message.status] && <div style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>{RUN_NOTE[message.status]}</div>}
        <Proposals message={message} canWrite={canWrite} onDecided={onDecided} />
      </div>
    </details>
  );
}

const SPECIALIST_STATUS = { running: "working", done: "done", failed: "failed", interrupted: "stopped" };

// One request: the orchestrator's run, the specialists it delegated to (in
// parallel), and, when there were several, its combined answer.
function Turn({ run, children, canWrite, onDecided, onRetry }) {
  const stopped = ["interrupted", "failed"].includes(run.status) || children.some((c) => c.status === "interrupted");
  const retry = canWrite && onRetry && stopped && (
    <div><Button size="sm" variant="secondary" onClick={onRetry}>Retry this message</Button></div>
  );
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <TurnBody run={run} children={children} canWrite={canWrite} onDecided={onDecided} />
      {retry}
    </div>
  );
}

function TurnBody({ run, children, canWrite, onDecided }) {
  if (children.length === 0) {
    return run.status === "running"
      ? <AgentMessage agent="orchestrator" status="running" />
      : <AgentMessage agent="orchestrator" text={run.content} status={run.status} />;
  }
  if (children.length === 1 && !run.content) {
    const only = children[0];
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <AgentMessage agent={only.agent_name} text={only.content} viz={only.viz} tools={only.tool_calls} status={only.status} />
        <Proposals message={only} canWrite={canWrite} onDecided={onDecided} />
      </div>
    );
  }
  const working = children.filter((c) => c.status === "running").length;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>
        Metis split this across {count(children.length, "helper", "helpers")} working at the same time
        {working > 0 ? `, ${working} still working` : ""}.
      </div>
      {children.map((c) => <SpecialistCard key={c.id} message={c} canWrite={canWrite} onDecided={onDecided} />)}
      {(run.content || run.status === "running") && (
        <AgentMessage agent="orchestrator" text={run.content} status={working > 0 && !run.content ? "done" : run.status} />
      )}
    </div>
  );
}

export default function ChatIsland({ threadId: initialThreadId = null, canWrite = true, isAdmin = false }) {
  const [threads, setThreads] = React.useState([]);
  const [threadId, setThreadId] = React.useState(initialThreadId);
  const [messages, setMessages] = React.useState([]);
  const [draft, setDraft] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [confirmingDelete, setConfirmingDelete] = React.useState(false);
  const [available, setAvailable] = React.useState(null); // null until /chat/status answers
  const [products, setProducts] = React.useState([]);
  const scrollRef = React.useRef(null);
  const stickRef = React.useRef(true); // follow new content only while the reader is at the bottom
  const threadRef = React.useRef(threadId);
  threadRef.current = threadId;

  React.useEffect(() => {
    api("/chat/threads").then(setThreads).catch((e) => setError(`Couldn't load threads: ${e.message}`));
    api("/chat/status").then((s) => setAvailable(!!s.available)).catch(() => setAvailable(null));
    api("/products").then(setProducts).catch(() => {});
  }, []);

  // Starter questions built from what is in metis, so each one has an answer.
  const examples = React.useMemo(() => {
    const byName = (a, b) => a.name.localeCompare(b.name);
    const ours = products.filter((p) => !p.external).sort(byName)[0];
    const theirs = products.filter((p) => p.external).sort(byName)[0];
    return [
      ours && `What could we build next from what ${ours.name} already has?`,
      "Which capabilities are shared by the most products?",
      theirs && `How much of ${theirs.name} could we build?`,
    ].filter(Boolean);
  }, [products]);

  // /chat?prompt=… — launch from Products (decompose, strategy, etc.)
  const [launchPrompt, setLaunchPrompt] = React.useState(null);
  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const prompt = params.get("prompt");
    if (!prompt || !canWrite) return;
    setLaunchPrompt(prompt);
    params.delete("prompt");
    const qs = params.toString();
    window.history.replaceState({}, "", window.location.pathname + (qs ? `?${qs}` : ""));
  }, [canWrite]);

  React.useEffect(() => {
    if (!launchPrompt) return;
    const prompt = launchPrompt;
    setLaunchPrompt(null);
    send(prompt);
  }, [launchPrompt]);

  // The server is the only copy: agents run there whether or not this page is open.
  const load = React.useCallback(async (id = threadRef.current) => {
    if (!id) return;
    try {
      const rows = await api(`/chat/threads/${id}/messages`);
      if (threadRef.current === id) setMessages(rows);
    } catch (e) {
      setError(`Couldn't load this thread: ${e.message}`);
    }
  }, []);

  React.useEffect(() => {
    setMessages([]);
    stickRef.current = true;
    load(threadId);
  }, [threadId, load]);

  const running = messages.some((m) => m.status === "running");
  // While anything runs, read the thread again each second.
  React.useEffect(() => {
    if (!running) return undefined;
    const timer = setTimeout(() => load(), 1000);
    return () => clearTimeout(timer);
  }, [messages, running, load]);

  React.useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const switchThread = (id) => {
    setError(null);
    setThreadId(id || null);
    setConfirmingDelete(false);
    window.history.replaceState({}, "", id ? `/chat/${id}` : "/chat");
  };

  const deleteThread = async () => {
    if (!threadId) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/chat/threads/${threadId}`, { method: "DELETE" });
      const remaining = threads.filter((t) => t.id !== threadId);
      setThreads(remaining);
      switchThread(remaining[0]?.id ?? null);
      setConfirmingDelete(false);
    } catch (e) {
      setError(String(e.message));
      setConfirmingDelete(false);
    } finally {
      setBusy(false);
    }
  };

  const send = async (overrideContent) => {
    const content = (overrideContent ?? draft).trim();
    if (!content || busy || running || available === false) return;
    setBusy(true);
    setError(null);
    setDraft("");
    try {
      let id = threadId;
      if (!id) {
        const title = content.length > 48 ? `${content.slice(0, 48)}…` : content;
        const thread = await api("/chat/threads", { method: "POST", body: { title } });
        id = thread.id;
        setThreads((t) => [thread, ...t]);
        threadRef.current = id;
        switchThread(id);
      }
      await api(`/chat/threads/${id}/messages`, { method: "POST", body: { content } });
      stickRef.current = true;
      await load(id);
    } catch (e) {
      setError(`Not sent: ${e.message}`);
      if (!overrideContent) setDraft(content);
    } finally {
      setBusy(false);
    }
  };

  const activeThread = threads.find((t) => t.id === threadId);
  // Each orchestrator run answers the user message just before it.
  const askedFor = React.useMemo(() => {
    const map = new Map();
    let last = null;
    for (const m of messages) {
      if (m.role === "user") last = m.content;
      else if (!m.parent_id && m.agent_name === "orchestrator") map.set(m.id, last);
    }
    return map;
  }, [messages]);
  const children = React.useMemo(() => {
    const map = new Map();
    for (const m of messages) if (m.parent_id) map.set(m.parent_id, [...(map.get(m.parent_id) ?? []), m]);
    return map;
  }, [messages]);

  return (
    <>
      <style>{`@keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.3 } }`}</style>
      <PageHeader
        title="Chat"
        meta={activeThread ? `thread: ${activeThread.title}` : "new thread"}
        actions={
          <>
            {canWrite && threadId && (
              <Button size="sm" variant="secondary" onClick={() => switchThread(null)} style={{ gap: 6 }}>
                <Icon name="plus" size={12} /> New thread
              </Button>
            )}
            {threads.length > 0 && (
              <Select
                value={threadId ?? ""}
                onChange={(e) => switchThread(e.target.value)}
                aria-label="Thread"
                style={{ width: 180 }}
                options={[
                  { value: "", label: canWrite ? "New thread" : "Pick a thread…" },
                  ...threads.map((t) => ({ value: t.id, label: t.title })),
                ]}
              />
            )}
            {canWrite && threadId && (
              <DeleteConfirm armed={confirmingDelete} onArm={() => setConfirmingDelete(true)} onCancel={() => setConfirmingDelete(false)} onConfirm={deleteThread} disabled={busy || running}
                label="Delete thread" confirmLabel={"Delete thread"} />
            )}
          </>
        }
      />
      <div ref={scrollRef} aria-live="polite" aria-busy={running}
        onScroll={(e) => { const el = e.currentTarget; stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}
        style={{ flex: 1, overflowY: "auto", padding: "24px 0" }}>
        <div style={{ maxWidth: 960, margin: "0 auto", padding: "0 24px", display: "flex", flexDirection: "column", gap: 20 }}>
          {available === false && (
            <div role="status" style={{ border: "1px solid var(--border-default)", background: "var(--surface-inset)", borderRadius: "var(--radius-md)", padding: 16, fontSize: "var(--text-sm)", color: "var(--text-body)" }}>
              Chat can't answer yet: no AI model is connected to this metis.{" "}
              {isAdmin ? <>Connect one in <a href="/admin">AI models</a>.</> : "Ask an admin to connect one."}
              {" "}Everything else in metis works without it.
            </div>
          )}
          {messages.length === 0 && (
            <div style={{ border: "1px dashed var(--border-default)", borderRadius: "var(--radius-md)", padding: 20, color: "var(--text-secondary)", fontSize: "var(--text-sm)", lineHeight: "var(--leading-body)" }}>
              Ask about the inventory in plain words. For example:
              {canWrite && available !== false ? (
                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 6, marginTop: 8 }}>
                  {examples.map((q) => (
                    <Button key={q} size="sm" variant="secondary" disabled={busy || running} onClick={() => send(q)}
                      style={{ whiteSpace: "normal", height: "auto", minHeight: 28, padding: "4px 10px", textAlign: "left" }}>{q}</Button>
                  ))}
                </div>
              ) : (
                <ul style={{ margin: "8px 0 0", paddingLeft: 18 }}>
                  {examples.map((q) => <li key={q}>{q}</li>)}
                </ul>
              )}
              <div style={{ marginTop: 10 }}>Agents keep working if you leave this page. Anything they want to change waits for your approval.</div>
            </div>
          )}
          {messages.filter((m) => !m.parent_id).map((m) =>
            m.role === "user" ? (
              <div key={m.id} style={{ alignSelf: "flex-end", maxWidth: "75%", background: "var(--surface-inverse)", color: "var(--text-inverse)", padding: "10px 14px", borderRadius: "var(--radius-lg)", borderBottomRightRadius: "var(--radius-xs)", fontSize: "var(--text-sm)", lineHeight: "var(--leading-snug)", whiteSpace: "pre-wrap" }}>
                {m.content}
              </div>
            ) : m.agent_name === "orchestrator" ? (
              <Turn key={m.id} run={m} children={children.get(m.id) ?? []} canWrite={canWrite} onDecided={() => load()}
                onRetry={running || busy || !askedFor.get(m.id) ? null : () => send(askedFor.get(m.id))} />
            ) : (
              // Replies from before agents ran in the background.
              <div key={m.id} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <AgentMessage agent={m.agent_name} text={m.content} viz={m.viz} tools={m.tool_calls} status={m.status} />
                <Proposals message={m} canWrite={canWrite} onDecided={() => load()} />
              </div>
            ),
          )}
          {error && <div style={{ fontSize: "var(--text-sm)", color: "var(--danger-fg)" }}>{error}</div>}
        </div>
      </div>
      <div style={{ flex: "none", padding: "0 24px 20px" }}>
        {canWrite ? (
          <div style={{ maxWidth: 960, margin: "0 auto" }}>
            {running && (
              <div role="status" style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)", marginBottom: 6 }}>
                Agents are still working on the last message. You can leave this page; they keep going.
              </div>
            )}
            <div style={{ display: "flex", alignItems: "flex-end", gap: 8, background: "var(--surface-card)", border: "1px solid var(--border-default)", borderRadius: "var(--radius-lg)", padding: "10px 12px", boxShadow: "var(--shadow-card)" }}>
              <textarea
                rows={1}
                value={draft}
                aria-label="Message"
                placeholder={available === false ? "Chat is unavailable until an AI model is connected" : "Ask about goals, capabilities or features…"}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
                style={{ flex: 1, resize: "none", border: "none", outline: "none", background: "transparent", fontFamily: "var(--font-body)", fontSize: "var(--text-sm)", color: "var(--text-heading)", lineHeight: 1.5, padding: "4px 0" }}
              />
              <Button size="sm" variant="accent" onClick={() => send()} disabled={busy || running || !draft.trim() || available === false} style={{ gap: 6 }}>
                Send <Icon name="send" size={12} />
              </Button>
            </div>
          </div>
        ) : (
          <div style={{ maxWidth: 960, margin: "0 auto", padding: "12px 16px", background: "var(--surface-inset)", border: "1px solid var(--border-hairline)", borderRadius: "var(--radius-lg)", fontSize: "var(--text-sm)", color: "var(--text-secondary)" }}>
            You can read threads here. Sending messages and approving changes needs editor access.
          </div>
        )}
      </div>
    </>
  );
}
