# The analytics plugin's UI (D19/D20, moved here by D31 Phase C)

This was `apps/web/src/ui/CLAUDE.md`'s "Analytics dashboards" section while analytics was part of
the kit. Nothing about the UI changed when it moved — what changed is where it lives and what it
may import. Two rules the host enforces and this file assumes:

- **`ui/index.ts` ships in the MAIN bundle**, so every page below arrives as
  `lazy(() => import(...))` and the only host module it may import is `@/plugins/api/ui-wiring` —
  the WIRING half of the UI kit (types, one helper, one hook). `tests/config/plugins.test.ts` reads
  its source.
- **Pages and their components import `@/plugins/api/ui`**, the COMPONENTS half: the whole
  `components/shared` barrel, `LoadingIndicator`, `api`/`ApiError`, the formatters, `useAuth`,
  `usePermissions`, `useGroups`, `showToast`. A page is lazy, so it ships in its own chunk.
- **The browser may import `../dashboards/registry`, never `../dashboards`** — the second composes
  other plugins' templates and so reads the SERVER plugin barrel, which drags `postgres` into the
  UI bundle. Measured; the build says so.

Paths below are relative to `apps/web/src/plugins/analytics/`.

## Analytics dashboards (Phase 4, D19/D20)

- **GM wrote no chart code.** drizzle-cube renders everything: `AnalyticsDashboard` (react-grid-layout
  editor, portlet editor with its own query builder, drill-down, charts) and `AnalysisBuilder`
  (`/analytics/explore`). The kit owns the glue only: pages, hooks over `/api/analytics/*`
  (`@launch/shared/analytics`), the provider wiring and the theme mapping. drizzle-cube 0.8.3 client
  API actually used: `CubeProvider` from `drizzle-cube/client/providers` (`apiOptions`,
  `queryClient`, `features`), `AnalyticsDashboard` (`config`, `editable`, `dashboardFilters`,
  `onConfigChange`, `onSave`, `loadingComponent`), `AnalysisBuilder` + `AnalysisBuilderRef`
  (`getAnalysisConfig()`), types `DashboardConfig`/`PortletConfig`/`CubeApiOptions`/
  `FeaturesConfig` from `drizzle-cube/client`, and `drizzle-cube/client/styles.css`.
- **Same-origin cookie auth**: `CubeClientProvider` passes `apiOptions = { apiUrl:
  '/cubejs-api/v1', credentials: 'include', headers: { 'X-Requested-With': 'fetch' } }` — the
  library's `CubeClient` forwards both to every `fetch` (it defaults to `include` anyway; the
  header is the kit's marker). No token. drizzle-cube runs its queries on a BUNDLED TanStack Query
  (separate React context), so the app's `QueryCache.onError` never sees a cube failure: the
  provider hands it `createCubeQueryClient()`, whose `onError` maps a `status === 401`
  (`CubeQueryError`) to `notifyUnauthorized(new ApiError(...))` → the global D20 handler. Both that
  and `setUnauthorizedHandler` come off `@/plugins/api/ui`. Our hooks
  rendered inside `CubeProvider` still resolve the APP client (different context) — that is why
  `DashboardLoader` can call `useAutosaveDashboardConfig` from inside it.
- **Bundle discipline**: nothing under `pages/analytics/**` or `components/analytics/**` may be
  imported from the main bundle; `App.tsx` lazy-loads the three pages and `DashboardListPage`
  deliberately imports no drizzle-cube runtime (it lists rows; the library loads with the view /
  explore chunks — Vite emits a `DashboardLoader-*.js` shared by both, plus per-chart chunks; it is
  the largest thing the UI ships, which is exactly why it is lazy). `grep recharts
  dist/ui/assets/index-*.js` must stay at 0 — that check, not a byte count, is the guardrail.
  `vite.config.ts` dedupes `recharts` and aliases `@nivo/heatmap` (an OPTIONAL peer the heat-map chunk names an export of —
  Rollup fails without it) to `ui/lib/nivo-heatmap.tsx`, which renders a notice; install the
  package and drop the alias to enable heat maps.
- **Theme**: drizzle-cube styles itself from `--dc-*` variables; `index.css` re-points every one at
  a kit token under `:root[data-theme="launch-light"], :root[data-theme="launch-dark"]` (specificity
  (0,2,0) beats the library's `:root` and `html.dark` regardless of stylesheet order; the values are
  `var()`s that flip with the theme, so one block covers both). Its chart palettes decide dark from
  `data-theme="dark"` or a `dark` class on `<html>`, so `CubeClientProvider` mirrors `launch-dark` into
  that class while mounted (`syncDarkClass`) — the kit's own CSS never reads `.dark`. `index.css`
  also `@source`s `node_modules/drizzle-cube/dist/client/**/*.js` (the rule for JSX-shipping
  dependencies); measured effect: the library's utilities are `dc:`-prefixed and precompiled into
  its own stylesheet, so the scan generates no drizzle-cube class — only stray-word DaisyUI
  components (`stat`, `steps`, `tooltip`, `vc`…), i.e. pure cost on `index-*.css`.
- **Editing & autosave**: `DashboardLoader` keeps the config as local state (seeded from the row,
  re-seeded when the server row changes and nothing is dirty — a reset arrives that way). In edit
  mode each `onConfigChange` schedules ONE debounced whole-config `PATCH` (`DASHBOARD_AUTOSAVE_MS`
  = 1.5 s); the editor's `onSave`, leaving edit mode and unmount flush it; while dirty a
  `beforeunload` guard warns (no data router, so no `useBlocker`). Edit / rename / reset / delete /
  create / recreate are `manage Dashboard` (admin+); the route and nav are `read Analytics`.
  Template pages (`templateKey !== null`) offer "Reset to template", never delete (server: 403
  `template_page`); user pages the reverse. "Start from template" copies the config from the
  pure `src/dashboards` registry client-side (`getTemplate(key).config` → `POST /pages`).
- **Date range** is URL state (`useDashboardDateFilter`), never a store: presets emit exactly
  `'last 7|30|90 days'` or an ISO pair — an unknown relative string makes drizzle-cube DROP the
  condition and silently query all time, so anything unparseable falls back to 90 days.
  `dashboardDateFilters(config, range)` returns override copies of the `isUniversalTime` filters;
  `AnalyticsDashboard dashboardFilters` merges them by id, so a KPI with its own window is untouched.
- **Explore → Save to dashboard** (admin+): `ref.getAnalysisConfig()` becomes a portlet
  (`analysisConfig`, the canonical format) appended as a full-width `rows` entry with mirrored
  x/y/w/h (`appendPortlet`, pure) and saved with `PATCH /pages/:id`.
- Tests: `analytics-pages` (no library needed), `dashboard-view` (mocks `drizzle-cube/client`,
  `drizzle-cube/client/providers` and the stylesheet with stand-ins that fire the same callbacks;
  the debounce is asserted with real timers, `waitFor` timeout 4 s), `date-filter` (pure + hook
  URL sync via `renderHook` in a `MemoryRouter`), `cube-client-provider` (mounts the REAL
  `CubeProvider` against `stubFetch` — asserts the library's own request carries the credentials
  and header, and that a 401 reaches `setUnauthorizedHandler`; stub `window.matchMedia` first).
  Fixtures: `tests/ui/helpers/analytics.ts`.
