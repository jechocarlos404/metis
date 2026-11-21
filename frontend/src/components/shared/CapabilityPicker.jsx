import React from "react";
import { BADGE_TONES } from "../../ds/feedback/Badge.jsx";
import { NEED, slugify } from "../../lib/words.js";
import { api } from "../../lib/api.js";
import { pickerItems } from "./picker-items.js";

/**
 * Pick capabilities by exact name — recognition, not recall, and never a fuzzy
 * auto-match (PRODUCT.md). Type to filter the inventory; Enter or click picks
 * the highlighted existing name; a name typed whole but for case or accents is
 * that name. A name nobody has lists the names metis calls near it, as "did
 * you mean", none of them picked. With allowNew, Enter on text that matches
 * nothing and has no near name adds it verbatim as a name nobody has yet (it
 * will read "not built yet"); with a near name listed, Add is a choice to make.
 *
 *   options:  [{ id, name, slug, hint?, need? }]   the inventory to pick from;
 *             need (a NEED key) tones a picked chip the way the verdict below
 *             says it, and a name no option has reads NEED.none, "not built yet"
 *   value:    [name, …]                     picked names, in order
 *   onChange: (names) => void
 */
export function CapabilityPicker({ id = "capability-picker", options, value, onChange, allowNew = false, placeholder = "Type a capability…", label = "Capabilities" }) {
  const [query, setQuery] = React.useState("");
  const [active, setActive] = React.useState(null);
  const [open, setOpen] = React.useState(false);
  // Near names per typed name (by slug), from the coverage read Check uses.
  const lookups = React.useRef(new Map());
  const [near, setNear] = React.useState({});
  const lookup = React.useCallback((text) => {
    const key = slugify(text);
    if (!lookups.current.has(key)) {
      lookups.current.set(key, api("/capabilities/coverage", { method: "POST", body: { features: [{ name: "picker", capabilities: [text] }] } })
        .then((r) => (r.features[0]?.capabilities[0]?.candidates ?? []).map((c) => c.name))
        .catch(() => [])
        .then((names) => { setNear((n) => ({ ...n, [key]: names })); return names; }));
    }
    return lookups.current.get(key);
  }, []);
  const queryRef = React.useRef(query);
  queryRef.current = query;

  const picked = new Set(value.map(slugify));
  const { items, current: initial, exact, canAddNew, lookup: needsLookup, pending } = pickerItems({
    options, picked, query, near: near[slugify(query)] ?? null, allowNew,
  });
  const current = active ?? initial;
  // Without allowNew, a name nobody has gets a line saying so, never a blank.
  const noMatch = !allowNew && slugify(query) && !items.length && !exact;

  React.useEffect(() => {
    if (!needsLookup) return undefined;
    const t = setTimeout(() => lookup(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query, needsLookup, lookup]);

  const add = (name) => {
    onChange([...value, name]);
    setQuery("");
    setActive(null);
  };
  const choose = (item) => add(item.kind === "add" ? item.name : item.option.name);
  const remove = (name) => onChange(value.filter((v) => v !== name));
  const bySlug = new Map(options.map((o) => [slugify(o.name), o]));

  const onKeyDown = (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive(Math.min(current + 1, Math.max(items.length - 1, 0))); setOpen(true); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(Math.max(current - 1, 0)); }
    else if (e.key === "Enter") {
      e.preventDefault();
      if (items[current]) choose(items[current]);
      else if (canAddNew && pending) {
        // Typed and Enter before the near names came back: add only once they
        // say there are none. Otherwise they show, for someone to choose.
        const typed = query.trim();
        lookup(typed).then((names) => {
          if (queryRef.current.trim() !== typed) return;
          const again = pickerItems({ options, picked, query: typed, near: names, allowNew });
          if (again.items.length === 1 && again.items[0].kind === "add") add(typed);
        });
      }
    } else if (e.key === "Backspace" && !query && value.length) remove(value[value.length - 1]);
    else if (e.key === "Escape" && open && items.length > 0) {
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
          const option = bySlug.get(slugify(name));
          // Options without a NEED key (a feature's "Built on") keep the accent.
          const need = option ? option.need && NEED[option.need] : NEED.none;
          const tone = BADGE_TONES[need ? need.tone : "accent"];
          return (
            <span key={name} title={need ? `${need.label}: ${need.hint}` : undefined}
              style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: "var(--text-xs)", padding: "2px 4px 2px 9px", borderRadius: "var(--radius-pill)", background: tone.bg, color: tone.fg }}>
              {name}
              <button type="button" aria-label={`Remove ${name}`} onClick={() => remove(name)}
                style={{ border: "none", background: "transparent", color: "inherit", cursor: "pointer", padding: "0 4px", font: "inherit" }}>×</button>
            </span>
          );
        })}
        <input id={id} role="combobox" aria-expanded={open && items.length > 0} aria-controls={listId} aria-autocomplete="list"
          value={query} placeholder={value.length ? "" : placeholder}
          onChange={(e) => { setQuery(e.target.value); setActive(null); setOpen(true); }}
          onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 120)} onKeyDown={onKeyDown}
          style={{ flex: "1 1 140px", minWidth: 120, border: "none", outline: "none", background: "transparent", font: "inherit", fontSize: "var(--text-sm)", color: "var(--text-body)", padding: "3px 2px" }} />
      </div>
      {open && items.length > 0 && (
        <ul id={listId} role="listbox" style={{ position: "absolute", zIndex: 30, left: 0, right: 0, top: "calc(100% + 4px)", margin: 0, padding: 4, listStyle: "none", background: "var(--surface-card)", border: "1px solid var(--border-hairline)", borderRadius: "var(--radius-md)", boxShadow: "var(--shadow-md, 0 6px 20px rgb(0 0 0 / 0.12))", maxHeight: 280, overflowY: "auto" }}>
          {items.map((item, i) => item.kind === "add" ? (
            <li key="add" role="option" aria-selected={i === current} onMouseDown={(e) => { e.preventDefault(); choose(item); }} onMouseEnter={() => setActive(i)}
              style={{ padding: "6px 8px", borderRadius: "var(--radius-sm)", cursor: "pointer", fontSize: "var(--text-sm)", color: "var(--text-secondary)", background: i === current ? "var(--surface-inset)" : "transparent" }}>
              Add “{item.name}”: a capability nobody has yet
            </li>
          ) : (
            <li key={item.option.id} role="option" aria-selected={i === current} onMouseDown={(e) => { e.preventDefault(); choose(item); }} onMouseEnter={() => setActive(i)}
              style={{ padding: "6px 8px", borderRadius: "var(--radius-sm)", cursor: "pointer", fontSize: "var(--text-sm)", background: i === current ? "var(--accent-wash)" : "transparent", display: "flex", gap: 8, alignItems: "baseline" }}>
              {!item.literal && <span style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>did you mean</span>}
              <span style={{ color: "var(--text-heading)" }}>{item.option.name}</span>
              {item.option.hint && <span style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>{item.option.hint}</span>}
            </li>
          ))}
        </ul>
      )}
      {open && noMatch && (
        <div role="status" style={{ marginTop: 4, fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>No capability named “{query.trim()}”.</div>
      )}
    </div>
  );
}
