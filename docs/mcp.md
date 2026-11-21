# Connecting an agent over MCP

Metis runs a read-only MCP server. An agent can use it to answer the portfolio
question, *what could we build next, given what already exists?*, and to check
the technology catalog while it builds. The server calls the same HTTP API the
desktop calls, using a token issued to `metis-mcp`. The backend works out the
surface from that token, so every write over MCP comes back as `403
human_action_required` with the screen that can make the change. Writes are a
human action on the desktop.

**From Claude Code, use the plugin.** [`plugin/`](../plugin/README.md) wires
this server into any repo over SSE, adds eight skills (`metis-check-idea`,
`metis-find-reuse` and `metis-what-next` use this server), and adds read-only
hooks that brief each session on its product. The rest of this page is for
other clients and for wiring it by hand.

Tools return plain text, not JSON. Each answer leads with its numbers, keeps raw
values (`in_progress`, `ga`, slugs, ids) verbatim, and ends with an
`Open: <path>` line naming the desktop screen.

Errors come back with `isError` set, as one plain sentence and the same
`Open:` line. An API refusal keeps its status and the API's own words (reading
`metis://tech/postgresql` when no such technology is recorded gives
`Refused (404): Technology not found`); a write refusal opens the screen that
can make the change. An argument that can't be what it claims is refused before any
request, saying what to pass and which tool lists valid ones. A setup problem
says which service it can't reach or sign in to (the metis API or Keycloak) and
the setting that points at it, and so does a base URL that answers but isn't
the metis API. An unknown tool, arguments a tool's schema refuses, and a
resource that can't be read come back the same way. A subject that doesn't exist under an exact name
is an answer, not an error: `0 features are named '…'`, with the features listed
when several share the name. When none has it, up to three near names follow as
unconfirmed candidates, each leading with what the next call takes, as
`capability` and `check_idea` offer them (trigram closeness over 0.6, and the
names share more than one word or every word of one is near in the other, so
"Auth" offers User Authentication but "Sprint Planning" doesn't offer Route
Planning; case is ignored, so a case-only difference is always offered):

```
0 products have id or slug 'Plausible Analytics'. Call `products` for ids and slugs.
Near names, unconfirmed: plausible-analytics "Plausible Analytics"
Open: /products
```

A feature candidate reads `<id> "<name>" (<product slug>)`, a journey one
`<id> "<name>"`. A candidate is never picked: pass its slug or id to use it.

Inputs follow one rule: a product by id or slug, a capability by slug or name
(a name matches through its slug, as in `check_idea`), and a feature or a
journey by id or exact name.

## Tools

The inventory tools answer the portfolio questions:

| Tool | What it answers | API |
|---|---|---|
| `products` | Every product, ours and external, with slug and id. Start here so you never guess an id. Given a product id or slug, it lists that product's features instead (name, raw status, id), so `feature_why` and `recheck` never need a guessed name. | `GET /api/products` (`?near=<name>` gives the near names a miss offers; features and journeys take it too), and `GET /api/features` for one product |
| `capability_inventory` | What we can already do, most reused first: each capability's slug and exact name (a seed file reuses a capability by its name), its maturity when ours, and our products and features working on it at any status (a feature linked only to a sub-capability counts, and the row says how many do). Takes an optional `q` substring filter, applied in the server, and a `limit`. | `GET /api/capabilities/inventory` |
| `check_idea` | How much of an idea we already have. Each need comes back `ours`, `only elsewhere` (not ours; an external product has it), `not built yet` (named, but no finished feature realizes it), or `no match` with near names listed as unconfirmed candidates. A capability is ours when a finished (`done`) feature of one of our products realizes it. Takes an optional `idea` name. Its `Open:` line pre-fills Home's idea check (`/home?idea=<name>&caps=<slug>,<slug>,...`: matched needs by slug, the rest as typed) and runs it, so the owner can save it as an idea with one click. The tool itself saves nothing. An idea holds at most 100 features and 300 capability names in all, a capability name at most 100 characters and a feature name at most 300 (the biggest real product has 52 features naming 110). Over a limit is refused with the limit named, by the tool's schema or by the API's `422`. The request body is also capped at 64,000 bytes, refused with `413 Request body is over 64000 bytes.` before any limit is checked. Every limit used at once comes to 63,814 bytes as compact ASCII JSON (what this server sends), so accented letters (two bytes each in UTF-8) or spaced JSON (64,414 bytes) cross the byte cap first. | `POST /api/capabilities/coverage` (a read) |
| `product_score` | How much of an external product, by id or slug, we could build: buildable, partly known, not described, missing a capability. It is a lower bound. Our own products are not scored, as on the desktop: their own features are what make their capabilities ours, so the score would measure itself. | `GET /api/products/{id}/coverage` |
| `capability` | One capability by slug or name: our features and products, external products listed apart, the goals that motivate it directly, its rollup, and the evidence paths an export recorded. | inventory, then `GET /api/capabilities/{id}/scope`, `/motivations`, `/rollup` |
| `feature_why` | Why a feature exists, by id or exact name: its capabilities, their parents, and the goals that motivate them. The goals of the feature's own product come first (a goal is its own when the goals API's `product_id` names that product: the product's goal and the tree around it, short of another product's goal, as on the desktop; someone else's product owns none); goals of other products, reached through a shared capability, are listed apart with their products. Each goal says which capability it motivates or which goal it is the parent of. | `GET /api/features/{id}/why`, plus `/api/features/{id}`, `/api/goals`, `/api/motivations`, `/api/products` |
| `journeys` | Lists journeys. Given a journey id or exact name, it returns each step's verdict (`buildable`, `known_covered`, `missing`, `unknown`) and whether a user can do the step today. | `GET /api/journeys`, `GET /api/journeys/{id}/analysis` |
| `ready_features` | Our pending features whose dependencies are all done. Optionally limited to one of our products; an external one is declined, since its features are never our work. When nothing is ready it says whether anything is pending at all and points to `check_idea`. | `GET /api/graph/ready`, and `GET /api/features` when nothing is ready |
| `recheck` | If a feature changes, what else to recheck. Takes a feature id or its exact name (a name several features share is listed, not picked). Breaks: features that depend on it, through links of links. Retest (same product): features sharing a confirmed capability, rarest shared capability first. Broad (many features): capabilities used by more than half of the product (and at least 6 features), counted rather than listed. Same capability elsewhere (info only): our other products with the same capabilities; metis does not know whether they share code. Guesses are never counted. | `GET /api/graph/recheck/{id}` |

