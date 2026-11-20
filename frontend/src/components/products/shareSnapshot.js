// A product's picture as one self-contained, read-only HTML file, for someone
// without a metis login. Built only from what the profile already loaded, and
// only from named fields: no ids, no links, no guesses, no repo paths.
import {
  CLOSEST_TITLE, DONE_WHEN, NEED, NOTHING_TO_SCORE, VERDICT, andList, closestGroups, closestNote, count, gapNote, gapsTitle,
  incompleteNote, scoreGroups, scoreHeadline, slugify, statusLabel,
} from "../../lib/words.js";
import { productGoalTrees } from "../graph/goal-facts.js";

const ENTITIES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ENTITIES[c]);

const CSS = `
:root { --bg: #ffffff; --fg: #1d1d1f; --muted: #5f6368; --line: #e3e3e6; --card: #f7f7f8; --accent: #2f5bd3; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #151517; --fg: #ececef; --muted: #a2a2aa; --line: #2e2e33; --card: #1d1d21; --accent: #8fa9ff; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
main { max-width: 760px; margin: 0 auto; padding: 32px 16px 48px; }
h1 { font-size: 26px; line-height: 1.25; margin: 0; }
h2 { font-size: 17px; margin: 32px 0 10px; }
h3 { font-size: 15px; margin: 18px 0 4px; }
p { margin: 6px 0; }
ul { margin: 6px 0; padding-left: 20px; }
.meta { color: var(--muted); font-size: 13px; margin-top: 6px; }
.muted { color: var(--muted); }
.tag { display: inline-block; font-size: 12px; border: 1px solid var(--line); border-radius: 999px; padding: 0 8px; margin-left: 8px; vertical-align: 3px; color: var(--muted); }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; margin: 10px 0; break-inside: avoid; }
.card h3 { font-size: 15px; margin: 0 0 4px; }
.row { display: flex; gap: 12px; justify-content: space-between; padding: 3px 0; }
.row .name { min-width: 0; overflow-wrap: anywhere; }
.row .status { color: var(--muted); font-size: 13px; white-space: nowrap; }
.num { font-variant-numeric: tabular-nums; font-weight: 600; color: var(--accent); }
footer { margin-top: 40px; padding-top: 12px; border-top: 1px solid var(--line); color: var(--muted); font-size: 13px; }
@media print {
  :root { --bg: #ffffff; --fg: #000000; --muted: #444444; --line: #cccccc; --card: #ffffff; --accent: #000000; }
  main { padding: 0; max-width: none; }
}
`;

const dateText = (d) => d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

// Features grouped by capability, the way the profile's "What it does" does it.
function groupFeatures(features, capabilities) {
  const capById = new Map(capabilities.map((c) => [c.id, c]));
  const groups = new Map();
  const unnamed = [];
  for (const f of features) {
    const caps = (f.capability_ids ?? []).filter((id) => capById.has(id));
    if (caps.length === 0) unnamed.push(f);
    for (const id of caps) {
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(f);
    }
  }
  const grouped = [...groups.entries()]
    .map(([id, list]) => ({ cap: capById.get(id), list }))
    .sort((a, b) => b.list.length - a.list.length || a.cap.name.localeCompare(b.cap.name));
  return { grouped, unnamed };
}

// The goal trees the product's Goals tab draws (productGoalTrees()): each
// head goal, then the goals under it (A43).
function goalSection(product, goals) {
  const trees = productGoalTrees(product, goals);
  if (trees.length === 0) return "";
  const total = trees.reduce((n, t) => n + 1 + t.children.length, 0);
  const cards = trees.map(({ goal, children }) => {
    const parent = goals.find((g) => g.id === goal.parent_goal_id);
    return `<div class="card">
  <h3>${esc(goal.title)} <span class="tag">${esc(statusLabel(goal.status))}</span></h3>
  ${goal.description ? `<p>${esc(goal.description)}</p>` : ""}
  ${goal.success_criteria ? `<p class="muted">${esc(DONE_WHEN)}: ${esc(goal.success_criteria)}</p>` : ""}
  ${parent ? `<p class="muted">Part of: ${esc(parent.title)}</p>` : ""}
  ${children.map(({ goal: g, depth }) => `<div class="row"${depth > 1 ? ` style="padding-left: ${(depth - 1) * 16}px"` : ""}><span class="name">${esc(g.title)}</span><span class="status">${esc(statusLabel(g.status))}</span></div>`).join("")}
</div>`;
  });
  return `<h2>${total > 1 ? "Goals" : "Goal"}</h2>
${cards.join("\n")}`;
}

