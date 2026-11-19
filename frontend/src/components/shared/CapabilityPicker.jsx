import React from "react";
import { slugify } from "../../lib/words.js";

/**
 * Pick capabilities by exact name — recognition, not recall, and never a fuzzy
 * auto-match (PRODUCT.md). Type to filter the inventory; Enter or click picks
 * the highlighted existing name. With allowNew, Enter on text that matches
 * nothing adds it verbatim as a name nobody has yet (it will read "missing").
 *
 *   options:  [{ id, name, slug, hint? }]   the inventory to pick from
 *   value:    [name, …]                     picked names, in order
 *   onChange: (names) => void
 */
export function CapabilityPicker({ id = "capability-picker", options, value, onChange, allowNew = false, placeholder = "Type a capability…", label = "Capabilities" }) {
  const [query, setQuery] = React.useState("");
  const [active, setActive] = React.useState(0);
  const [open, setOpen] = React.useState(false);
  const picked = new Set(value.map(slugify));
  const q = query.trim().toLowerCase();
  const matches = q
    ? options
        .filter((o) => !picked.has(slugify(o.name)) && o.name.toLowerCase().includes(q))
        .sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)) || a.name.localeCompare(b.name))
        .slice(0, 8)
    : [];
  const exact = options.some((o) => slugify(o.name) === slugify(q));
  const canAddNew = allowNew && slugify(q) && !exact && !picked.has(slugify(q));

  const add = (name) => {
    onChange([...value, name]);
    setQuery("");
    setActive(0);
  };
  const remove = (name) => onChange(value.filter((v) => v !== name));
  const known = new Set(options.map((o) => slugify(o.name)));

  const onKeyDown = (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, Math.max(matches.length - 1, 0))); setOpen(true); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === "Enter") {
      e.preventDefault();
      if (matches[active]) add(matches[active].name);
      else if (canAddNew) add(query.trim());
    } else if (e.key === "Backspace" && !query && value.length) remove(value[value.length - 1]);
    else if (e.key === "Escape" && open && (matches.length > 0 || canAddNew)) {
      // Close the list only; don't let a surrounding Dialog close too.
      e.stopPropagation();
      setOpen(false);
    }
  };

  const listId = `${id}-list`;
  return (
    <div style={{ position: "relative" }}>
      <label htmlFor={id} style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>{label}</label>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", border: "1px solid var(--border-control)", borderRadius: "var(--radius-md)", padding: "6px 8px", background: "var(--surface-card)" }}>
        {value.map((name) => {
          const isKnown = known.has(slugify(name));
          return (
            <span key={name} title={isKnown ? undefined : "No product in metis has a capability by this exact name"}
              style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: "var(--text-xs)", padding: "2px 4px 2px 9px", borderRadius: "var(--radius-pill)", background: isKnown ? "var(--accent-wash)" : "var(--danger-bg)", color: isKnown ? "var(--text-accent)" : "var(--danger-fg)" }}>
              {name}
              <button type="button" aria-label={`Remove ${name}`} onClick={() => remove(name)}
                style={{ border: "none", background: "transparent", color: "inherit", cursor: "pointer", padding: "0 4px", font: "inherit" }}>×</button>
            </span>
          );
        })}
        <input id={id} role="combobox" aria-expanded={open && (matches.length > 0 || !!canAddNew)} aria-controls={listId} aria-autocomplete="list"
          value={query} placeholder={value.length ? "" : placeholder}
          onChange={(e) => { setQuery(e.target.value); setActive(0); setOpen(true); }}
          onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 120)} onKeyDown={onKeyDown}
          style={{ flex: "1 1 140px", minWidth: 120, border: "none", outline: "none", background: "transparent", font: "inherit", fontSize: "var(--text-sm)", color: "var(--text-body)", padding: "3px 2px" }} />
      </div>
      {open && (matches.length > 0 || canAddNew) && (
        <ul id={listId} role="listbox" style={{ position: "absolute", zIndex: 30, left: 0, right: 0, top: "calc(100% + 4px)", margin: 0, padding: 4, listStyle: "none", background: "var(--surface-card)", border: "1px solid var(--border-hairline)", borderRadius: "var(--radius-md)", boxShadow: "var(--shadow-md, 0 6px 20px rgb(0 0 0 / 0.12))", maxHeight: 280, overflowY: "auto" }}>
          {matches.map((o, i) => (
            <li key={o.id} role="option" aria-selected={i === active} onMouseDown={(e) => { e.preventDefault(); add(o.name); }} onMouseEnter={() => setActive(i)}
              style={{ padding: "6px 8px", borderRadius: "var(--radius-sm)", cursor: "pointer", fontSize: "var(--text-sm)", background: i === active ? "var(--accent-wash)" : "transparent", display: "flex", gap: 8, alignItems: "baseline" }}>
              <span style={{ color: "var(--text-heading)" }}>{o.name}</span>
              {o.hint && <span style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>{o.hint}</span>}
            </li>
          ))}
          {canAddNew && (
            <li role="option" aria-selected={matches.length === 0} onMouseDown={(e) => { e.preventDefault(); add(query.trim()); }}
              style={{ padding: "6px 8px", borderRadius: "var(--radius-sm)", cursor: "pointer", fontSize: "var(--text-sm)", color: "var(--text-secondary)", background: matches.length === 0 ? "var(--surface-inset)" : "transparent" }}>
              Add “{query.trim()}”: a capability nobody has yet
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
