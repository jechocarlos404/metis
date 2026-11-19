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

Legend: todo · doing · done (verified how) · partial · skipped (why)

| Item | Owner | Status | Verified |
|---|---|---|---|
| Foundation: words, Term, coverage, SeedFiles, CapabilityPicker, PRODUCT.md | me | done | astro build |
| Nav: 6 core + 2 optional + Settings + Guide | S1 | todo | |
| Tech / Stacks hidden until data | S1 | todo | |
| Health badges only on failure | S1 | todo | |
| Settings hub (Users, AI models, Data, Seed files) | S1 | todo | |
| A · Home | S2 | todo | |
| B · Get started | S2 | todo | |
| C · Product profile + on-demand Plan | S3 | todo | |
| D · Ideas & journeys | S6 | todo | |
| E · Capability page merged | S5 | todo | |
| F · Features Plan view | S4 | todo | |
| Agent MCP inventory tools | S8 | todo | |
| Fix 1 onCandidate no-op | foundation + S3 | todo | |
| Fix 2 parent pre-fill | S5 | todo | |
| Fix 3 dead-end empty states | S2, S3, S7 | todo | |
| Fix 4 Chat examples | S7 | todo | |
| Fix 5 journeys "pending" | S6 | todo | |
| Fix 6 Features empty copy | S4 | todo | |
| Fix 7 Exposure empty copy | S7 | todo | |
| Fix 8 Goals dialog default | S5 | todo | |
| Fix 9 supply note dismissal | S5 | todo | |
| Fix 10 health badges | S1 | todo | |
| Fix 11 toggle + delete patterns | S6, S7 | todo | |
| Fix 12 Stacks picker (verify first) | S7 | todo | |
| Guide + README rewrite | me | todo | |
| Unverified tech guesses | — | deferred → proposal | |
