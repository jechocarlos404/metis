import React from "react";
import { Badge } from "../../ds";

export default function HealthBadges() {
  const [checks, setChecks] = React.useState(null);

  React.useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch("/api/health");
        const data = await res.json();
        if (!cancelled) setChecks(data.checks);
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

  const tone = (value) =>
    value == null ? "neutral" : String(value).startsWith("ok") ? "ok" : "danger";

  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
      <Badge tone={tone(checks?.api)}>api</Badge>
      <Badge tone={tone(checks?.db)}>db</Badge>
      <Badge tone={tone(checks?.graph)}>graph</Badge>
    </div>
  );
}
