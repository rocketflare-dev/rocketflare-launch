/**
 * Providers + route table (06 §b, D20, D25).
 *
 * Provider order: ErrorBoundary → QueryClientProvider → AuthProvider → AbilityProvider →
 * WebSocketProvider (D8: connects once authenticated with a tenant, invalidates queries on events)
 * → BrowserRouter (NavigationBridge, ScrollToTop, routes, ToastContainer).
 *
 * Route tiers: public (`/login`, `/magic-link/sent`, `/invite/:token`); signed-in-without-tenant
 * (`/select-tenant`, `/pending`, `/no-access` — `ProtectedRoute requireTenant={false}`); and the
 * shell (`/*` — `ProtectedRoute`, `Layout` mounted ONCE, nested routes swap beneath it).
 */
import { QueryClientProvider } from '@tanstack/react-query'
import { lazy, Suspense } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import type { PluginRouteTier } from '@/plugins/types'
import { uiPlugins } from '@/plugins/ui'
import { ConnectionBanner } from '@/ui/components/ConnectionBanner'
import { ErrorBoundary } from '@/ui/components/ErrorBoundary'
import Layout from '@/ui/components/Layout'
import { LoadingIndicator } from '@/ui/components/LoadingIndicator'
import { Moved } from '@/ui/components/Moved'
import { NotificationsBell } from '@/ui/components/NotificationsBell'
import { OrgSwitcher } from '@/ui/components/OrgSwitcher'
import { PendingInvitationsBanner } from '@/ui/components/PendingInvitationsBanner'
import { ProtectedRoute } from '@/ui/components/ProtectedRoute'
import { AbilityProvider } from '@/ui/components/permissions/AbilityContext'
import { RequireGuard } from '@/ui/components/RequireGuard'
import { RoleBadge } from '@/ui/components/RoleBadge'
import ScrollToTop from '@/ui/components/ScrollToTop'
import { ToastContainer } from '@/ui/components/shared'
import { UserMenu } from '@/ui/components/UserMenu'
import { WebSocketProvider } from '@/ui/components/WebSocketProvider'
import { WebSocketStatus } from '@/ui/components/WebSocketStatus'
import { AuthProvider, useAuth } from '@/ui/hooks/useAuth'
import { NavigationBridge } from '@/ui/lib/navigation'
import {
  PLATFORM_ACCESS_REQUESTS_PATH,
  PLATFORM_IDENTITY_PATH,
  PLATFORM_SETTINGS_PATH,
  PLATFORM_SETUP_PATH,
} from '@/ui/lib/platform-paths'
import { queryClient } from '@/ui/lib/queryClient'
import Home from '@/ui/pages/Home'
import Login from '@/ui/pages/Login'
import NotFound from '@/ui/pages/NotFound'

