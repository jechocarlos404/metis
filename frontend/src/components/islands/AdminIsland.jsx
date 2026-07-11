import React from "react";
import { PageHeader } from "../shell/PageHeader.jsx";
import { Badge, Input, Select, Toast } from "../../ds";
import { api } from "../../lib/api.js";

export default function AdminIsland() {
  const [providers, setProviders] = React.useState([]);
  const [configs, setConfigs] = React.useState([]);
  const [toast, setToast] = React.useState(null);

  React.useEffect(() => {
    Promise.all([api("/admin/llm/providers"), api("/admin/llm/configs")])
      .then(([p, c]) => { setProviders(p); setConfigs(c); })
      .catch((e) => setToast({ tone: "danger", title: "Load failed", detail: String(e.message) }));
  }, []);

  const modelsFor = (providerName) =>
    providers.find((p) => p.name === providerName)?.models ?? [];

  const update = async (agentName, provider, model) => {
    const models = modelsFor(provider);
    const nextModel = model || models[0] || "";
    setConfigs((cs) => cs.map((c) => (c.agent_name === agentName ? { ...c, provider, model: nextModel } : c)));
    if (!nextModel) return; // wait until a model is picked
    try {
      await api(`/admin/llm/configs/${agentName}`, { method: "PUT", body: { provider, model: nextModel } });
      setToast({ tone: "ok", title: `${agentName} → ${provider}/${nextModel}` });
    } catch (e) {
      setToast({ tone: "danger", title: "Save failed", detail: String(e.message) });
    }
  };

  return (
    <>
      <PageHeader title="LLM Config" meta="per-agent model selection" />
      <div style={{ flex: 1, overflowY: "auto", padding: 24, display: "flex", flexDirection: "column", gap: 20 }}>
        <div style={{ maxWidth: 560 }}>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "var(--tracking-caps)", textTransform: "uppercase", color: "var(--text-disabled)", marginBottom: 8 }}>
            Providers
          </div>
          <div style={{ background: "var(--surface-card)", border: "1px solid var(--border-hairline)", borderRadius: "var(--radius-md)", overflow: "hidden" }}>
            {providers.map((p, i) => (
              <div key={p.name} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 16px", borderBottom: i < providers.length - 1 ? "1px solid var(--border-hairline)" : "none" }}>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-heading)", width: 100 }}>{p.name}</span>
                <span style={{ flex: 1, fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>{p.available ? p.label : p.detail}</span>
                <Badge tone={p.available ? "ok" : "neutral"}>{p.available ? "available" : "not configured"}</Badge>
              </div>
            ))}
          </div>
        </div>

        <div style={{ maxWidth: 560 }}>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "var(--tracking-caps)", textTransform: "uppercase", color: "var(--text-disabled)", marginBottom: 8 }}>
            Agents
          </div>
          <div style={{ background: "var(--surface-card)", border: "1px solid var(--border-hairline)", borderRadius: "var(--radius-md)", overflow: "hidden" }}>
            {configs.map((c, i) => {
              const models = modelsFor(c.provider);
              return (
                <div key={c.agent_name} style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", borderBottom: i < configs.length - 1 ? "1px solid var(--border-hairline)" : "none" }}>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-heading)", flex: 1 }}>{c.agent_name}</span>
                  <Select value={c.provider} style={{ width: 130 }}
                    onChange={(e) => update(c.agent_name, e.target.value, "")}
                    options={providers.map((p) => ({ value: p.name, label: p.name }))} />
                  {models.length > 0 ? (
                    <Select value={c.model} style={{ width: 200 }}
                      onChange={(e) => update(c.agent_name, c.provider, e.target.value)}
                      options={models.includes(c.model) ? models : [c.model, ...models]} />
                  ) : (
                    <Input mono value={c.model} style={{ width: 200 }} inputStyle={{ height: 34 }}
                      placeholder="model id"
                      onChange={(e) => setConfigs((cs) => cs.map((x) => (x.agent_name === c.agent_name ? { ...x, model: e.target.value } : x)))}
                      onBlur={(e) => e.target.value.trim() && update(c.agent_name, c.provider, e.target.value.trim())} />
                  )}
                </div>
              );
            })}
          </div>
          <div style={{ marginTop: 8, fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>
            Providers are detected from environment credentials. Ollama models are read live from the local server.
          </div>
        </div>
      </div>
      {toast && (
        <div style={{ position: "fixed", bottom: 20, right: 20, zIndex: 200 }}>
          <Toast tone={toast.tone} title={toast.title} detail={toast.detail} onDismiss={() => setToast(null)} />
        </div>
      )}
    </>
  );
}
