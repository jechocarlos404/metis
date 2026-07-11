import React from "react";
import { PageHeader } from "../shell/PageHeader.jsx";
import { VizBlock } from "../chat/VizBlock.jsx";
import { Button, Icon, IconButton, PipelineStepper, Select } from "../../ds";
import { api } from "../../lib/api.js";
import { sseStream } from "../../lib/sse.js";

function AgentMessage({ agent, text, viz, tools, streaming }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: "88%" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ width: 22, height: 22, borderRadius: "var(--radius-sm)", background: "var(--accent-wash)", color: "var(--text-accent)", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <Icon name="sparkles" size={12} />
        </span>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", color: "var(--text-secondary)" }}>{agent || "agent"}</span>
        {streaming && <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--accent)", animation: "pulse 1s infinite" }} />}
      </div>
      {(tools || []).map((t, i) => (
        <div key={i} style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: t.status === "failed" ? "var(--danger-fg)" : "var(--text-secondary)" }}>
          → {t.name} · {t.status}
        </div>
      ))}
      {text && (
        <div style={{ fontSize: "var(--text-sm)", color: "var(--text-body)", lineHeight: "var(--leading-body)", whiteSpace: "pre-wrap" }}>{text}</div>
      )}
      {(viz || []).map((block, i) => (
        <VizBlock key={i} block={block} />
      ))}
    </div>
  );
}

export default function ChatIsland({ threadId: initialThreadId = null }) {
  const [threads, setThreads] = React.useState([]);
  const [threadId, setThreadId] = React.useState(initialThreadId);
  const [messages, setMessages] = React.useState([]);
  const [live, setLive] = React.useState(null); // in-flight agent message
  const [draft, setDraft] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);
  const scrollRef = React.useRef(null);
  const abortRef = React.useRef(null);

  React.useEffect(() => {
    api("/chat/threads").then(setThreads).catch(() => setThreads([]));
    return () => abortRef.current?.abort();
  }, []);

  React.useEffect(() => {
    if (!threadId) {
      setMessages([]);
      return;
    }
    api(`/chat/threads/${threadId}/messages`).then(setMessages).catch(() => setMessages([]));
  }, [threadId]);

  React.useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, live]);

  const switchThread = (id) => {
    setThreadId(id || null);
    const path = id ? `/chat/${id}` : "/chat";
    window.history.replaceState({}, "", path);
  };

  const send = async () => {
    const content = draft.trim();
    if (!content || busy) return;
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
        switchThread(id);
      }
      setMessages((m) => [...m, { id: `local-${Date.now()}`, role: "user", content, viz: [] }]);

      const controller = new AbortController();
      abortRef.current = controller;
      let current = { agent: null, text: "", viz: [], tools: [] };
      setLive({ ...current });

      for await (const { event, data } of sseStream(`/api/chat/threads/${id}/messages`, { content }, { signal: controller.signal })) {
        if (event === "routing" || event === "message_start") {
          current = { ...current, agent: data.agent };
        } else if (event === "text_delta") {
          current = { ...current, text: current.text + data.text };
        } else if (event === "tool_call") {
          const tools = [...current.tools];
          const idx = tools.findLastIndex((t) => t.name === data.name);
          if (data.status === "started" || idx === -1) tools.push({ name: data.name, status: data.status });
          else tools[idx] = { name: data.name, status: data.status };
          current = { ...current, tools };
        } else if (event === "viz_block") {
          current = { ...current, viz: [...current.viz, data] };
        } else if (event === "message_end") {
          const finished = { ...data.message, tools: current?.tools ?? [] };
          setMessages((m) => [...m, finished]);
          current = null;
          setLive(null);
        } else if (event === "error") {
          current = { ...current, text: `${current.text}${current.text ? "\n" : ""}${data.message}` };
        }
        if (current) setLive({ ...current });
      }
      if (current && (current.text || current.viz.length)) {
        // stream ended without message_end (disconnect) — keep what we have
        setMessages((m) => [...m, { id: `local-a-${Date.now()}`, role: "agent", agent_name: current.agent, content: current.text, viz: current.viz, tools: current.tools }]);
      }
      setLive(null);
    } catch (e) {
      setError(String(e.message));
      setLive(null);
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  };

  const activeThread = threads.find((t) => t.id === threadId);

  return (
    <>
      <style>{`@keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.3 } }`}</style>
      <PageHeader
        title="Chat"
        meta={activeThread ? `thread: ${activeThread.title}` : "new thread"}
        actions={
          <>
            <PipelineStepper active={4} compact />
            <Select
              value={threadId ?? ""}
              onChange={(e) => switchThread(e.target.value)}
              style={{ width: 180 }}
              options={[{ value: "", label: "New thread…" }, ...threads.map((t) => ({ value: t.id, label: t.title }))]}
            />
          </>
        }
      />
      <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: "24px 0" }}>
        <div style={{ maxWidth: 720, margin: "0 auto", padding: "0 24px", display: "flex", flexDirection: "column", gap: 20 }}>
          {messages.length === 0 && !live && (
            <div style={{ border: "1px dashed var(--border-default)", borderRadius: "var(--radius-md)", padding: 20, color: "var(--text-disabled)", fontSize: "var(--text-sm)", lineHeight: "var(--leading-body)" }}>
              Describe a goal, decompose a Spec, or ask the graph.
              The orchestrator routes each message to `spec_decomposer`, `feature_manager`, `graph_agent`, or `strategist`.
            </div>
          )}
          {messages.map((m) =>
            m.role === "user" ? (
              <div key={m.id} style={{ alignSelf: "flex-end", maxWidth: "75%", background: "var(--surface-inverse)", color: "var(--text-inverse)", padding: "10px 14px", borderRadius: "var(--radius-lg)", borderBottomRightRadius: "var(--radius-xs)", fontSize: "var(--text-sm)", lineHeight: "var(--leading-snug)", whiteSpace: "pre-wrap" }}>
                {m.content}
              </div>
            ) : (
              <AgentMessage key={m.id} agent={m.agent_name} text={m.content} viz={m.viz} tools={m.tools} />
            ),
          )}
          {live && <AgentMessage agent={live.agent} text={live.text} viz={live.viz} tools={live.tools} streaming />}
          {error && <div style={{ fontSize: "var(--text-sm)", color: "var(--danger-fg)" }}>{error}</div>}
        </div>
      </div>
      <div style={{ flex: "none", padding: "0 24px 20px" }}>
        <div style={{ maxWidth: 720, margin: "0 auto", display: "flex", alignItems: "flex-end", gap: 8, background: "var(--surface-card)", border: "1px solid var(--border-default)", borderRadius: "var(--radius-lg)", padding: "10px 12px", boxShadow: "var(--shadow-card)" }}>
          <textarea
            rows={1}
            value={draft}
            placeholder="Describe a goal, or ask the graph…"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            style={{ flex: 1, resize: "none", border: "none", outline: "none", background: "transparent", fontFamily: "var(--font-body)", fontSize: "var(--text-sm)", color: "var(--text-heading)", lineHeight: 1.5, padding: "4px 0" }}
          />
          <Button size="sm" variant="accent" onClick={send} disabled={busy || !draft.trim()} style={{ gap: 6 }}>
            Send <Icon name="send" size={12} />
          </Button>
        </div>
      </div>
    </>
  );
}