// Public / no-tenant pages
const MagicLinkSent = lazy(() => import('@/ui/pages/MagicLinkSent'))
const InviteAccept = lazy(() => import('@/ui/pages/InviteAccept'))
const SelectTenant = lazy(() => import('@/ui/pages/SelectTenant'))
const Pending = lazy(() => import('@/ui/pages/Pending'))
const NoAccess = lazy(() => import('@/ui/pages/NoAccess'))
// Shell pages
const Profile = lazy(() => import('@/ui/pages/Profile'))
const Notifications = lazy(() => import('@/ui/pages/Notifications'))
const Activity = lazy(() => import('@/ui/pages/Activity'))
const SettingsLayout = lazy(() => import('@/ui/pages/settings/SettingsLayout'))
// D17: its own chunk — the markdown renderer must not ride in the main bundle.
const ChatPage = lazy(() => import('@/ui/pages/chat/ChatPage'))
// D7: also carries the markdown renderer (run transcripts) — lazy for the same reason.
const AgentsPage = lazy(() => import('@/ui/pages/agents/AgentsPage'))
const RunPage = lazy(() => import('@/ui/pages/agents/RunPage'))
// D18: the knowledge base — ingest/upload + list on /documents, hybrid search on /search.
const DocumentsPage = lazy(() => import('@/ui/pages/documents/DocumentsPage'))
const SearchPage = lazy(() => import('@/ui/pages/documents/SearchPage'))
// The detail page — no SideNav entry; it is reached from the list, from Search and from a citation.
const DocumentViewPage = lazy(() => import('@/ui/pages/documents/DocumentViewPage'))
// Launch (spec/05, 06, 08): the app registry, per-app sign-in access, request-access and the audit log.
const CataloguePage = lazy(() => import('@/ui/pages/apps/CataloguePage'))
const AppDetailPage = lazy(() => import('@/ui/pages/apps/AppDetailPage'))
const AppAccessPage = lazy(() => import('@/ui/pages/apps/AppAccessPage'))
// Launch P3: a coding session — chat + live preview. Its own chunk: it carries `Markdown`.
const SessionPage = lazy(() => import('@/ui/pages/sessions/SessionPage'))
// Launch P4: the approvals inbox and one request (notifications link to it).
const ApprovalsInboxPage = lazy(() => import('@/ui/pages/approvals/InboxPage'))
const ApprovalPage = lazy(() => import('@/ui/pages/approvals/ApprovalPage'))
// Launch P5: shared config — the bundles, one resource, and an app's config page.
const SharedConfigPage = lazy(() => import('@/ui/pages/shared-config/SharedConfigPage'))
const SharedResourcePage = lazy(() => import('@/ui/pages/shared-config/SharedResourcePage'))
const AppConfigPage = lazy(() => import('@/ui/pages/apps/AppConfigPage'))
const RequestAccess = lazy(() => import('@/ui/pages/RequestAccess'))
const Audit = lazy(() => import('@/ui/pages/Audit'))
const AdminLayout = lazy(() => import('@/ui/pages/admin/AdminLayout'))
const TenantList = lazy(() => import('@/ui/pages/admin/TenantList'))
const TenantDetail = lazy(() => import('@/ui/pages/admin/TenantDetail'))
const UserList = lazy(() => import('@/ui/pages/admin/UserList'))
const UserDetail = lazy(() => import('@/ui/pages/admin/UserDetail'))
const FeatureFlags = lazy(() => import('@/ui/pages/admin/FeatureFlags'))
const SessionsAdmin = lazy(() => import('@/ui/pages/admin/SessionsAdmin'))
// The deployment's own administration (`canAdministerPlatform`) — under Settings, not /admin.
const PlatformLayout = lazy(() => import('@/ui/pages/platform/PlatformLayout'))
const AccessRequests = lazy(() => import('@/ui/pages/platform/AccessRequests'))
const Setup = lazy(() => import('@/ui/pages/platform/Setup'))
const Identity = lazy(() => import('@/ui/pages/platform/Identity'))

// TanStack Query devtools: dev-only and OPT-IN — set `VITE_QUERY_DEVTOOLS=on` in
// `apps/web/.env.local` to show the toggle (off by default: it sits over the bottom of the page,
// which is where drawers and modals put their content, and in every session preview).
// `import.meta.env.DEV` is replaced at build time, so the dynamic import (and its chunk) is
// dropped from production bundles.
const ReactQueryDevtools =
  import.meta.env.DEV && import.meta.env.VITE_QUERY_DEVTOOLS === 'on'
    ? lazy(() =>
        import('@tanstack/react-query-devtools').then(m => ({ default: m.ReactQueryDevtools }))
      )
    : null

/**
 * Routes contributed by installed plugins (D31), for one tier. Rendered from the SAME `RequireGuard`
 * the nav item uses, so a plugin link can no more point at a page its reader cannot open than a
 * kit one can. `Component` is always a `lazy()` wrapper — checked in the source by
 * `tests/config/plugins.test.ts` — so a plugin's pages never reach the main bundle.
 */
function pluginRoutes(tier: PluginRouteTier) {
  return uiPlugins
    .flatMap(p => p.routes)
    .filter(r => (r.tier ?? 'shell') === tier)
    .map(r => {
      const page = <r.Component />
      const guarded = r.guard ? <RequireGuard guard={r.guard}>{page}</RequireGuard> : page
      return (
        <Route
          key={`${tier}:${r.path}`}
          path={r.path}
          element={
            tier === 'noTenant' ? (
              <NoTenantRoute>{guarded}</NoTenantRoute>
            ) : tier === 'public' ? (
              <Suspense fallback={<LoadingIndicator size="lg" centered />}>{guarded}</Suspense>
            ) : (
              guarded
            )
          }
        />
      )
    })
}

/** Sidebar footer: which org (and as what) the reader is acting in. */
function TenantFooter() {
  const { tenant } = useAuth()
  if (!tenant) return null
  return (
    <div className="flex items-center justify-between gap-2 px-1 py-1 text-xs">
      <span className="truncate text-secondary" title={tenant.name}>
        {tenant.name}
      </span>
      <RoleBadge role={tenant.role} />
    </div>
  )
}

