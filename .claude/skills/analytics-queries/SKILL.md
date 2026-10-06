---
name: analytics-queries
description: Query this app's analytics cubes — answer a data question, build a Cube-style query (measures, dimensions, filters, time dimensions, funnels, retention), call /cubejs-api/v1 from curl or a script with an API key, preview the SQL or explain plan, and connect Claude Code or Claude Desktop to the app's /mcp endpoint so Claude can explore and query the semantic layer directly. Use when someone asks a question of the data ("how many…", "trend of…", "top N…"), wants to query or debug analytics, or wants to hook Claude/an MCP client up to Launch analytics.
argument-hint: "[ask \"<question>\" | build | curl | debug <query> | mcp-claude-code | mcp-claude-desktop]"
---

# Queries — ask the semantic layer, from Claude, a terminal or a script

Every query runs **as a person in one organisation**. Access comes from the app's own sign-in
cookie or an API key, and every cube filters its rows by that organisation's tenant. You never pass
a tenant id, and you never could. Any member may query (`read Analytics`).

## Preconditions

1. The app is running: `pnpm dev` locally (the Worker on `http://localhost:3001`, the UI on `:3000`),
   or a deployed URL (`APP_URL`).
2. **A credential.** An API key acts as the person who created it, in that key's organisation.
   Pick one of these:
   - **A dedicated key (recommended for Claude and scripts).** In the app, go to **Settings → API
     keys** (`/settings/api-keys`) and create a key named after where it will live (for example
     `mcp:claude-desktop`). Keys are created by owners and admins, and the key is **shown once**, so
     copy it then. It sees what its creator sees.
   - **The CLI's key.** `pnpm cli login --server http://localhost:3001` mints `cli:<hostname>` and
     stores it in `~/.launch/config.json` (mode 0600). Don't copy it elsewhere; create a
     dedicated key instead, so each one can be revoked on its own.
   - Never paste a key into a file that gets committed, and never echo a full key in a transcript.
3. The plugin is healthy: the `analytics` skill, **Health** mode.

## The query language (0.8.3)

A query is JSON. Field names are always `CubeName.member`, exactly two parts. Get the real names
from `/meta` or the MCP `discover` tool; never guess them.

```jsonc
{
  "measures":   ["ActivityEvents.count", "ActivityEvents.activeUsers"],
  "dimensions": ["ActivityEvents.type"],               // group by
  "filters":    [{ "member": "ActivityEvents.createdAt", "operator": "inDateRange", "values": ["last 30 days"] }],
  "timeDimensions": [{ "dimension": "ActivityEvents.createdAt", "granularity": "week" }],  // one row per week
  "order": { "ActivityEvents.count": "desc" },
  "limit": 10
}
```

- **Filtering by date is not grouping by date.** This is the most common mistake.
  - "Total events in the last 30 days" needs a `filters` entry with `inDateRange`, and no
    `timeDimensions`.
  - "Events per week" needs `timeDimensions` with a `granularity`, and a `dateRange` on it if you
    want a window.
- **Granularities:** `second`, `minute`, `hour`, `day`, `week`, `month`, `quarter`, `year`.
- **Relative ranges that are always understood:** `'last 7 days'`, `'last 30 days'`, `'last 90 days'`,
  or an ISO pair `["2026-01-01", "2026-03-31"]`. An unrecognised relative string makes drizzle-cube
  drop the condition and query all time, so the dashboards stick to those forms.
- **Filter operators:**
  - comparison: `equals`, `notEquals`, `gt`, `gte`, `lt`, `lte`, `between`, `notBetween`
  - text: `contains`, `notContains`, `startsWith`, `endsWith`, `like`, `ilike`, `regex`
  - sets and nulls: `in`, `notIn`, `set`, `notSet`, `isEmpty`, `isNotEmpty`
  - dates: `inDateRange`, `beforeDate`, `afterDate`
  - arrays: `arrayContains`, `arrayOverlaps`, `arrayContained`

  `values` is always an array, even for one value.
- **AND / OR groups:** `{ "type": "or", "filters": [ …, … ] }`, and groups can nest.
- **Joins are automatic:** ask for `Users.email` next to `ActivityEvents.count` and it joins.
- **Raw rows instead of aggregates:** add `"ungrouped": true`, with dimensions only.
- **Comparing periods:** give the time dimension a `compareDateRange` (a list of ranges).
- **Analysis modes** work on event-stream cubes (`ActivityEvents`):
  - `{ "funnel": { "bindingKey", "timeDimension", "steps": [ … ] } }`: conversion between steps, at
    least 2 steps; `includeTimeMetrics` adds the time between steps.
  - `{ "flow": { … } }`: what came before and after an event.
  - `{ "retention": { "bindingKey", "timeDimension", "dateRange": { "start", "end" }, "granularity" } }`:
    cohorts that come back.

  The explorer (`/analytics/explore`) builds all three visually, and the MCP `discover` tool returns
  the full syntax.

