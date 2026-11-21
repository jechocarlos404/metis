import { slugify } from "../../lib/words.js";

// What the capability picker lists for a typed name, and which line Enter
// takes. Kept apart from the component so the rule is testable.
//
//   options: [{ id, name, … }]  what the caller lets you pick
//   picked:  Set of slugs already picked
//   near:    names the backend calls near the typed one (coverage's
//            candidates), or null while that answer isn't in yet
//
// Lines: names holding the typed text, then near names ("did you mean"),
// then, with allowNew, "Add …". A near name is offered, never picked
// (PRODUCT.md): while one is listed, or still being looked up, nothing is
// the default, so Enter can't add a duplicate of a name that already exists.
export function pickerItems({ options, picked, query, near, allowNew }) {
  const q = query.trim().toLowerCase();
  // Suggestions ignore accents, so "Café" lists "Cafe" to pick. Only a
  // suggestion: what counts as the same name (exact, picked) stays exact.
  const fold = (s) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const fq = fold(q);
  // The whole name but for case or accents is the name itself (one slug).
  const literal = (o) => o.name.toLowerCase().includes(q) || slugify(o.name) === slugify(q);
  const matches = q
    ? options
        .filter((o) => !picked.has(slugify(o.name)) && fold(o.name).includes(fq))
        .sort((a, b) => Number(!literal(a)) - Number(!literal(b)) || Number(!fold(a.name).startsWith(fq)) - Number(!fold(b.name).startsWith(fq)) || a.name.localeCompare(b.name))
        .slice(0, 8)
    : [];
  const exact = options.some((o) => slugify(o.name) === slugify(q));
  // Near names the caller can take, not already listed or picked.
  const bySlug = new Map(options.map((o) => [slugify(o.name), o]));
  const listed = new Set(matches.map((o) => o.id));
  const nearOptions = (near ?? [])
    .map((name) => bySlug.get(slugify(name)))
    .filter((o) => o && !listed.has(o.id) && !picked.has(slugify(o.name)));
  const canAddNew = Boolean(allowNew && slugify(q) && !exact && !picked.has(slugify(q)));
  const items = [
    ...matches.map((o) => ({ kind: "option", option: o, literal: literal(o) })),
    ...nearOptions.map((o) => ({ kind: "option", option: o, literal: false })),
    ...(canAddNew ? [{ kind: "add", name: query.trim() }] : []),
  ];
  // The near-name lookup only runs for a name nobody has.
  const lookup = Boolean(slugify(q) && !exact);
  const pending = lookup && near == null;
  const current = items[0]?.literal ? 0
    : canAddNew && !pending && items.length === 1 ? 0
      : -1;
  return { items, current, exact, canAddNew, lookup, pending };
}