/**
 * Everything that renders inside the app chrome. `Layout` is mounted ONCE for `/*` and these
 * nested routes swap beneath it, so the sidebar and header widgets never remount on navigation.
 */
function ShellRoutes() {
  return (
    <Layout
      headerStart={<OrgSwitcher />}
      headerEnd={
        <>
          <WebSocketStatus />
          <NotificationsBell />
          <UserMenu />
        </>
      }
      sidebarFooter={<TenantFooter />}
    >
      <ConnectionBanner className="mb-4" />
      <PendingInvitationsBanner className="mb-6" />
      <Suspense fallback={<LoadingIndicator fullPage />}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/profile" element={<Profile />} />
          <Route path="/notifications" element={<Notifications />} />
          <Route
            path="/chat/:conversationId?"
            element={
              <RequireGuard guard={{ action: 'read', subject: 'Conversation' }}>
                <ChatPage />
              </RequireGuard>
            }
          />
          {/* D7 + issue #17: the list and the run are two pages. A run is something a person is
              asked to ACT on, arrives at from a notification and comes back to — so it has its own
              route and its own lazy chunk, not a modal over the list. */}
          <Route
            path="/agents"
            element={
              <RequireGuard guard={{ action: 'read', subject: 'AgentRun' }}>
                <AgentsPage />
              </RequireGuard>
            }
          />
          <Route
            path="/agents/runs/:runId"
            element={
              <RequireGuard guard={{ action: 'read', subject: 'AgentRun' }}>
                <RunPage />
              </RequireGuard>
            }
          />
          <Route
            path="/documents"
            element={
              <RequireGuard guard={{ action: 'read', subject: 'Document' }}>
                <DocumentsPage />
              </RequireGuard>
            }
          />
          {/*
            React Router ranks a static segment above a dynamic sibling, so `/documents` wins over
            `/documents/:documentId` whatever the order here.
          */}
          <Route
            path="/documents/:documentId"
            element={
              <RequireGuard guard={{ action: 'read', subject: 'Document' }}>
                <DocumentViewPage />
              </RequireGuard>
            }
          />
          <Route
            path="/search"
            element={
              <RequireGuard guard={{ action: 'read', subject: 'Document' }}>
                <SearchPage />
              </RequireGuard>
            }
          />
          {/* Launch (spec/06): the catalogue and one app are every member's (`read App`); the
              access page is for the app's owners and admins, which the server decides. */}
          <Route
            path="/apps"
            element={
              <RequireGuard guard={{ action: 'read', subject: 'App' }}>
                <CataloguePage />
              </RequireGuard>
            }
          />
          <Route
            path="/apps/:slug"
            element={
              <RequireGuard guard={{ action: 'read', subject: 'App' }}>
                <AppDetailPage />
              </RequireGuard>
            }
          />
          <Route
            path="/apps/:slug/sessions/:id"
            element={
              <RequireGuard guard={{ action: 'read', subject: 'Session' }}>
                <SessionPage />
              </RequireGuard>
            }
          />
          <Route
            path="/apps/:slug/access"
            element={
              <RequireGuard guard={{ action: 'read', subject: 'App' }}>
                <AppAccessPage />
              </RequireGuard>
            }
          />
          {/* Launch P5 (spec/09): an app's declared config and grants — readers see it, the app's
              owners and admins request; the server decides who may do what. */}
          <Route
            path="/apps/:slug/config"
            element={
              <RequireGuard guard={{ action: 'read', subject: 'App' }}>
                <AppConfigPage />
              </RequireGuard>
            }
          />
          {/* Launch P5 (spec/09): shared config — every member reads the list (they need it to
              ask); owners and admins act, which the page and the server decide per resource. */}
          <Route
            path="/shared-config"
            element={
              <RequireGuard guard={{ action: 'read', subject: 'SharedResource' }}>
                <SharedConfigPage />
              </RequireGuard>
            }
          />
          <Route
            path="/shared-config/:id"
            element={
              <RequireGuard guard={{ action: 'read', subject: 'SharedResource' }}>
                <SharedResourcePage />
              </RequireGuard>
            }
          />
          {/* Launch P4 (spec/08): every member reads their approvals; the engine decides who may
              decide each one, so the page, not the route, says why someone cannot. */}
          <Route
            path="/approvals"
            element={
              <RequireGuard guard={{ action: 'read', subject: 'Approval' }}>
                <ApprovalsInboxPage />
              </RequireGuard>
            }
          />
          <Route
            path="/approvals/:id"
            element={
              <RequireGuard guard={{ action: 'read', subject: 'Approval' }}>
                <ApprovalPage />
              </RequireGuard>
            }
          />
          {/* spec/05: where `/oidc/authorize` sends a signed-in person the app's policy denies. */}
          <Route path="/request-access" element={<RequestAccess />} />
          <Route
            path="/audit"
            element={
              <RequireGuard guard="admin">
                <Audit />
              </RequireGuard>
            }
          />
          <Route
            path="/activity"
            element={
              <RequireGuard guard="admin">
                <Activity />
              </RequireGuard>
            }
          />
          <Route
            path="/settings"
            element={
              <RequireGuard guard="admin">
                <SettingsLayout />
              </RequireGuard>
            }
          />
          {/* The deployment's own administration: a global admin, or in single mode the
              organisation's owner/admin (`canAdministerPlatform`; server `/api/platform/*`). */}
          <Route
            path={PLATFORM_SETTINGS_PATH}
            element={
              <RequireGuard guard="platformAdmin">
                <PlatformLayout />
              </RequireGuard>
            }
          >
            <Route index element={<Navigate to={PLATFORM_SETUP_PATH} replace />} />
            <Route path="setup" element={<Setup />} />
            <Route path="identity" element={<Identity />} />
            <Route path="access-requests" element={<AccessRequests />} />
          </Route>
          {/* The three screens that moved out of /admin — old links and bookmarks keep working. */}
          <Route path="/admin/setup" element={<Moved to={PLATFORM_SETUP_PATH} />} />
          <Route path="/admin/identity" element={<Moved to={PLATFORM_IDENTITY_PATH} />} />
          <Route
            path="/admin/access-requests"
            element={<Moved to={PLATFORM_ACCESS_REQUESTS_PATH} />}
          />
          {/* The operator's cross-tenant area: global admins only, in every mode. */}
          <Route
            path="/admin"
            element={
              <RequireGuard guard="globalAdmin">
                <AdminLayout />
              </RequireGuard>
            }
          >
            <Route index element={<Navigate to="/admin/tenants" replace />} />
            <Route path="tenants" element={<TenantList />} />
            <Route path="tenants/:id" element={<TenantDetail />} />
            <Route path="users" element={<UserList />} />
            <Route path="users/:id" element={<UserDetail />} />
            <Route path="feature-flags" element={<FeatureFlags />} />
            <Route path="sessions" element={<SessionsAdmin />} />
          </Route>
          {pluginRoutes('shell')}
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
    </Layout>
  )
}

