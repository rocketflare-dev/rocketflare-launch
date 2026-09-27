---
name: analytics-dashboards
description: Create, edit, share and maintain analytics dashboards in this app — build one in the UI or from the explorer, restrict who sees it to groups (D29), reset or recreate template dashboards, write a new dashboard TEMPLATE every organisation gets (drizzle-cube DashboardConfig with rows layout, KPI groups, universal date filter), and script dashboards through /api/analytics. Use when someone wants a dashboard, chart, KPI strip, report page, wants to share/restrict/reset one, or asks why a dashboard is broken, blank or shows the wrong dates.
argument-hint: "[create | share <dashboard> | reset | template <key> | api | fix <dashboard>]"
---

# Dashboards — build, share and template them

A dashboard is one row in `analytics_pages`, holding a drizzle-cube `DashboardConfig`. drizzle-cube
renders everything, including the charts, the grid editor, drill-down and the per-portlet query
editor. The plugin owns only the pages, the API and the wiring. Where things are:
- `/analytics`: the list;
- `/analytics/:pageId`: view and edit;
- `/analytics/explore`: the query builder;
- `apps/web/src/plugins/analytics/dashboards/`: the templates. Read `dashboards/CLAUDE.md` and
  `DASHBOARD_PATTERNS.md` before you write one.

**Who can do what:**
- Every member of the organisation can view dashboards they're allowed to see.
- **Owner, admin and support** (`manage Dashboard`) can create, edit, rename, restrict, reset and
  delete.
- Only template dashboards can be reset, and they can never be deleted (403 `template_page`).
  User-created dashboards are the other way round: they can be deleted but not reset.

**Ground rules:**
- A dashboard only references cube members that exist. Member names are frozen, so if a cube
  lacks what you need, add a member with `analytics-cubes`; never rename one.
- Editing a TEMPLATE file only reaches **new** organisations. Existing ones get it through
  **Reset to template**, or **Recreate templates**, which resets every template dashboard for that
  organisation and throws away its edits. Say so and get a yes before running either.

## Mode: create one in the UI (`create`)

1. Go to `/analytics` → **New dashboard**. Give it a name and, optionally, a description. You can
   **start from a template**, which copies that template's layout, or start empty.
2. Open it and press **Edit**. drizzle-cube's editor adds portlets (charts), each with its own query
   builder, and lets you drag and resize them. Changes **autosave** about 1.5 seconds after the last
   edit, and again when you press **Done** or leave the page.
3. Quicker for one chart: build it in **Explore** (`/analytics/explore`) and press **Save to
   dashboard**. That appends it as a full-width row on the dashboard you pick.
4. The **date range** control on a dashboard is kept in the URL (`?range=…`, or `?from=…&to=…` for a custom range), so links share the
   window. It overrides only filters marked `isUniversalTime`; a KPI with its own window keeps it.

**Success:** the dashboard is listed at `/analytics`, it renders for a plain member (unless it's
restricted), and `pnpm cli analytics pages list` shows it.

## Mode: restrict who can see it (`share`)

1. Open the dashboard, then **⋯ → Who can see this**.
2. The choices:
   - **Everyone in the organisation** (`visibility: tenant`), the default.
   - **Selected groups** (`visibility: groups`): only members of those groups, **plus the creator
     and every owner or admin**. Choosing groups with an empty list makes it private to its creator
     and the admins.
3. The groups come from **Settings → People → Groups**. Only owners and admins set visibility; a
   member who can see a dashboard cannot re-share it.
4. A hidden dashboard gives the same 404 as one that doesn't exist, so a member can't discover it.
   The list shows an access badge on restricted dashboards.

**Important:** visibility hides the **dashboard**, not the **data**. Every member can still query
the same cubes in Explore or through the API. To hide rows, the cube itself has to narrow by group
(`groupFilter`, in `analytics-cubes`).

## Mode: reset or recreate (`reset`)

- One template dashboard: open it, then **⋯ → Reset to template**
  (`POST /api/analytics/pages/:id/reset`).
- All of them: on `/analytics`, use **Recreate templates** (`POST /api/analytics/templates/recreate`).
  It creates any that are missing and resets the rest, then reports `created` and `reset` counts.
- Either one **throws away edits** made to those dashboards in this organisation. Confirm with the
  person first.

## Mode: write a new template every organisation gets (`template`)

1. Create `dashboards/general-templates/<key>.ts`, or a new category folder, exporting a
   `DashboardConfig` (a type from `drizzle-cube/client`). Copy `tenant-overview.ts` as a starting
   point. Templates are **pure data**: no drizzle and no schema imports, because the browser imports
   the registry.
2. Register it in that folder's `index.ts` as a `DashboardTemplate`:
   `{ key, name, description, order, isDefault?, feature?, config }`.
   - `key` is also the page slug.
   - `order` must be unique.
   - Only **one** template may have `isDefault: true`.
   - `feature` hides it where a D30 feature is off; it is then neither listed nor seeded.
3. **Layout rules.** `tests/config/all-templates.test.ts` enforces every one of these:
   - `layoutMode: 'rows'` **plus** an explicit `rows` array. Without `rows`, drizzle-cube spreads the
     columns out evenly and ignores your widths.
   - Every row's columns add up to **12**. Row and group ids are unique.
   - Every portlet appears exactly once, across rows and groups.
   - Each portlet's `x/y/w/h` matches its row: `y` is the sum of the heights of the rows above it,
     `x` is the sum of the widths to its left, `h` is the row's height, and `w` is the column's width.
   - KPI strips are a `groups` entry (`direction: 'row'`, one cell per KPI) placed in a row by
     `groupId`. Use `layout: 'compact'` on `kpiNumber` in strips of 4 or more, with that row at `h: 2`.
   - A `recordsTable` query must set `"ungrouped": true`.
   - A `gauge` needs a row with `h` of at least 3.
   - `showSummary` is only for line and area charts. Don't use the deprecated `stacked` flag; use
     `displayConfig.stackType`.
   - Every `dashboardFilterMapping` id must be a filter the dashboard declares.
   - Every `Cube.member` in a portlet query must exist in `allCubes()`.
