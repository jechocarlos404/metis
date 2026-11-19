# UX overhaul — status

Source: the 2026-11-19 audit (https://claude.ai/artifact/9KUqwoyGTURkswpM5Vi9yV,
private). Branch `feat/ux-overhaul`. Decisions from the owner, 2026-11-19:

- Primary users: **portfolio owner** and **AI agents** (MCP for agents).
- Spec / PRD / tickets / strategy: move under **Plan**, **on demand only**.
- Tech, Exposure, Stacks: **hidden until data exists**. "Possibly" take guesses
  for adjacent parts, marked unverified — deferred to a proposal (conflicts with
  the only-real-data rule and needs a schema + seed-format change).
- Defaults chosen without an explicit answer: plain words on screen with raw
  values on hover; "did you mean" on Products links to the capability; agent
  MCP = new inventory tools on the existing read-only MCP server.

## Canonical links (every stream uses these)

| Entity | Link |
|---|---|
| Capability | `/capabilities/{slug}` |
| Feature | `/features?feature={id}` |
| Product | `/products?product={id}` |
| Journey / idea | `/journeys?id={id}` |
| Goal | `/goals?goal={id}` |
| Technology | `/tech/{slug}` |

## Streams and file ownership

| Stream | Owns | Audit items |
|---|---|---|
| S1 shell | `layouts/AppLayout.astro`, `components/shell/*`, `pages/settings.astro` (new), `pages/users.astro`, `pages/admin.astro`, `pages/data.astro`, `UsersIsland`, `AdminIsland`, `DataIsland`, `pages/index.astro` | cause 1 (nav), nav regroup, Settings, health badges on failure only, Tech/Stacks hidden until data, roles explained, LLM Config dead end, fix P3-10 |
| S2 home | `pages/home.astro` (new), `pages/inventory.astro`, `InventoryIsland` → `HomeIsland`, `GetStartedIsland` (new) | screen A (Home), screen B (Get started), cause 4, journeys 1–2, fix P1-3 (Inventory empty state) |
| S3 products | `ProductsIsland`, `pages/products.astro` | screen C (profile), Plan tab on demand, journeys 3/6/8, fix P1-1 (onCandidate), P1-3 (viewer dead ends) |
| S4 features | `FeaturesIsland`, `components/graph/*`, `pages/features.astro` | screen F (Plan view), cause 2 (Features panel), jargon, fix P2-6 |
| S5 capabilities + goals | `CapabilitiesIsland`, `CapabilitySupplyIsland`, `pages/capabilities*.astro`, `GoalsIsland`, `pages/goals.astro` | screen E (merged capability page), journeys 4–5, fixes P2-2, P2-8, P3-9 |
| S6 journeys | `JourneysIsland`, `pages/journeys.astro` | screen D (Ideas & journeys), cause 3 (verdict words), fix P2-5 |
| S7 chat + tech UI | `ChatIsland`, `components/chat/*`, `pages/chat/*`, `TechCatalogIsland`, `TechDetailIsland`, `StacksIsland`, `lib/ontology.js`, `pages/tech/*`, `pages/stacks.astro` | journey 7, fix P2-4, P2-7, P3-11, P3-12, tech jargon + rationale card |
| S8 MCP | `backend/app/mcp/*`, `backend/tests/test_mcp.py` | agent persona: inventory tools over MCP |
| Integration (me) | `lib/words.js`, `components/shared/*`, `pages/guide.astro`, `pages/ontology.astro`, `README.md`, this file | Guide/README rewrite, vocabulary merge, browser verification |

## Things that move (giver → receiver)

| Thing | From | To |
|---|---|---|
| Seed import / remove / agent prompt | Products (S3 deletes) | Get started (S2) + Settings (S1) via `components/shared/SeedFiles.jsx` |
| Export one product as a seed file | Products seed tools (S3) | Products header "Export" action (S3 keeps, uses `exportSeedFile`) |
| Reused-capabilities table (inventory) | Inventory landing (S2) | Capabilities list, sort "most reused" (S5) + Home portfolio strip summary (S2) |
| "Score an existing product" | Inventory + Products (both) | Home portfolio strip (S2) + product profile (S3) — one wording via `coverage.jsx` |
| Product goals | Goals only | still created on Goals (S5); also shown on product profile (S3) |
| Goal ↔ capability links | Capabilities side panel (S5) | capability page "Why" section (S5) |
| Ready / Cycles / Build order / MVP cut | Features side panel (S4) | Features "Plan" view (S4) |
| PRD / tickets / strategy | Products tabs (S3) | Products "Plan" tab, on demand (S3) |

## Item status

Legend: done (how verified) · partial · deferred. "Browser" = clicked through
on the Docker frontend against `metis_verify`, a copy of the real database.

