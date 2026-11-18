import { Marked } from "marked";

// Agent replies are model output that may echo anything a user or tool fed
// it, so this renderer never passes HTML through: raw HTML is shown as text,
// and links keep only http(s), mailto and same-site targets.

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const SAFE_HREF = /^(https?:|mailto:|\/(?!\/)|#)/i;

const md = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    html({ text }) {
      return escapeHtml(text);
    },
    link({ href, title, tokens }) {
      const label = this.parser.parseInline(tokens);
      if (!href || !SAFE_HREF.test(href.trim())) return label;
      const external = /^https?:/i.test(href);
      return `<a href="${escapeHtml(href)}"${title ? ` title="${escapeHtml(title)}"` : ""}${external ? ' target="_blank" rel="noopener noreferrer"' : ""}>${label}</a>`;
    },
    image({ text }) {
      return escapeHtml(text ?? "");
    },
  },
});

export function renderChatMarkdown(text) {
  return md.parse(text ?? "");
}
