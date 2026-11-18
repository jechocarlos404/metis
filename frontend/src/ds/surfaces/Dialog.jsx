import React from "react";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Dialog({ open, title, onClose, footer, width = "480px", children }) {
  const panelRef = React.useRef(null);
  const titleId = React.useId();
  const onCloseRef = React.useRef(onClose);
  onCloseRef.current = onClose;

  // On open: remember what had focus, move focus inside. On close: give it back.
  React.useEffect(() => {
    if (!open) return;
    const previous = document.activeElement;
    const panel = panelRef.current;
    const first = panel?.querySelector("[data-autofocus]") ?? panel?.querySelector("[data-dialog-body]")?.querySelector(FOCUSABLE);
    (first ?? panel)?.focus();
    return () => {
      if (previous && typeof previous.focus === "function" && document.contains(previous)) previous.focus();
    };
  }, [open]);

  if (!open) return null;

  const onKeyDown = (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onCloseRef.current?.();
      return;
    }
    if (e.key !== "Tab") return;
    // Keep Tab inside the dialog.
    const items = [...panelRef.current.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
    if (items.length === 0) return;
    const firstEl = items[0];
    const lastEl = items[items.length - 1];
    if (e.shiftKey && document.activeElement === firstEl) { e.preventDefault(); lastEl.focus(); }
    else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); firstEl.focus(); }
  };

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "oklch(0.2 0.01 90 / 0.4)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, padding: "24px",
    }}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onClick={(e) => e.stopPropagation()}
        style={{
          width, maxWidth: "100%", maxHeight: "85vh", overflow: "auto", outline: "none",
          background: "var(--surface-card)", borderRadius: "var(--radius-lg)",
          boxShadow: "var(--shadow-overlay)", fontFamily: "var(--font-body)",
        }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "var(--space-4) var(--space-5)", borderBottom: "1px solid var(--border-hairline)" }}>
          <div id={titleId} style={{ fontWeight: "var(--weight-semibold)", fontSize: "var(--text-lg)", color: "var(--text-heading)" }}>{title}</div>
          <button aria-label="Close" onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-secondary)", padding: "4px", display: "flex" }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
          </button>
        </div>
        <div data-dialog-body style={{ padding: "var(--space-5)" }}>{children}</div>
        {footer && <div style={{ padding: "var(--space-4) var(--space-5)", borderTop: "1px solid var(--border-hairline)", display: "flex", justifyContent: "flex-end", gap: "8px" }}>{footer}</div>}
      </div>
    </div>
  );
}