/** Signed in, tenant optional — the holding pages. */
function NoTenantRoute({ children }: { children: React.ReactNode }) {
  return (
    <ProtectedRoute requireTenant={false}>
      <Suspense fallback={<LoadingIndicator size="lg" centered />}>{children}</Suspense>
    </ProtectedRoute>
  )
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        path="/magic-link/sent"
        element={
          <Suspense fallback={<LoadingIndicator size="lg" centered />}>
            <MagicLinkSent />
          </Suspense>
        }
      />
      <Route
        path="/invite/:token"
        element={
          <Suspense fallback={<LoadingIndicator size="lg" centered />}>
            <InviteAccept />
          </Suspense>
        }
      />
      <Route
        path="/select-tenant"
        element={
          <NoTenantRoute>
            <SelectTenant />
          </NoTenantRoute>
        }
      />
      <Route
        path="/pending"
        element={
          <NoTenantRoute>
            <Pending />
          </NoTenantRoute>
        }
      />
      <Route
        path="/no-access"
        element={
          <NoTenantRoute>
            <NoAccess />
          </NoTenantRoute>
        }
      />
      {pluginRoutes('public')}
      {pluginRoutes('noTenant')}
      <Route
        path="/*"
        element={
          <ProtectedRoute>
            <ShellRoutes />
          </ProtectedRoute>
        }
      />
    </Routes>
  )
}

export default function App() {
  return (
    <ErrorBoundary fullPage>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <AbilityProvider>
            <WebSocketProvider>
              <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
                <NavigationBridge />
                <ScrollToTop />
                <AppRoutes />
                <ToastContainer />
              </BrowserRouter>
            </WebSocketProvider>
          </AbilityProvider>
        </AuthProvider>
        {ReactQueryDevtools && (
          <Suspense fallback={null}>
            <ReactQueryDevtools
              initialIsOpen={false}
              buttonPosition="bottom-right"
              position="right"
            />
          </Suspense>
        )}
      </QueryClientProvider>
    </ErrorBoundary>
  )
}
