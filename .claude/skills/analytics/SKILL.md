---
name: analytics
description: Entry point for the analytics plugin (drizzle-cube semantic layer, dashboards and fact tables). Checks it is installed and healthy, explains what it gives you, and routes to the right analytics skill. Use when someone mentions analytics, dashboards, charts, metrics, KPIs, cubes, drizzle-cube, the semantic layer, fact tables, /cubejs-api, the /mcp endpoint, or asks "how do I see/measure X in Launch".
argument-hint: "[explain | health | cubes | query | dashboards | mcp]"
---

# Analytics — orientation, health check and routing

The `analytics` plugin adds a **semantic layer** to this app. It is built on
[drizzle-cube](https://www.drizzle-cube.dev), pinned at **0.8.3**. It gives you:

- **Cubes**: named, tenant-scoped definitions of measures (counts, sums, distinct counts) and
  dimensions (role, event type, dates) over the app's own Postgres tables.
- **An API over the cubes**: `/cubejs-api/v1/{load,meta,sql,dry-run,explain,batch}` (Cube.js-compatible)
  and an **MCP endpoint** at `/mcp`, both behind the app's normal sign-in or API key.
- **Dashboards**: one row per dashboard in `analytics_pages`, rendered by drizzle-cube's React
  components at `/analytics` (list), `/analytics/:pageId` (view and edit) and `/analytics/explore`
  (query builder). They can be restricted to groups (D29).
- **Fact tables**: pre-aggregated tables rebuilt every hour at `:15` by a cron. One example ships:
  `analytics_tenant_activity_daily_facts`.
- **CLI**: `launch analytics pages list | check-facts | refresh-facts`.

The code lives in `apps/web/src/plugins/analytics/`. Its `CLAUDE.md` and the `CLAUDE.md` files in
its folders are the reference; this skill and its siblings are the how-to.

## Route to the right skill

| The person wants to… | Use |
|---|---|
| add or change a metric, add a cube over a new table, add a fact table, contribute a cube from another plugin | **`analytics-cubes`** |
| ask a question of the data, call the API from a script, debug a query, connect Claude Code / Claude Desktop to `/mcp` | **`analytics-queries`** |
| create, edit, share, restrict, reset or template a dashboard | **`analytics-dashboards`** |
| understand what is there, or check it works | stay here: **Explain** or **Health** below |

## Explain (no changes)

1. Say what the plugin is (above) in two sentences, then list the cubes it serves today:
   - `Users`: people in this organisation, scoped through membership.
   - `TenantUsers` (title "Members"): memberships with role and join date, plus owner, admin and
     member counts.
   - `ActivityEvents`: the audit log, one row per event. It is an event stream, so funnels, flows
     and retention work on it.
   - `TenantActivityDaily` (title "Daily Activity"): the fact-table cube (events and active users
     per day).

   Plus any cube another installed plugin contributed. Read `apps/web/src/plugins/analytics/cubes/index.ts`
   and `pnpm plugin list` to see which plugins are installed.
2. **Who can do what** (grants in `apps/web/src/plugins/analytics/index.ts`):
   - Everyone in the organisation (owner, admin, support, member) may read dashboards and query
     cubes.
   - Owner, admin and support may create, edit, share, reset and delete dashboards.
   - Only owners and admins may see fact-table status and trigger a rebuild.
3. **The safety rule to state every time cubes come up:** every cube filters its own rows by
   tenant, and nothing else does. drizzle-cube adds no second line of defence. A cube without the
   tenant filter would show every organisation's rows to every member. That is why the isolation
   test is mandatory; `analytics-cubes` covers it.

## Health (read-only)

Run these in order and stop at the first failure. You need the app running (`pnpm dev`) and the
CLI signed in (`pnpm cli login --server http://localhost:3001`). Use `pnpm cli …` inside the repo,
or `launch …` if the CLI is installed globally.

1. **Installed?** `pnpm plugin list` should list `analytics`. If it doesn't:
   `pnpm plugin add https://github.com/rocketflare-dev/rocketflare-plugins.git --subdir plugins/analytics`
   shows the plan; add `--apply` once the person agrees. The kit's `defaultPlugins` installs it
   during `pnpm bootstrap`, so a fresh clone normally has it.
2. **Well formed?** `pnpm plugin check` should print `analytics` in its "check out" line.
3. **Migrated?** `pnpm db:migrate` exits 0. A missing `analytics_pages` table means the host never
   generated the plugin's migration, so run `pnpm db:generate --name plugin-analytics-<version>` then
   `pnpm db:migrate`.
4. **Dashboards reachable?** `pnpm cli analytics pages list` prints a table with at least
   "Tenant Overview". The first list for an organisation creates its template dashboards, so an
   empty table on the very first call is normal; run it again.
5. **Cubes reachable?** Open `http://localhost:3000/analytics/explore`. The field picker lists the
   cubes above. From a terminal, `analytics-queries` shows a `curl` against `/cubejs-api/v1/meta`.
6. **Facts fresh?** (admin or owner) Run `pnpm cli analytics check-facts`. It exits 1 and says
   `STALE` if a table's lag is more than twice its refresh interval. Fix it with
   `pnpm cli analytics refresh-facts`, which enqueues a rebuild of this organisation's facts. Under
   `wrangler dev` the queue consumer runs in-process, so it finishes within seconds.

**What "healthy" looks like:** all six pass. Report the result as a short checklist.

**Common failures:**

| Symptom | Cause | Fix |
|---|---|---|
| `/cubejs-api/...` or `/mcp` returns the app's HTML | the paths aren't in `[assets] run_worker_first`, or aren't proxied by Vite in dev | `pnpm plugin add` printed these host edits: add `/cubejs-api`, `/cubejs-api/*`, `/mcp` and `/mcp/*` to `run_worker_first` in both wrangler tomls (or run `pnpm provision cloudflare <env>`), and add both prefixes to the dev proxy in `apps/web/vite.config.ts`. The config tests fail until you do |
| facts never refresh when deployed | the `15 * * * *` cron isn't in `[triggers]` of both tomls | add it, or run `pnpm provision cloudflare <env>` |
| 401 on every cube call | not signed in, or the API key is wrong or revoked | `pnpm cli whoami`; create a new key |
| 403 `no_tenant` | the session has no organisation selected | pick one at `/select-tenant` |
| the build fails on `@nivo/heatmap` | the Vite alias to `ui/lib/nivo-heatmap.tsx` is missing | re-add the alias from the install plan |

## Optional complement: the upstream drizzle-cube Claude Code plugin

drizzle-cube's author publishes a general Claude Code plugin with slash commands (`/dc-query`,
`/dc-debug`, `/dc-create-cube` …), generic drizzle-cube skills and an MCP bridge. It is **not
needed**: these skills cover the same ground for this app's version and conventions. It is useful
for its REST tools (SQL preview, explain plans). Install it from inside a Claude Code session:

```text
/plugin marketplace add cliftonc/drizzle-cube-plugin
/plugin install drizzle-cube@drizzle-cube-marketplace
```

The repository registers its marketplace as `drizzle-cube-marketplace`, with one plugin called
`drizzle-cube`. The project README shows an older one-line form; the two commands above follow
Claude Code's current plugin docs. To point it at this app, create `.drizzle-cube.json` in the
project root:

```json
{ "serverUrl": "http://localhost:3001", "apiToken": "<a Launch API key>" }
```

Or set the environment variables `DRIZZLE_CUBE_SERVER_URL` and `DRIZZLE_CUBE_API_TOKEN`. It sends
the token as `Authorization: Bearer …`, which is exactly what this app accepts. **Warn the person
about two things:**
- Its generic skills show an older cube syntax that does not compile on drizzle-cube 0.8.3
  (`analytics-cubes` explains the difference). Prefer this plugin's skills when writing code here.
- `.drizzle-cube.json` holds a credential, so add it to `.gitignore`.

## Sources

- drizzle-cube docs: https://www.drizzle-cube.dev
- drizzle-cube Claude Code plugin page: https://www.drizzle-cube.dev/ai/claude-code-plugin/
- Plugin repository and README (MIT): https://github.com/cliftonc/drizzle-cube-plugin
- Its marketplace manifest: https://github.com/cliftonc/drizzle-cube-plugin/blob/main/.claude-plugin/marketplace.json
- Config field names (`serverUrl`, `apiToken`, `DRIZZLE_CUBE_SERVER_URL`): https://github.com/cliftonc/drizzle-cube-plugin/blob/main/src/index.ts
- Claude Code, installing plugins and marketplaces: https://code.claude.com/docs/en/discover-plugins
