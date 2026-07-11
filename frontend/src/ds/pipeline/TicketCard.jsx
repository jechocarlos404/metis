import React from "react";
import { StatusBadge } from "./StatusBadge.jsx";
import { BudgetBadge } from "./BudgetBadge.jsx";

export function TicketCard({ id, title, description, status = "pending", budget = "M", files = [], onClick, style }) {
  const [hover, setHover] = React.useState(false);
  return (
    <div onClick={onClick}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        background: "var(--surface-card)",
        border: "1px solid " + (hover && onClick ? "var(--border-default)" : "var(--border-hairline)"),
        borderRadius: "var(--radius-md)", boxShadow: hover && onClick ? "var(--shadow-raised)" : "var(--shadow-card)",
        padding: "var(--space-3) var(--space-4)", cursor: onClick ? "pointer" : "default",
        fontFamily: "var(--font-body)", transition: "box-shadow var(--dur-fast) var(--ease-out)", ...style,
      }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", marginBottom: "6px" }}>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", color: "var(--text-secondary)" }}>{id}</span>
        <span style={{ display: "inline-flex", gap: "6px", alignItems: "center" }}>
          <StatusBadge status={status} />
          <BudgetBadge budget={budget} />
        </span>
      </div>
      <div style={{ fontSize: "var(--text-md)", fontWeight: "var(--weight-semibold)", color: "var(--text-heading)", letterSpacing: "var(--tracking-tight)" }}>{title}</div>
      {description && <div style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)", marginTop: "4px", lineHeight: "var(--leading-snug)" }}>{description}</div>}
      {files.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "4px", marginTop: "10px" }}>
          {files.map((f) => (
            <span key={f} style={{ fontFamily: "var(--font-mono)", fontSize: "10px", color: "var(--text-secondary)", background: "var(--surface-inset)", padding: "2px 6px", borderRadius: "var(--radius-xs)" }}>{f}</span>
          ))}
        </div>
      )}
    </div>
  );
}
