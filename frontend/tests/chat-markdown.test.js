import { test } from "node:test";
import assert from "node:assert/strict";
import { renderChatMarkdown } from "../src/lib/chat-markdown.js";

test("a goal or ticket code never breaks at its hyphen (A47)", () => {
  const html = renderChatMarkdown("PG-62 sits under **OG-60**, see [SPEC-001](/products?product=SPEC-001).");
  assert.match(html, /<span style="white-space:nowrap">PG-62<\/span>/);
  assert.match(html, /<strong><span style="white-space:nowrap">OG-60<\/span><\/strong>/);
  // The link target is left alone; only its text is wrapped.
  assert.match(html, /href="\/products\?product=SPEC-001">/);
});

test("raw HTML is still shown as text", () => {
  assert.doesNotMatch(renderChatMarkdown("<b>x</b> OG-60"), /<b>/);
});
