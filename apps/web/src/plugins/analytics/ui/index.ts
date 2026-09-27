/**
 * `analytics` — the plugin's UI entry (D31, Phase C).
 *
 * **This file ships in the MAIN bundle**, because `App.tsx`, `SideNav` and `Home` import the barrel
 * that imports it, for every reader — including the ones who never open a dashboard. So it wires
 * things up and nothing else: every page arrives as `lazy(() => import(...))`, which is what keeps
 * drizzle-cube, recharts, d3 and react-grid-layout out of the shell and inside the analytics chunk
 * (`tests/config/plugins.test.ts` reads this file's SOURCE and enforces both halves).
 *
 * The only host module it may import is `@/plugins/api/ui-wiring` — the WIRING half of the UI kit,
 * which is types, one helper and one hook. The COMPONENTS half (`@/plugins/api/ui`) is deliberately
 * unreachable from here; that is for a lazy PAGE, which ships in its own chunk.
 *
 * The nav item, the Home quick link and all three routes share ONE guard object, so a link can
 * never point at a page its reader cannot open. `read Analytics` is every member's (§8): pages are
 * tenant-shared and row scoping is inside every cube; editing is gated per control by
 * `manage Dashboard`.
 */
import { ChartBarIcon } from '@heroicons/react/24/outline'
import { analyticsShared } from '@launch/shared/plugins/analytics/index'
import { lazy } from 'react'
import type { NavGuard, UiPlugin } from '@/plugins/api/ui-wiring'
import { analyticsQueryKeys } from './query-keys'

const DashboardListPage = lazy(() => import('./pages/DashboardListPage'))
const DashboardViewPage = lazy(() => import('./pages/DashboardViewPage'))
const QueryBuilderPage = lazy(() => import('./pages/QueryBuilderPage'))

/** One const for the nav item, the Home quick link and all three routes. */
export const ANALYTICS_GUARD: NavGuard = { action: 'read', subject: 'Analytics' }

export const analyticsUi = {
  shared: analyticsShared,
  routes: [
    { path: '/analytics', Component: DashboardListPage, guard: ANALYTICS_GUARD },
    // React Router v6 ranks a static segment above a dynamic one, so `/explore` wins over
    // `:pageId` whatever order this array is in.
    { path: '/analytics/explore', Component: QueryBuilderPage, guard: ANALYTICS_GUARD },
    { path: '/analytics/:pageId', Component: DashboardViewPage, guard: ANALYTICS_GUARD },
  ],
  // No `before`, so it lands above the kit's "Organisation" group — where analytics sat when it
  // was part of the kit.
  nav: [
    {
      items: [{ to: '/analytics', label: 'Analytics', icon: ChartBarIcon, guard: ANALYTICS_GUARD }],
    },
  ],
  homeLinks: [
    {
      to: '/analytics',
      label: 'Analytics',
      description: 'Dashboards over this organisation',
      icon: ChartBarIcon,
      guard: ANALYTICS_GUARD,
    },
  ],
  queryKeys: analyticsQueryKeys,
} satisfies UiPlugin<typeof analyticsShared>