4. **Dates.** Declare ONE universal time filter and map it to the time-series portlets:
   ```ts
   filters: [{ id: 'time-filter', label: 'Date Range', isUniversalTime: true,
               filter: { member: '__universal_time__', operator: 'inDateRange', values: ['last 90 days'] } }]
   ```
   - Don't put a `dateRange` in the portlet queries; the filter controls it.
   - Use only `last 7|30|90 days` or an ISO pair. An unrecognised relative string silently queries
     all time.
5. **Portlet format.** Templates use the form the test reads: `query` as a **JSON string** plus
   `chartType`, `chartConfig` and `displayConfig`, as in `tenant-overview.ts`. Portlets saved from
   Explore use drizzle-cube's newer `analysisConfig` object, which renders the same way. Don't
   convert a template to `analysisConfig`, or the template test can't read its query.
6. **Verify:**
   - `pnpm web test:config` runs the layout rules.
   - `pnpm web test:api` runs every portlet query against Postgres (in `cube-isolation.test.ts`),
     and each must return rows for a seeded organisation.
   - Then open `/analytics` in a fresh organisation, or **Recreate templates** in your own, and check
     it by eye in light and dark themes.

Chart type cheat-sheet, as used in this app:
- `kpiNumber`, `kpiDelta`: headline numbers. `kpiDelta` needs a time dimension for its sparkline.
- `line`, `area`: trends. Use `displayConfig.stackType: 'percent'` for shares over time.
- `bar`: comparisons.
- `proportionBar` for part-to-whole. Use it instead of `pie`.
- `table` for aggregate group-bys.
- `recordsTable`: one row per record, and needs `ungrouped`.
- `gauge`: bounded scores; `thresholds` values are fractions from 0 to 1.
- `markdown`: section headers.

`DASHBOARD_PATTERNS.md` has worked examples of each.

## Mode: script it (`api`)

The endpoints are under `/api/analytics`, authenticated with the same cookie or
`Authorization: Bearer <API key>` as everything else. See `analytics-queries` for making a key.
Responses are the shared contracts in `@launch/shared/plugins/analytics/index`.

| Call | Who | Body and notes |
|---|---|---|
| `GET /pages` | any member | lists the dashboards you can see; the first call creates missing template dashboards |
| `GET /pages/:id` | any member | 404 if hidden from you |
| `POST /pages` | `manage Dashboard` | `{ name, description?, config?, order? }`; `config` defaults to an empty rows dashboard |
| `PATCH /pages/:id` | `manage Dashboard` | any of `{ name, description, config, order, isDefault }`; `config` replaces the whole config |
| `PUT /pages/:id/visibility` | `manage Dashboard` | `{ visibility: 'tenant' }` or `{ visibility: 'groups', groupIds: [...] }` |
| `POST /pages/:id/reset` | `manage Dashboard` | template dashboards only |
| `DELETE /pages/:id` | `manage Dashboard` | user dashboards only |
| `GET /templates` · `POST /templates/recreate` | any member · `manage Dashboard` | |

From the CLI: `pnpm cli analytics pages list` (add `--json` for the raw response).

## Mode: fix a broken dashboard (`fix`)

| Symptom | Cause | Fix |
|---|---|---|
| a portlet shows an error or "member not found" | a cube member was renamed or removed, or its feature is off for this organisation | restore the member (`analytics-cubes`), or edit the portlet |
| everything shows all-time totals | an unrecognised relative date string | use `last 7/30/90 days` or ISO dates |
| columns are all the same width | no explicit `rows` | add `rows` (template), or re-lay it out in the editor |
| a KPI strip is tall and empty | a compact KPI in an `h ≥ 3` row, or a gauge in an `h: 2` row | follow the layout rules above |
| edits vanished | someone ran **Reset to template** or **Recreate templates** | check the organisation's activity log for `dashboard.reset` |
| a member can't see a dashboard | it's restricted to groups they aren't in | **Who can see this** |
| charts are blank but Explore works | the fact table is stale (`TenantActivityDaily`) | `pnpm cli analytics check-facts`, then `refresh-facts` |

## Sources

- drizzle-cube dashboards and `DashboardConfig`: https://www.drizzle-cube.dev
- drizzle-cube 0.8.3 client types (`DashboardConfig`, `PortletConfig`, `AnalyticsDashboard`): https://www.npmjs.com/package/drizzle-cube/v/0.8.3
- Upstream skills this adapts (MIT; they prefer `analysisConfig`, while this app's templates keep the `query`-string form its tests read): https://github.com/cliftonc/drizzle-cube-plugin/blob/main/skills/dc-dashboard-config/SKILL.md, https://github.com/cliftonc/drizzle-cube-plugin/blob/main/skills/dc-chart-config/SKILL.md
- This app: `apps/web/src/plugins/analytics/dashboards/{CLAUDE.md,DASHBOARD_PATTERNS.md}`, `api/routes/analytics-pages.ts`, `ui/CLAUDE.md`, `tests/config/all-templates.test.ts`