## Mode: ask a question (`ask`)

1. **Find the members.** Call MCP `discover` with the topic if MCP is connected, or read `/meta`
   (below), or read `apps/web/src/plugins/analytics/cubes/*.ts`.
2. **Build the smallest query** that answers the question. Then decide: filter or group by time?
   Top N? (order plus limit)
3. **Validate** with MCP `validate` or `POST /cubejs-api/v1/dry-run`, then **run** it (`load`).
4. **Answer in words first**, then show the table, and say which members you used. If the result is
   empty, say so and suggest why: no data yet, a window that's too narrow, or a stale fact table (see
   `check-facts`).

## Mode: call it from a terminal (`curl`)

```bash
export RF_URL=http://localhost:3001                          # or your deployed APP_URL
read -rs RF_KEY && export RF_KEY                             # paste the key; nothing is echoed

# What cubes, measures and dimensions exist (this organisation's view)
curl -s "$RF_URL/cubejs-api/v1/meta" -H "Authorization: Bearer $RF_KEY" | jq '.cubes[] | {name, measures: [.measures[].name]}'

# Run a query
curl -s "$RF_URL/cubejs-api/v1/load" \
  -H "Authorization: Bearer $RF_KEY" -H 'Content-Type: application/json' \
  -d '{"query":{"measures":["TenantUsers.count"],"dimensions":["TenantUsers.role"]}}' | jq '.results[0].data'

# Validate without running it, and see the SQL
curl -s "$RF_URL/cubejs-api/v1/dry-run" -H "Authorization: Bearer $RF_KEY" -H 'Content-Type: application/json' \
  -d '{"query":{"measures":["ActivityEvents.count"]}}' | jq .
curl -s "$RF_URL/cubejs-api/v1/sql"     -H "Authorization: Bearer $RF_KEY" -H 'Content-Type: application/json' \
  -d '{"query":{"measures":["ActivityEvents.count"]}}' | jq .

# The Postgres plan for a slow query
curl -s "$RF_URL/cubejs-api/v1/explain" -H "Authorization: Bearer $RF_KEY" -H 'Content-Type: application/json' \
  -d '{"query":{"measures":["ActivityEvents.count"],"dimensions":["Users.email"]}}' | jq .
```

- Endpoints served here: `GET /meta`, `GET|POST /load`, `GET|POST /sql`, `GET|POST /dry-run`,
  `POST /explain` and `POST /batch` (`{"queries":[…]}`).
- A `load` response is `{ queryType, results: [{ data: [...], annotation, … }] }`, and the rows are
  in `results[0].data`.

**Success:** `/meta` lists `ActivityEvents`, `TenantActivityDaily`, `TenantUsers` and `Users` (plus
any contributed cubes), and `load` returns rows for your organisation only.

## Mode: connect Claude Code to `/mcp` (`mcp-claude-code`)

The app serves drizzle-cube's MCP endpoint over **streamable HTTP** at `<URL>/mcp`, using the same
API-key auth as everything else. It exposes three tools:
- `discover`: finds cubes by topic and returns the full query syntax;
- `validate`: checks a query and suggests corrections;
- `load`: runs a query.

It also exposes prompts and a live schema resource. The instructions it returns tell Claude to call
`discover` first.

```bash
# Scope: local (default, just you, this project) | project (.mcp.json, shared) | user (all projects)
claude mcp add --transport http launch-analytics http://localhost:3001/mcp \
  --header "Authorization: Bearer <your key>"

claude mcp list                     # expect: ✔ Connected  launch-analytics
```

Then, in a session, run `/mcp` to see its tools. Ask something like *"Using launch-analytics,
how many active users did we have per week over the last 90 days?"*

**To share a server definition without sharing a key,** use `--scope project`, which writes
`.mcp.json`, and reference an environment variable. Each person then exports their own key:

```json
{
  "mcpServers": {
    "launch-analytics": {
      "type": "http",
      "url": "${RF_URL:-http://localhost:3001}/mcp",
      "headers": { "Authorization": "Bearer ${RF_ANALYTICS_KEY}" }
    }
  }
}
```

`claude mcp get launch-analytics` shows the configuration with the `${…}` references still
unexpanded, which is a good check that no key got written into the file.