| Item | Owner | Status | Verified |
|---|---|---|---|
| Foundation: words, Term, coverage, SeedFiles, CapabilityPicker, PRODUCT.md | me | done | build, browser |
| Nav: Home, Chat · Portfolio (Products, Ideas & journeys, Capabilities, Goals) · Build & buy (Features, Technology*, Stacks*) · Settings, Guide | S1 | done | browser (admin + viewer) |
| Tech / Stacks hidden until data | S1 | done | browser: hidden with 0 technologies, 0 stacks |
| Health badges only on failure | S1 | done | browser: hidden while healthy; failure row not exercised |
| Settings hub (seed files, Users, AI models, Raw data) | S1 | done | browser |
| A · Home (idea check, portfolio scores, most reused) | S2 | done | browser: picked, checked, saved an idea |
| B · Get started (empty instance only) | S2 | done | browser on an empty database: admin sees 5 steps, viewer a short note |
| C · Product profile + on-demand Plan | S3 | done | browser (admin + viewer) |
| D · Ideas & journeys | S6 | done | browser: saved idea renders with shared vocabulary |
| E · Capability page merged; list = tree / most reused / needs attention | S5 | done | browser |
| F · Features Plan view | S4 | done | browser: ran the smallest-version cut for one feature |
| Agent MCP: 8 inventory tools (16 total) | S8 | done | 238 backend tests; stdio lists tools, clean exit |
| Fix 1 onCandidate no-op | foundation + S3 | done | code: links when no handler |
| Fix 2 parent pre-fill | S5 | done | browser: New starts top level; Edit pre-fills its real parent |
| Fix 3 dead-end empty states | S2, S3, S7 | done | browser (viewer Plan tab) |
| Fix 4 Chat examples | S7 | done | browser |
| Fix 5 journeys "pending" | S6 | done | browser: steps read "not built" |
| Fix 6 Features empty copy | S4 | done | browser: "No feature matches …"; empty-instance copy by code |
| Fix 7 Exposure empty copy | S7 | done | browser: "No technologies recorded, so nothing to check." |
| Fix 8 Goals dialog default | S5 | done | browser: product goal when org goals exist; org when none (code) |
| Fix 9 supply note dismissal | S5 | done | note removed |
| Fix 10 health badges | S1 | done | browser |
| Fix 11 toggle + delete patterns | S6, S7 | done | browser: journey delete is inline Keep / Delete; Tech uses Tabs |
| Fix 12 Stacks picker | S7 | done | browser: picker and panel name the same product |
| Viewers can run the MVP cut (read-by-POST) | me | done | tests |
| Guide + README | me | done | browser (Guide, on real data) |
| Unverified tech guesses | — | deferred | proposal: docs/proposal-unverified-tech.md |

\* shown only when data exists.

### Against the audit's causes and journeys

| Audit item | Status | Where |
|---|---|---|
| Cause 1 · nav is the ontology | done | grouped by job (S1) |
| Cause 2 · each screen does three jobs | done | Features panel slimmed + Plan tab (S4); Products profile tabs (S3); Capabilities list split from one capability page (S5) |
| Cause 3 · jargon, many words for one idea | done | `lib/words.js` + `<Term>`; one VERDICT/NEED vocabulary. Some labels still defined locally (follow-ups) |
| Cause 4 · no way in | done | Get started on an empty instance; seed tools in Settings |
| Cause 5 · three products share one shell | done | pipeline on demand under a product's Plan tab; Tech/Stacks hidden until data; Build & buy starts collapsed and opens on its own pages (browser) |
| Journey 1 · first run | done | Get started (browser, empty database) |
| Journey 2 · could we build this idea | done | picker + Check + Save as idea (browser, real data) |
| Journey 3 · how much of product X | done | one wording on Home and the product profile |
| Journey 4 · map a product by hand | done | numbered order on a product with no features (WhatItDoes) and in the Guide; code only, no featureless product to open |
| Journey 5 · build or buy | deferred | section hidden until technology data exists; it links each technology to its page, but no screen records which capabilities a technology covers (see the unverified-tech proposal) |
| Journey 6 · plan delivery | done | Plan tab on demand, Approve all in Chat, Features Plan view |
| Journey 7 · Chat | done | examples, readable steps, plain statuses (browser) |
| Journey 8 · read-only viewer | done in UI | browser as viewer; the stack runs with `AUTH_ENABLED=false`, so backend refusals are covered by unit tests, not end to end |


## Second pass (2026-11-20)

| Item | Status | Verified |
|---|---|---|
| Nav presence: one `GET /api/tech/presence` instead of two calls | done | 4 backend tests; endpoint answers on the stack |
| Capability delete warns about sub-capabilities | done | browser: "Its sub-capability will move to the top level." |
| Features with no capability shown under Needs attention | done | code; this data has none to show |
| Product Goals also lists goals behind capabilities its features use (collapsed, with a count) | done | browser |
| Chat: cards with waiting changes stay open; one-helper replies say "Metis" | done | build only; not run, since a chat turn spends AI credits |
| Labels with one copy in `lib/words.js` (chat agents, proposal statuses, stack flags, incoming edges) | done | build + grep; roles.js was already the single copy |

## Open follow-ups

- A shared capability (e.g. User Authentication) pulls every goal behind it onto
  each product's Goals tab. Collapsed for now; a sharper rule needs the owner.
- Single-specialist Chat replies now say "Metis"; nothing on them names which
  specialist answered.
