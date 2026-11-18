// People's words for the API's enums and counts.

const STATUS = {
  pending: "planned",
  in_progress: "in progress",
  done: "done",
  draft: "draft",
  approved: "approved",
  blocked: "blocked",
};

export function statusLabel(status) {
  return STATUS[status] ?? String(status ?? "").replace(/_/g, " ");
}

// count(3, "slot") → "3 slots"; count(1, "capability", "capabilities") → "1 capability"
export function count(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

// One product order for every picker: ours first, then external, each A–Z.
export const productOptions = (products) =>
  [...products]
    .sort((a, b) => Number(a.external) - Number(b.external) || a.name.localeCompare(b.name))
    .map((p) => ({ value: p.id, label: p.external ? `${p.name} (external)` : p.name }));
