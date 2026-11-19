import React from "react";

const NAMES = { db: "database", graph: "graph" };

// Silent while every service is ok. When one isn't, one danger row names it;
// the title carries each service's raw status (graph includes its node count).
export default function HealthBadges() {
  const [checks, setChecks] = React.useState(null);

  React.useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch("/api/health");
        const data = res.ok ? await res.json() : null;
        // The proxy answers 502 {detail} when the backend is unreachable.
        if (!cancelled) setChecks(data?.checks ?? { api: "down" });
      } catch {
        if (!cancelled) setChecks({ api: "down" });
      }
    };
    poll();
    const timer = setInterval(poll, 30000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  if (!checks) return null;
  const failing = Object.entries(checks).filter(([, v]) => !String(v).startsWith("ok"));
  if (failing.length === 0) return null;

  const detail = Object.entries(checks).map(([k, v]) => `${k}: ${v}`).join("\n");
  const message = checks.api !== "ok"
    ? "Can't reach the server"
    : `Server problem: ${failing.map(([k]) => NAMES[k] ?? k).join(", ")}`;
  return (
    <div role="status" aria-label={message} title={detail}
      style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 16px", borderTop: "1px solid var(--border-hairline)", background: "var(--danger-bg)", color: "var(--danger-fg)", fontSize: "var(--text-xs)", fontWeight: "var(--weight-medium)" }}>
      <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: "50%", background: "currentColor", flex: "none" }} />
      <span className="nav-label">{message}</span>
    </div>
  );
}
