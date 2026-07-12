# metis

Metis turns org intent into scoped, executable work through one AI-assisted pipeline:

```
OrgGoal → ProductGoal → Spec → Capability map + Feature graph → PRD → Tickets
```

The terminal artifact — a **Ticket** — is sized to fit one Claude session: known context,
clear inputs, a verifiable done condition. Named for the Titan of practical wisdom.
The intelligence before the build.

The taxonomy has two planes plus a why layer (full spec in `docs/`):
**capabilities** are durable nouns that mature and never ship; **features** are verb
phrases that `REALIZES` exactly one capability and do ship; **goals** motivate
capabilities, never features directly. PRDs are versioned *snapshots* of the taxonomy —
epics pin a capability, stories pin a feature — never a second hierarchy.

## Quick start

```sh
cp .env.example .env      # optional: add LLM provider keys
docker compose up --build
```

- Web: http://localhost:4321
- API: http://localhost:8000 (OpenAPI docs at /docs)

First boot seeds demo data (goals, the capability map, the PM-Export spec, a
12-ticket PRD, the feature graph) so every screen renders with real content. Set
`SEED_DEMO_DATA=false` to skip. The schema is `create_all` on boot — after pulling a
schema change, reset the dev volume (`docker compose down -v`).

The app runs with zero LLM keys — chat replies with a clear "provider not configured"
notice, and everything else works. Add any subset of provider credentials to `.env`
and pick provider + model per agent in **LLM Config**.

### Claude Code skills

The repo ships a two-skill pipeline for seeding an instance from real codebases
(seed file format: `skills/metis-export/references/seed-format.md`):

- `.claude/skills/metis-seed-instance` loads a `metis-seed.json` into the running
  instance via the API — idempotent, add-only. Auto-available in this repo.
- `skills/metis-export` analyzes *any* repository and writes a `metis-seed.json`.
  To use it from other repos, symlink it into your global skills once per machine:

  ```sh
  ./scripts/install-skills.sh
  ```

## Architecture

Two services plus Postgres:

| Service | Stack | Role |
|---|---|---|
| `frontend/` | Astro 5 (SSR, node adapter) + React islands | UI, built on the Metis design system. Proxies `/api/*` to the backend (same-origin, streams SSE through). |
| `backend/` | FastAPI + SQLAlchemy 2.0 async | Domain API, agents, and the in-memory feature graph. |
| `postgres` | PostgreSQL 16 | System of record (JSONB PRD versions, ticket file arrays). |

### The two planes

The **capability map** (slow plane) is a relational forest: `capabilities.parent_id`
is `PART_OF`, single parent, cycle-guarded. Capabilities carry stored `maturity`
(planned → alpha → beta → ga → deprecated → retired), facets, and evidence anchors;
their progress is never stored — it is always the rollup over realizing features
(`GET /api/capabilities/{id}/rollup`).

The **feature graph** (fast plane) holds features and their typed edges
(`DEPENDS_ON`, `BLOCKS`, `RELATES_TO`) in Postgres, mirrored into an in-memory
networkx graph at startup. Every write commits to Postgres first, then write-through
updates the graph. The *precedence graph* (`DEPENDS_ON ∪ reverse(BLOCKS)`) drives
impact queries ("what breaks if this changes"), dependencies-first build order, the
ready-work frontier (`/api/graph/ready`), and cycle detection — edge writes that
would close a cycle are rejected at write time. `RELATES_TO` is annotation only.

The bridge between planes is `features.capability_id` (`REALIZES`, exactly one,
`NOT NULL`). Cross-plane queries: `GET /api/capabilities/{id}/impact` projects
feature dependencies onto capabilities, `GET /api/features/{id}/why` prints a
feature's provenance chain up to org intent, and `GET /api/capabilities/health`
reports taxonomy findings (aspirational gaps, unmotivated capabilities, empty intent).

Because the graph lives in process memory, the backend runs **exactly one uvicorn
worker** (encoded in the Dockerfile).

### Agents

Chat routes each message through an orchestrator (keyword table first, LLM one-shot
second) to a specialist:

| Agent | Role |
|---|---|
| `spec_decomposer` | ProductGoal → Spec → PRD (Epics → Stories → Tickets, pinned to the taxonomy); enforces ticket sizing |
| `feature_manager` | Capability map + feature CRUD, `REALIZES`/`MOTIVATES` links, typed edges, duplicate-avoiding search; applies the noun/verb filing tests |
| `graph_agent` | Impact queries, build order, ready frontier, cycles, capability rollups, provenance chains, taxonomy health |
| `strategist` | RICE/MoSCoW priorities, versioned delivery strategies |

Agents call the same service functions as the REST API (one write path), stream over
SSE, and attach `ticket_card` viz blocks that render inline in the thread.

**Ticket sizing rule:** `context_budget` is S (single file), M (2–4 files), or
L (cross-cutting). A PRD cannot be approved while any ticket is L — split first.

### LLM providers

Anthropic API, OpenAI, OpenRouter, AWS Bedrock (Claude), and Ollama (local) sit behind
one streaming protocol. Availability is detected from credentials in the environment
(Ollama via a live reachability probe); per-agent provider + model selection is
DB-backed and editable in the LLM Config panel.

## Configuration

All optional — see `.env.example`:

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API |
| `OPENAI_API_KEY` | OpenAI |
| `OPENROUTER_API_KEY` | OpenRouter |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_REGION` | Bedrock (Claude models) |
| `OLLAMA_BASE_URL` | Ollama; compose default reaches host Ollama at `host.docker.internal:11434` |
| `SEED_DEMO_DATA` | Seed demo data on first boot (default `true`) |
| `ANTHROPIC_MODELS` etc. | Override the model dropdowns (comma-separated) |

## Development

```sh
# database
docker compose up -d postgres

# backend (Python 3.11+)
cd backend
python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
.venv/bin/uvicorn app.main:app --reload --port 8000

# tests (uses a metis_test database on the compose postgres)
.venv/bin/python -m pytest

# frontend
cd frontend
npm install
npm run dev            # http://localhost:4321, proxies to localhost:8000
```

## Design system

The UI implements the Metis design system: warm paper neutrals with one Aegean-blue
accent, Space Grotesk + IBM Plex Mono, hairline-first cards, pipeline-stage hues, a
1–5 priority ramp, and S/M/L budget colors. Design tokens are in
`frontend/src/styles/tokens/`; components in `frontend/src/ds/`. System state renders
verbatim in mono (`in_progress`, `DEPENDS_ON`) — never prettified.

## Repository layout

```
backend/    FastAPI app: models, routers, services (graph, PRD flow, seed), llm/, agents/
frontend/   Astro app: pages, islands, design system (ds/), same-origin API proxy
docker-compose.yml
```