The technology and buy tools stay hidden on the desktop until there is data for
them, but this server always lists them: a client lists tools once, when it
connects, and the server can't tell it the catalog filled (`listChanged` is
false). With no technology recorded, each says so and how one gets recorded:

| Tool | What it answers |
|---|---|
| `tech_search` | Searches the technology catalog. It returns the slugs the other technology tools take. |
| `capability_supply` | What can answer a capability, with fit, stance and ops cost, plus our features that realize it at any status (the done ones are counted); external products' features are listed apart and never counted as ours. Finds a capability as `capability` does, so an unknown one comes back with its near names. |
| `tech_blast_radius` | Which products use a technology: in a stack slot, `required` or `optional`; `off_stack` when the product's stack never declared it; "uses it" when the product has no stack. |
| `tech_exposure` | What is dying and whether it matters: expiring release lines, stances being abandoned, a bus factor of one. |
| `stack_redundancy` | Capabilities a product answers more than once. They are reported, never resolved. |
| `tech_encounters` | Who here has touched a technology, deepest and most recent first. |
| `stack_recommend` | Ranked bindings for a product's stack, the offers pruned and why, and slots left unresolved. |
| `propose_binding` | Writes nothing. It checks the slot's offers and returns a proposal with a desktop link. |

Resources: `metis://ontology/model`, `metis://policy/adoptions`,
`metis://tech/{slug}`, `metis://stacks/{product}`. Prompts:
`check_this_dependency`, `choose_a_stack`, `explain_the_ontology`.

Capability names match exactly, by slug; products by id or slug; features and
journeys by id or exact name. A near name is a candidate for a human to confirm and is
never counted as a match. An empty answer or a gap is a real answer.

## Auth: two tokens

1. **MCP server → API.** The server gets a token from Keycloak with the client
   credentials grant, as the `metis-mcp` client. That client's service account
   has the `viewer` role in the `metis` realm, and the token is cached until a
   minute before it expires. The backend reads the signed `azp`, gets
   `Surface.mcp`, and refuses every write. `check_idea` posts to
   `/api/capabilities/coverage`, which is a read that takes a body. That exact
   path is on the backend's read-by-POST list (`_READS_BY_POST` in
   `backend/app/auth/deps.py`). When `AUTH_ENABLED=false`, no token is fetched.

   **When the backend runs with `AUTH_ENABLED=false`, the surface check is off.**
   Every request, MCP included, is treated as the dev desktop admin, so the
   backend would accept a write. MCP stays read-only in that mode only because
   the server has no tool that writes. Keep backend auth on wherever the MCP
   server is exposed to anything but your own agent.
