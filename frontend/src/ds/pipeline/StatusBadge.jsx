import React from "react";
import { statusLabel } from "../../lib/words.js";
import { BADGE_TONES } from "../feedback/Badge.jsx";

// One colour per work status on every screen. A screen that shows a status in
// a plain <Badge> takes its tone from here too, so "in progress" is amber
// everywhere and blue (accent) stays free for "live".
export const STATUS_TONE = {
  pending: "neutral",
  in_progress: "warn",
  done: "ok",
  draft: "accent",
  approved: "ok",
  blocked: "danger",
};

export function StatusBadge({ status = "pending", style }) {
  const t = BADGE_TONES[STATUS_TONE[status] ?? "neutral"];
  return (
    <span title={status} style={{
      display: "inline-flex", alignItems: "center", gap: "5px",
      padding: "2px 8px", borderRadius: "var(--radius-pill)",
      background: t.bg, color: t.fg,
      fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", fontWeight: "var(--weight-semibold)",
      whiteSpace: "nowrap", ...style,
    }}>
      <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: "currentColor" }} />
      {statusLabel(status)}
    </span>
  );
}
