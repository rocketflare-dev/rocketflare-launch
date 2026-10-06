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
import { BrowserRouter, Route, Routes } from 'react-router-dom'
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
import ScrollToTop from '@/ui/components/ScrollToTop'
import { settingsRoutes } from '@/ui/components/SettingsRoutes'
import { ToastContainer } from '@/ui/components/shared'
import { TenantFooter } from '@/ui/components/TenantFooter'
import { UserMenu } from '@/ui/components/UserMenu'
import { WebSocketProvider } from '@/ui/components/WebSocketProvider'
import { WebSocketStatus } from '@/ui/components/WebSocketStatus'
import { AuthProvider } from '@/ui/hooks/useAuth'
import { AGENTS_GUARD, CHAT_GUARD, KNOWLEDGE_GUARD } from '@/ui/lib/feature-guards'
import { NavigationBridge } from '@/ui/lib/navigation'
import { queryClient } from '@/ui/lib/queryClient'
import Login from '@/ui/pages/Login'
import NotFound from '@/ui/pages/NotFound'

// Public / no-tenant pages
const MagicLinkSent = lazy(() => import('@/ui/pages/MagicLinkSent'))
const InviteAccept = lazy(() => import('@/ui/pages/InviteAccept'))
const SelectTenant = lazy(() => import('@/ui/pages/SelectTenant'))
const Pending = lazy(() => import('@/ui/pages/Pending'))
const NoAccess = lazy(() => import('@/ui/pages/NoAccess'))
// Shell pages. Home is lazy too: its overview reuses the app page's and the inbox's models.
const Home = lazy(() => import('@/ui/pages/Home'))
const Profile = lazy(() => import('@/ui/pages/Profile'))
const Notifications = lazy(() => import('@/ui/pages/Notifications'))
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
// One app: Overview + tabs (sessions, releases, activity, settings — config and access included).
const AppPage = lazy(() => import('@/ui/pages/apps/AppPage'))
// Launch P3: a coding session — chat + live preview. Its own chunk: it carries `Markdown`.
const SessionPage = lazy(() => import('@/ui/pages/sessions/SessionPage'))
// Launch P4: the approvals inbox and one request (notifications link to it).
const ApprovalsInboxPage = lazy(() => import('@/ui/pages/approvals/InboxPage'))
const ApprovalPage = lazy(() => import('@/ui/pages/approvals/ApprovalPage'))
// Launch P5: Secrets (shared config) — the bundles and one resource (an app's config is its Settings tab).
const SharedConfigPage = lazy(() => import('@/ui/pages/shared-config/SharedConfigPage'))
const SharedResourcePage = lazy(() => import('@/ui/pages/shared-config/SharedResourcePage'))
const RequestAccess = lazy(() => import('@/ui/pages/RequestAccess'))

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
          {/* The kit's AI surfaces (Chat, Agents, Knowledge, Search) are behind `kit-ai`, off in
              every Launch deployment for now: each guard is its nav item's (`feature-guards`). */}
          <Route
            path="/chat/:conversationId?"
            element={
              <RequireGuard guard={CHAT_GUARD}>
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
              <RequireGuard guard={AGENTS_GUARD}>
                <AgentsPage />
              </RequireGuard>
            }
          />
          <Route
            path="/agents/runs/:runId"
            element={
              <RequireGuard guard={AGENTS_GUARD}>
                <RunPage />
              </RequireGuard>
            }
          />
          <Route
            path="/documents"
            element={
              <RequireGuard guard={KNOWLEDGE_GUARD}>
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
              <RequireGuard guard={KNOWLEDGE_GUARD}>
                <DocumentViewPage />
              </RequireGuard>
            }
          />
          <Route
            path="/search"
            element={
              <RequireGuard guard={KNOWLEDGE_GUARD}>
                <SearchPage />
              </RequireGuard>
            }
          />
          {/* Launch (spec/06): the catalogue and one app are every member's (`read App`); what
              each reader may DO on an app (ship, request config, manage access) the page hides
              and the server decides. The app's tabs — and the old `/config` and `/access`, which
              redirect into its Settings — are nested routes in `AppPage`. */}
          <Route
            path="/apps"
            element={
              <RequireGuard guard={{ action: 'read', subject: 'App' }}>
                <CataloguePage />
              </RequireGuard>
            }
          />
          <Route
            path="/apps/:slug/*"
            element={
              <RequireGuard guard={{ action: 'read', subject: 'App' }}>
                <AppPage />
              </RequireGuard>
            }
          />
          {/* Ranked above the splat: a session keeps its own chunk (it carries `Markdown`). */}
          <Route
            path="/apps/:slug/sessions/:id"
            element={
              <RequireGuard guard={{ action: 'read', subject: 'Session' }}>
                <SessionPage />
              </RequireGuard>
            }
          />
          {/* Launch P5 (spec/09): Secrets (shared resources) — every member reads the list (they
              need it to ask); owners and admins act, which the page and the server decide per
              resource. It was "Shared config" at `/shared-config`; old links redirect. */}
          <Route
            path="/secrets"
            element={
              <RequireGuard guard={{ action: 'read', subject: 'SharedResource' }}>
                <SharedConfigPage />
              </RequireGuard>
            }
          />
          <Route path="/shared-config" element={<Moved to="/secrets" />} />
          <Route
            path="/shared-config/:id"
            element={<Moved to={({ id = '' }) => `/secrets/${encodeURIComponent(id)}`} />}
          />
          <Route
            path="/secrets/:id"
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
          {/* Settings is one place (`pages/settings/SettingsLayout.tsx`): the organisation's own
              settings, the deployment's (`platformAdmin`), the operator's (`globalAdmin`) and
              Audit, each section behind its own guard. Everything it replaced redirects. */}
          {settingsRoutes()}
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