## Mode: connect Claude Desktop (`mcp-claude-desktop`)

Claude Desktop's **Customize → Connectors → Add custom connector** only supports OAuth. It has no
field for a Bearer key, and it connects **from Anthropic's servers**, so it can never reach
`localhost`. This app authenticates `/mcp` with API keys, not OAuth, so use the `mcp-remote` bridge
in the local config file instead. It needs Node 18 or newer.

1. Claude menu → **Settings… → Developer → Edit Config**. That opens:
   - macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
   - Windows: `%APPDATA%\Claude\claude_desktop_config.json`
2. Add the server:

   ```json
   {
     "mcpServers": {
       "launch-analytics": {
         "command": "npx",
         "args": ["-y", "mcp-remote", "http://localhost:3001/mcp", "--header", "Authorization:${RF_AUTH}"],
         "env": { "RF_AUTH": "Bearer <your key>" }
       }
     }
   }
   ```

   Write `Authorization:${RF_AUTH}` with **no space after the colon**, and keep the space inside the
   env value. This is the documented workaround for Claude Desktop (Windows) not escaping spaces in
   `args`. `-y` stops `npx` asking before it installs `mcp-remote`.

   For a deployed app, use `https://<your app>/mcp`. `mcp-remote` restricts non-HTTPS URLs. If it
   refuses `http://localhost:3001/mcp` locally, add `"--allow-http"` to `args`. Its README documents
   that flag for trusted private networks only, so never use it for a remote host.
3. **Quit Claude Desktop completely** and reopen it. Then click the **+** in the message box →
   **Connectors → Manage connectors** and check that `launch-analytics` lists
   `discover` / `validate` / `load`.
4. If it doesn't connect, read the logs:
   - macOS: `tail -n 50 -f ~/Library/Logs/Claude/mcp*.log`
   - Windows: `%APPDATA%\Claude\logs`

   Then test the same URL and key with the `curl` against `/meta` above.

The key sits in plain text in that config file. Make it a dedicated key, and revoke it in
**Settings → API keys** when you stop using it.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| 401 `unauthorized` | missing or wrong `Authorization: Bearer`, or the key was revoked | create a new key; check that there's no stray space or newline in it |
| 403 `no_tenant` | a cookie session with no organisation selected | use an API key, or pick an organisation at `/select-tenant` |
| 403 from `/mcp` in a browser-based client | drizzle-cube rejects browser `Origin`s it doesn't know; loopback and no-Origin clients (Claude Code, `mcp-remote`, curl) are allowed | use one of those clients. Allowing a browser origin means setting `mcp.allowedOrigins` in `api/routes/cube-api.ts`, which is a code change and needs review |
| HTML instead of JSON | `/cubejs-api` or `/mcp` is missing from `run_worker_first` or the Vite proxy | the `analytics` skill, Health |
| 400 `Unknown member …` | a guessed field name | copy names from `/meta` or `discover` |
| totals look like all time | an unrecognised relative date string was dropped | use `last N days` or an ISO pair |
| numbers lag reality on `TenantActivityDaily` | the fact table rebuilds hourly at `:15` | `pnpm cli analytics check-facts`, then `refresh-facts` (admin) |
| a cube missing from `/meta` | its feature is off for this organisation (`FEATURE_CUBES`) | turn the feature on for the tenant, or query another cube |

## Sources

- Claude Code MCP (`claude mcp add --transport http … --header`, scopes, `.mcp.json` `${VAR}` expansion, `claude mcp list/get`): https://code.claude.com/docs/en/mcp
- Claude Desktop config file locations, Developer → Edit Config, logs: https://modelcontextprotocol.io/docs/develop/connect-local-servers
- Custom connectors (OAuth only, brokered from Anthropic's servers, must be publicly reachable): https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp
- No Bearer-header field for custom connectors: https://github.com/anthropics/claude-ai-mcp/issues/112
- `mcp-remote` (`--header`, the no-space workaround, `--allow-http` for trusted private networks only, `-y` when npx prompts, Node 18+): https://github.com/geelen/mcp-remote
- drizzle-cube docs: https://www.drizzle-cube.dev
- drizzle-cube 0.8.3 package (routes in `dist/adapters/hono`: meta, load, sql, dry-run, explain, batch; MCP tools discover, validate, load; `MCPOptions.allowedOrigins` defaults; `FilterOperator` and `TimeGranularity` in `dist/server/types`): https://www.npmjs.com/package/drizzle-cube/v/0.8.3
- Upstream skill this adapts (MIT): https://github.com/cliftonc/drizzle-cube-plugin/blob/main/skills/dc-query-building/SKILL.md
