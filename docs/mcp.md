# Connecting an agent over MCP

Metis runs a read-only MCP server. An agent can use it to answer the portfolio
question, *what could we build next, given what already exists?*, and to check
the technology catalog while it builds. The server calls the same HTTP API the
desktop calls, using a token issued to `metis-mcp`. The backend works out the
surface from that token, so every write over MCP comes back as `403
human_action_required` with the screen that can make the change. Writes are a
human action on the desktop.

Tools return plain text, not JSON. Each answer leads with its numbers, keeps raw
values (`in_progress`, `ga`, slugs, ids) verbatim, and ends with an
`Open: <path>` line naming the desktop screen.

## Tools

The inventory tools answer the portfolio questions:

| Tool | What it answers | API |
|---|---|---|
| `products` | Every product, ours and external, with slug and id. Start here so you never guess an id. | `GET /api/products` |
| `capability_inventory` | What we can already do, most reused first. Takes an optional `q` substring filter, applied in the server, and a `limit`. | `GET /api/capabilities/inventory` |
| `check_idea` | How much of an idea we already have. Each need comes back `ours`, `external only`, or `no match` with near names listed as unconfirmed candidates. | `POST /api/capabilities/coverage` (a read) |
| `product_score` | How much of a product, by id or slug, we could build: buildable, partly known, not described, missing a capability. It is a lower bound. | `GET /api/products/{id}/coverage` |
| `capability` | One capability by slug: our features and products, external products listed apart, the goals that motivate it directly, and its rollup. | inventory, then `GET /api/capabilities/{id}/scope`, `/motivations`, `/rollup` |
| `feature_why` | Why a feature exists, from its capabilities up through their parents to the goals that motivate them. | `GET /api/features/{id}/why` |
| `journeys` | Lists journeys. Given a journey id, it returns each step's verdict (`buildable`, `known_covered`, `missing`, `unknown`) and whether a user can do the step today. | `GET /api/journeys`, `GET /api/journeys/{id}/analysis` |
| `ready_features` | Our pending features whose dependencies are all done. Optionally limited to one product. | `GET /api/graph/ready` |

The technology and buy tools, which stay hidden on the desktop until there is
data for them:

| Tool | What it answers |
|---|---|
| `tech_search` | Searches the technology catalog. It returns the slugs the other technology tools take. |
| `capability_supply` | What can answer a capability, with fit, stance and ops cost, plus the features that realize it. |
| `tech_blast_radius` | Which products use a technology, and whether each use is required or `off_stack`. |
| `tech_exposure` | What is dying and whether it matters: expiring release lines, stances being abandoned, a bus factor of one. |
| `stack_redundancy` | Capabilities a product answers more than once. They are reported, never resolved. |
| `tech_encounters` | Who here has touched a technology, deepest and most recent first. |
| `stack_recommend` | Ranked bindings for a product's stack, the offers pruned and why, and slots left unresolved. |
| `propose_binding` | Writes nothing. It checks the slot's offers and returns a proposal with a desktop link. |

Resources: `metis://ontology/model`, `metis://policy/adoptions`,
`metis://tech/{slug}`, `metis://stacks/{product}`. Prompts:
`check_this_dependency`, `choose_a_stack`, `explain_the_ontology`.

Capability names match exactly, by slug. A near name is a candidate for a human
to confirm and is never counted as a match. An empty answer or a gap is a real
answer.

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
   the server refuses to start SSE without `MCP_SSE_TOKEN`. Callers send
   `Authorization: Bearer <MCP_SSE_TOKEN>`. stdio needs no token, because the
   process inherits the identity of whoever launched it.

| Variable | Default | Meaning |
|---|---|---|
| `MCP_API_BASE_URL` | `http://localhost:8000` | The backend the server calls |
| `AUTH_ENABLED` | `true` | `false` skips Keycloak. Use it only against a backend that also has auth off |
| `KEYCLOAK_INTERNAL_URL` | `http://localhost:8080` | Where the token request goes |
| `KEYCLOAK_REALM` | `metis` | |
| `KEYCLOAK_MCP_CLIENT` | `metis-mcp` | |
| `KEYCLOAK_MCP_CLIENT_SECRET` | `dev-mcp-secret` | Matches `keycloak/metis-realm.json`. Change it anywhere real |
| `MCP_SSE_TOKEN` | empty | Required for `--sse` |

## stdio (local agents)

Use stdio when the agent runs on the same machine as the stack. It runs from
source, using the backend's Python environment:

```sh
cd backend
python -m venv .venv && .venv/bin/pip install -r requirements.txt
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

docker compose --profile mcp up -d
```

The `mcp` service is built from the backend image and runs
`python -m app.mcp --sse --port 8001`. It reaches the backend at
`http://backend:8000` and Keycloak at `http://keycloak:8080`. The SSE endpoint
is `/sse`, and messages go to `/messages/`.

The service only `expose`s port 8001, so other containers on the compose
network can reach it but the host cannot. To use it from an agent on the host,
publish the port on purpose with a `docker-compose.override.yml`. Compose merges
that file automatically:

```yaml
services:
  mcp:
    ports:
      - "127.0.0.1:8001:8001"
```

Then add it to Claude Code:

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

A request without the bearer token gets `401 {"error": "unauthorized"}`.
