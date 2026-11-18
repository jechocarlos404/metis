// Props that make a non-button element (a grid row, a card) reachable and
// operable from the keyboard: focusable, announced as a button, Enter/Space act.
export function pressable(onActivate) {
  return {
    role: "button",
    tabIndex: 0,
    onClick: onActivate,
    onKeyDown: (e) => {
      if (e.target !== e.currentTarget) return;
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onActivate(e); }
    },
  };
}