2. **Agent → MCP server.** This token applies to SSE only. A listening port
   would otherwise lend the server's API token to anyone who can reach it, so
   the server refuses to start SSE without `METIS_MCP_SSE_TOKEN`. Callers send
   `Authorization: Bearer <METIS_MCP_SSE_TOKEN>`. stdio needs no token, because the
   process inherits the identity of whoever launched it.

| Variable | Default | Meaning |
|---|---|---|
| `MCP_API_BASE_URL` | `http://localhost:8000` | The backend the server calls |
| `AUTH_ENABLED` | `true` | `false` skips Keycloak. Use it only against a backend that also has auth off |
| `KEYCLOAK_INTERNAL_URL` | `http://localhost:8080` | Where the token request goes |
| `KEYCLOAK_REALM` | `metis` | |
| `KEYCLOAK_MCP_CLIENT` | `metis-mcp` | |
| `METIS_MCP_CLIENT_SECRET` | `dev-mcp-secret` | Matches `keycloak/metis-realm.json`. Change it anywhere real. The older name `KEYCLOAK_MCP_CLIENT_SECRET` is still read when this one isn't set |
| `METIS_MCP_SSE_TOKEN` | empty | Required for `--sse`. The older name `MCP_SSE_TOKEN` is still read when this one is empty |

## stdio (local agents)

Use stdio when the agent runs on the same machine as the stack. It runs from
source, using the backend's Python environment:

```sh
cd backend
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python -m app.mcp            # speaks MCP on stdin/stdout
```

To add it to Claude Code, use absolute paths so the agent can launch it from
any directory:

```sh
claude mcp add metis \
  -e PYTHONPATH=/path/to/metis/backend \
  -e MCP_API_BASE_URL=http://localhost:8000 \
  -- /path/to/metis/backend/.venv/bin/python -m app.mcp
```

Or check this into the project as `.mcp.json`:

```json
{
  "mcpServers": {
    "metis": {
      "type": "stdio",
      "command": "/path/to/metis/backend/.venv/bin/python",
      "args": ["-m", "app.mcp"],
      "env": {
        "PYTHONPATH": "/path/to/metis/backend",
        "MCP_API_BASE_URL": "http://localhost:8000"
      }
    }
  }
}
```

With the default `AUTH_ENABLED=true`, the server needs Keycloak at
`KEYCLOAK_INTERNAL_URL`. `docker compose up` publishes it on `localhost:8080`.

Settings come from the environment and from a `.env` file in the process's
working directory. Claude Code starts stdio servers in the project directory,
so when the project is the metis checkout, the root `.env` applies. For
example, its `AUTH_ENABLED=false` overrides the defaults above. Set anything
that must not change in `env` explicitly.

## SSE (compose profile `mcp`)

```sh
# .env: set a real token, and a real client secret anywhere that isn't a laptop
METIS_MCP_SSE_TOKEN=<long random string>
METIS_MCP_CLIENT_SECRET=<metis-mcp secret>

docker compose --profile mcp up -d --build
```

`--build` rebuilds the image from this checkout; without it, compose serves
whatever image it built last.

The `mcp` service is built from the backend image and runs
`python -m app.mcp --sse --port 8001`. It reaches the backend at
`http://backend:8000` and Keycloak at `http://keycloak:8080`. The SSE endpoint
is `/sse`, and messages go to `/messages/`.

Compose publishes port 8001 on `127.0.0.1` only, so agents on the same
machine can reach it and nothing else can. `METIS_MCP_SSE_TOKEN` has no
default, and the service refuses to start without it. Generate one with
`openssl rand -hex 32`. The server also refuses any Host header other than
`localhost`, `127.0.0.1` and `mcp` (400), so a browser page cannot reach the
port through DNS rebinding.

The [plugin](../plugin/README.md) connects to it with no further setup. To add
it to Claude Code by hand instead:

```sh
claude mcp add --transport sse metis http://localhost:8001/sse \
  --header "Authorization: Bearer $METIS_MCP_SSE_TOKEN"
```

Or in `.mcp.json`:

```json
{
  "mcpServers": {
    "metis": {
      "type": "sse",
      "url": "http://localhost:8001/sse",
      "headers": { "Authorization": "Bearer ${METIS_MCP_SSE_TOKEN}" }
    }
  }
}
```

`.mcp.json` is usually committed, so it refers to the token as
`${METIS_MCP_SSE_TOKEN}`, which Claude Code expands from the environment, and
never contains the token itself. `claude mcp add` with the double-quoted
header above writes the expanded token into your local config instead.

A request without the bearer token gets
`401 {"error": "unauthorized", "message": "MCP requires a bearer token."}`.
