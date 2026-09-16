# Pinboard MCP Server

A remote MCP server that lets Claude (Claude.ai, Cowork, Claude Desktop, Claude Code)
manage tasks on your Pinboard directly — add tasks, add sub-tasks, move
things between columns, and list what's there.

It's purpose-built for this board only: seven tools (`list_boards`,
`list_tasks`, `add_task`, `add_subtask`, `update_task`, `move_task`,
`delete_task`) that mirror what the web UI does, instead of exposing a general-purpose
Supabase/SQL connector with much broader access. Changes show up live in the
board via its realtime sync.

## Boards

The connector acts as one Pinboard account, set by `MCP_USER_EMAIL`, and can
only reach boards that account is a member of. `list_boards` shows them, with
each board's areas; `list_tasks` and `add_task` take an optional `board` (name
or id) and default to your personal board — the oldest board you own.

Areas belong to each board, so tools take an area by **name** and check it
against that board. `move_task` moves a top-level task and its sub-tasks to
another board, keeping the area if the destination has one with the same name.
Sub-tasks always share their parent's board and area.

## How access is enforced

The server reads and writes with a Supabase **secret key**, which bypasses
row-level security. So the database is not what keeps it inside your boards —
the code is. Every tool first resolves `MCP_USER_EMAIL` to an account and its
board memberships (`loadScope()` in `src/index.ts`), then filters every query
by those board ids, including on the write itself. A task id that isn't on
your boards gets the same "not found" as one that doesn't exist.

Anyone changing the tools needs to keep that property: never query `tasks`
without a `board_id` filter drawn from `loadScope()`.

## Auth

The server is a real OAuth 2.1 authorization server (via
[`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider)),
because Claude.ai's custom-connector UI didn't offer a plain API-key/header
option when this was built. Connecting asks Claude.ai to register itself as a
client (Dynamic Client Registration), redirects you to a password screen
served by this Worker, and — once you enter the password — issues Claude a
proper OAuth access token (with refresh) scoped only to this server.

The `OWNER_PASSWORD` secret is that password. It's the only thing standing
between anyone who finds this server's URL and your task data, so treat it
like any other password.

## First-time setup

```bash
cd mcp-server
npm install
npx wrangler login                      # authorizes the CLI against your Cloudflare account

npx wrangler kv namespace create OAUTH_KV
# copy the printed "id" into wrangler.jsonc, replacing REPLACE_WITH_KV_NAMESPACE_ID

npx wrangler secret put OWNER_PASSWORD       # password on the /authorize screen
npx wrangler secret put SUPABASE_SECRET_KEY  # Supabase → Settings → API Keys → secret key (sb_secret_…)
npx wrangler secret put MCP_USER_EMAIL       # the Pinboard account this connector acts as
npx wrangler deploy
```

`wrangler deploy` prints the live URL, something like:

```
https://kanban-mcp.<your-subdomain>.workers.dev
```

The MCP endpoint is that URL plus `/mcp`; the OAuth endpoints (`/authorize`,
`/oauth/token`, `/oauth/register`, and the `/.well-known/...` discovery
documents) all live on the same origin and don't need separate configuration.

## Local testing

Copy `.dev.vars.example` to `.dev.vars` and fill in all three values, then:

```bash
npx wrangler dev
```

This serves the same code at `http://localhost:8787` — `wrangler dev` runs a
local, disk-backed KV store automatically, so the placeholder KV id in
`wrangler.jsonc` is fine for local testing; you only need the real KV
namespace once you deploy. The full OAuth flow (DCR → `/authorize` → password
→ code → token exchange → authenticated tool call) can be driven with curl
this way before connecting Claude.ai for real.

## Connecting it to Claude.ai / Cowork

1. In Claude.ai, go to **Settings → Connectors → Add custom connector**.
2. Name: `Pinboard` (or anything you like).
3. URL: `https://kanban-mcp.<your-subdomain>.workers.dev/mcp`
4. Claude.ai will discover that this is an OAuth-protected server automatically
   (via the `/.well-known/oauth-protected-resource` and
   `/.well-known/oauth-authorization-server` documents) and register itself as
   a client. No manual client ID/secret entry needed.
5. It'll open the `/authorize` page in a browser tab — enter `OWNER_PASSWORD`
   there. On success you're redirected back to Claude.ai with the connector
   active.
6. Try asking Claude to list or add a task.

## Changing the tools

Tools are registered in `src/index.ts` inside `createServer()`. Each one is a
`server.registerTool(name, { title, description, inputSchema }, handler)`
call — the `zod` schema doubles as the tool's parameter validation and the
description the calling model sees. Area and status values are validated
against the same fixed lists (`AREAS`, `STATUSES`) as `index.html`, so a
mismatch here would mean the two are out of sync — update both together if
you ever add a new area or column.

## Changing the login page

`loginPage()` in `src/index.ts` renders the `/authorize` screen. It's a
single password field in the same Chart Room styling as the board — nothing
fancy, since it's shown once per Claude.ai connection (tokens refresh
automatically after that).