// The product page's score, in its words (lib/words.js) and order. Only
// someone else's product is scored: ours would score themselves.
function scoreSection(product, score) {
  if (!product.external) return "";
  const title = `<h2>How much of ${esc(product.name)} we could build</h2>`;
  if (!score) return `${title}<p class="muted">Not scored in this snapshot.</p>`;
  const headline = scoreHeadline(score);
  // Each group names its features, as the page does, with how many of each
  // one's capabilities are ours.
  const ofOurs = new Map((score.report?.features ?? []).map((f) => [f.name, `${f.existing} of ${f.total} ours`]));
  const groups = scoreGroups(score)
    .filter((g) => g.names.length > 0)
    .map((g) => {
      const note = g.key === "missing" ? incompleteNote(score) : null;
      const names = g.names.map((n) => `<li>${esc(n)}${ofOurs.has(n) ? ` <span class="muted">· ${esc(ofOurs.get(n))}</span>` : ""}</li>`).join("");
      return `<li><span class="num">${g.names.length}</span> ${esc(VERDICT[g.key].label)}: <span class="muted">${esc(VERDICT[g.key].hint)}</span>${note ? `<br><span class="muted">${esc(note)}</span>` : ""}<ul>${names}</ul></li>`;
    })
    .join("");
  const gaps = score.missing_capabilities;
  const closest = closestGroups(score.closest_products);
  const report = score.report;
  return `${title}
<p class="muted">"Ours": ${esc(NEED.ours.hint)}.</p>
${headline ? `<p>${esc(headline)}</p>` : ""}
<p>${esc(score.product.name)}: ${esc(count(score.total_features, "feature"))}</p>
<ul>${groups}</ul>
${report ? "" : `<p class="muted">${esc(NOTHING_TO_SCORE)}</p>`}
${gaps.length > 0 ? `<h3>${esc(gapsTitle(gaps))}</h3>
<ul>${gaps.map((g) => `<li>${esc(g.name)} <span class="muted">· ${esc(gapNote(g))}</span></li>`).join("")}</ul>` : ""}
${closest.length > 0 ? `<h3>${esc(CLOSEST_TITLE)}</h3>
<ul>${closest.map((g) => `<li>${esc(andList(g.products.map((p) => p.name)))} <span class="muted">${esc(closestNote(g, score))}</span></li>`).join("")}</ul>` : ""}
${report && report.missing.length > 0 ? `<p>To build: ${esc(report.missing.join(", "))}</p>` : ""}`;
}

function featureRows(list, showStatus) {
  return list
    .map((f) => `<div class="row"><span class="name">${esc(f.name)}</span>${showStatus ? `<span class="status">${esc(statusLabel(f.status))}</span>` : ""}</div>`)
    .join("");
}

function doesSection(product, features, grouped, unnamed) {
  if (features.length === 0) return `<h2>What it does</h2><p class="muted">No features recorded yet.</p>`;
  const showStatus = !product.external;
  const cards = grouped.map(({ cap, list }) => `<div class="card">
  <h3>${esc(cap.name)}</h3>
  ${featureRows(list, showStatus)}
</div>`);
  if (unnamed.length > 0) {
    cards.push(`<div class="card"><h3 class="muted">No capability named yet</h3>${featureRows(unnamed, showStatus)}</div>`);
  }
  return `<h2>What it does</h2>
<p class="muted">${esc(count(features.length, "feature"))}, grouped by the capability each one uses.</p>
${cards.join("\n")}`;
}

function sharedSection(product, grouped) {
  const shared = grouped
    .map(({ cap }) => ({
      cap,
      others: [
        ...(cap.products ?? []).map((p) => ({ id: p.id, name: p.name })),
        ...(cap.external_products ?? []).map((p) => ({ id: p.id, name: `${p.name} (external)` })),
      ].filter((p) => p.id !== product.id),
    }))
    .filter((s) => s.others.length > 0)
    .sort((a, b) => b.others.length - a.others.length || a.cap.name.localeCompare(b.cap.name));
  if (grouped.length === 0) return "";
  if (shared.length === 0) return `<h2>Shared with other products</h2><p class="muted">None of its capabilities appear in another product.</p>`;
  const items = shared
    .map((s) => `<li><strong>${esc(s.cap.name)}</strong> <span class="muted">with ${esc(s.others.map((p) => p.name).sort((a, b) => a.localeCompare(b)).join(", "))}</span></li>`)
    .join("");
  return `<h2>Shared with other products</h2>
<p class="muted">${esc(count(shared.length, "capability", "capabilities"))} of ${esc(grouped.length)} also used elsewhere.</p>
<ul>${items}</ul>`;
}

/** The snapshot HTML. Inputs are the profile's own API responses. */
export function snapshotHtml({ product, goals, features, capabilities, score, now = new Date() }) {
  const date = dateText(now);
  const { grouped, unnamed } = groupFeatures(features, capabilities);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<meta name="color-scheme" content="light dark">
<title>${esc(product.name)} snapshot</title>
<style>${CSS}</style>
</head>
<body>
<main>
<h1>${esc(product.name)}<span class="tag">${product.external ? "external" : "ours"}</span></h1>
<div class="meta">As of ${esc(date)}${product.external ? ". Someone else's product: its features never count as ours." : ""}</div>
${product.summary ? `<p>${esc(product.summary)}</p>` : ""}
${goalSection(product, goals)}
${scoreSection(product, score)}
${doesSection(product, features, grouped, unnamed)}
${sharedSection(product, grouped)}
<footer>Snapshot from metis, ${esc(date)}. Read-only; it does not update.</footer>
</main>
</body>
</html>
`;
}

/** Build the snapshot and download it; returns the file name. */
export function downloadSnapshot(input) {
  const filename = `${slugify(input.product.name) || "product"}-snapshot.html`;
  const url = URL.createObjectURL(new Blob([snapshotHtml(input)], { type: "text/html" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return filename;
}
