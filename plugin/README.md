# metis plugin for Claude Code

Use your metis capability inventory from a coding session in any repo. Metis
knows which of your products have which capabilities, so an agent can check for
reuse before it builds something you already have.

Everything here only reads from metis. Writes stay a human action on the metis
desktop.

## What it gives you

- **MCP server `metis`.** The read-only metis MCP server over SSE: 16 tools,
  such as `check_idea`, `capability`, `capability_inventory`, `products` and
  `ready_features`. Every answer is plain text. See [docs/mcp.md](../docs/mcp.md)
  for the full tool list.
- **Skills.**
  - `metis-check-idea`: before building something new, check which of its
    capabilities already exist and in which products.
  - `metis-find-reuse`: find another product that already has a capability,
    and point at its recorded evidence paths.
  - `metis-what-next`: propose 2 to 4 ideas built mostly from capabilities
    that already exist, each checked with `check_idea`, ranked by how much
    already exists, with a link that opens Home's idea check filled in. It
    saves nothing: saving an idea is the owner's choice on the desktop.
- **Hooks.** Each one is silent when metis is unreachable or the repo is not a
  known product:
  - *Session start:* a short brief on this repo's product. It gives the
    feature count and the capabilities it shares with other products.
  - *Prompt submit:* if your prompt names a capability another product already
    has, Claude gets one line saying where.
  - *Stop:* if the session changed code in a known product, you see a
    one-line reminder to re-export the seed file with the `metis-export` skill.
    It appears at most once per session.

## Install

Tested on Claude Code 2.1.329. You need `python3` (3.9 or later) on your PATH.
The hooks use the standard library only.

The metis repo is also a plugin marketplace (`.claude-plugin/marketplace.json`
at its root). In Claude Code:

```
/plugin marketplace add /path/to/metis
/plugin install metis@metis
```

You can also use a git URL or `owner/repo` instead of the local path. To try it
for one session without installing:

```sh
claude --plugin-dir /path/to/metis/plugin
```

After installing, run `/mcp` to check that `plugin:metis:metis` shows as
connected.

## Start the MCP service

The plugin connects to the metis MCP server's SSE endpoint. Start it with the
rest of the stack from the metis checkout:

```sh
docker compose --profile mcp up -d mcp
```

The service needs a token, and there is no default: without one it refuses to
start. Generate one into metis's `.env` once:

```sh
echo "METIS_MCP_SSE_TOKEN=$(openssl rand -hex 32)" >> .env
```

Then give Claude Code the same value as `METIS_MCP_TOKEN`, for example in your
shell profile, or under `env` in `~/.claude/settings.json`:

```sh
export METIS_MCP_TOKEN=<the same value>
```

Compose publishes the service on `127.0.0.1:8001` only. Callers must send
`Authorization: Bearer <token>`, and a request without it gets a 401. The
server also answers only requests whose Host header is `localhost`,
`127.0.0.1` or `mcp`, so a web page cannot reach it by rebinding its own DNS
name to your machine. Without `METIS_MCP_TOKEN`, the plugin's MCP server shows
as failed in `/mcp`; the hooks and skills' instructions still load.

The hooks do not need the MCP service. They read the REST API directly.

## Environment variables

Set these in the shell that starts Claude Code, or under `env` in your Claude
Code settings.

| Variable | Default | Used by | Meaning |
|---|---|---|---|
| `METIS_MCP_URL` | `http://localhost:8001/sse` | MCP | The SSE endpoint |
| `METIS_MCP_TOKEN` | none, required | MCP | Must equal the server's `METIS_MCP_SSE_TOKEN` |
| `METIS_API_URL` | `http://localhost:8000` | hooks | The metis REST API |
| `METIS_API_TOKEN` | unset | hooks | A bearer token for the API, when auth is on |
| `METIS_API_CLIENT_SECRET` | unset | hooks | Instead of a fixed token: a Keycloak client secret the hooks trade for a token, which they cache until it expires |
| `METIS_API_CLIENT_ID` | `metis-mcp` | hooks | The Keycloak client for that exchange |
| `METIS_KEYCLOAK_URL` | `http://localhost:8080` | hooks | Where the token request goes |
| `METIS_KEYCLOAK_REALM` | `metis` | hooks | |

### When the API has auth on

The local stack runs with `AUTH_ENABLED=false`, and the hooks need no token.
With auth on, the API wants a bearer token. The simplest one is the `metis-mcp`
service account. Its role is `viewer`, so it can read everything and write
nothing. Its secret is `METIS_MCP_CLIENT_SECRET` in metis's `.env`; it defaults
to `dev-mcp-secret`, as in `keycloak/metis-realm.json`.

Keycloak tokens in the `metis` realm last 5 minutes, so a fixed
`METIS_API_TOKEN` goes stale quickly. Set the secret instead, and the hooks
fetch and cache a token themselves:

```sh
export METIS_API_CLIENT_SECRET=dev-mcp-secret
```

To get a token by hand, for example for `METIS_API_TOKEN`:

```sh
curl -s -d grant_type=client_credentials -d client_id=metis-mcp \
  -d client_secret=dev-mcp-secret \
  http://localhost:8080/realms/metis/protocol/openid-connect/token | jq -r .access_token
```

## How the hooks decide the product

There is no fuzzy matching. A repo is a known product only when one of these
matches exactly:

1. **The seed file.** `metis-seed.json` at the repo root lists a product, not
   marked `external`, whose `name` equals one metis product's name. That is
   the same name identity the seed loader uses. It must match exactly one
   product.
2. **The repo name.** The git repo's directory name, slugified the way metis
   slugifies (lowercase, every run of other characters becomes `-`), equals a
   product's slug. In a git worktree, the main checkout's directory name is
   used.

If neither matches, every hook stays silent, including the prompt nudge. Reuse
counts only our own products. External products are not reuse, since there is
no code of ours to look at.

The Stop reminder looks at `git status`. It fires when anything other than a
`metis-seed*.json` file has changed, including untracked files.

## Caching and state

The product list and the capability inventory are cached for 10 minutes, so a
prompt costs at most one API call. State lives in `${CLAUDE_PLUGIN_DATA}`, or in
`~/.cache/metis-claude-plugin` (created `0700`) when that is unset. It holds the
cache, the API token, and one marker file per session the Stop reminder has
fired for. If that directory is a symlink, is not yours, or is group or world
writable, the hooks cache nothing and the Stop reminder stays off. Files are
written fresh and renamed into place, and never read through a symlink.

Every API call times out after 3 seconds, and any error means no output and
exit 0. Nothing remembers a failure, so if the API host hangs rather than
refusing, each prompt waits up to that timeout.

## Files

```
plugin/
  .claude-plugin/plugin.json    manifest
  .mcp.json                     the metis SSE server
  hooks/hooks.json              SessionStart, UserPromptSubmit, Stop
  hooks/metis_hooks.py          all three hooks, Python stdlib only
  skills/                       metis-check-idea, metis-find-reuse, metis-what-next
```
