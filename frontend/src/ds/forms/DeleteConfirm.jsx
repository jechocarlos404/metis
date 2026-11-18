import React from "react";
import { Button } from "./Button.jsx";
import { Icon } from "../Icons.jsx";

// Two-step delete: the first click asks, and the confirming button appears
// beside a "Keep" button, never under the pointer, so a double-click can't confirm.
export function DeleteConfirm({ armed, onArm, onCancel, onConfirm, disabled, label = "Delete", confirmLabel, style }) {
  const keepRef = React.useRef(null);
  React.useEffect(() => { if (armed) keepRef.current?.focus(); }, [armed]);
  if (!armed) {
    return (
      <Button size="sm" variant="secondary" disabled={disabled} style={{ gap: 6, ...style }} onClick={onArm}>
        <Icon name="trash" size={13} />{label}
      </Button>
    );
  }
  return (
    <span role="group" aria-label="Confirm delete" style={{ display: "inline-flex", alignItems: "center", gap: 6, ...style }}>
      <span style={{ fontSize: "var(--text-xs)", color: "var(--text-body)" }}>Can't be undone.</span>
      <Button ref={keepRef} size="sm" variant="secondary" disabled={disabled} onClick={onCancel}>Keep</Button>
      <Button size="sm" variant="danger" disabled={disabled} onClick={onConfirm}>{confirmLabel}</Button>
    </span>
  );
}
