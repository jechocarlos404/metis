---
register: product
---

# Metis — product context

## Product purpose

Metis is a capability inventory shared across products. Every product's
user-facing features are mapped to the capabilities built to implement them,
and capabilities are shared by exact name across products, so the question
*"what could we build next, given what already exists?"* has a computed answer.

## Users (confirmed 2026-11-19)

1. **Portfolio owner — primary human.** Runs several products of their own,
   tracks a few outside products (competitors, references), and keeps asking
   what to build next from what already exists. Knows their products deeply;
   does not know, and should not need to know, metis's internal vocabulary.
   Main jobs: check an idea against the inventory, score a product (ours or
   someone else's), keep the map accurate, share a product's picture.
2. **AI agent — primary non-human.** Coding agents that describe a repo as a
   seed file, and agents that answer portfolio questions over MCP. Reads raw
   values (`in_progress`, `DEPENDS_ON`) and exact slugs; never writes through
   MCP (the write boundary: writes are a human action on the desktop).
3. **Viewer** — someone the owner shares with. Read-only; every screen must
   make sense without the buttons they don't have.
4. **Admin** — sets up accounts and AI models. Usually the owner.

Secondary jobs, on demand only: delivery planning (spec → PRD → tickets →
strategy) and the technology/buy plane (tech catalog, exposure, stacks). Both
are hidden until someone asks for them or data exists.

## Principles

- **Honest numbers.** Capability names match exactly; near names are offered,
  never assumed. Coverage is a lower bound. A gap is an answer. Never add fuzzy
  auto-matching to reduce friction — offer exact picks instead.
- **Only real data.** No demo or sample rows. The one exception is a guess:
  when nothing can confirm a link (no access to the feature, its code, its
  users or a public page that shows it), a seed file may say a feature or
  technology is likely, possibly or on a hunch built on a capability, with a
  one-line basis. Guesses are stored apart from facts, count nowhere, and only
  editors and admins see them until one confirms or rejects each.
- **Plain words on screen, raw values underneath.** Humans see "needs",
  "stable", "planned"; the raw value (`DEPENDS_ON`, `ga`, `pending`) is one
  hover away (`title`) and stays verbatim in Chat tool output, MCP and logs.
  Vocabulary lives in `frontend/src/lib/words.js` — one word per concept,
  everywhere.
- **Jobs, not tables.** Navigation is grouped by what the owner is trying to
  do. A screen does one job; analysis that spans the whole graph lives in its
  own view, not in a per-item side panel.
- **Empty states teach and point.** Every empty state says what will appear,
  and links to the real next step — or says who can take it, for viewers.
- **Progressive disclosure over modals.** Inline first; a dialog only for a
  short focused form.

## Tone

Plain, declarative, specific. Numbers lead. No exclamation points, no emoji, no
design rationale printed in the UI (that belongs in docs).

## Anti-references

Admin-panel CRUD grids as the main surface; dashboards of vanity numbers;
tools that make you learn their ontology before they answer a question.
