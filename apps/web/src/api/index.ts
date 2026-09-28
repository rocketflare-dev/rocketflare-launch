/**
 * Hono app assembly (04 §10, D5, D13). Middleware order is load-bearing — see
 * middleware/CLAUDE.md before reordering. `export { app }` only: the Worker entry
 * (`src/worker.ts`) adds `queue`/`scheduled`, and tests drive `app.request(path, init, env, ctx)`
 * without dragging Worker-only classes into Node.
 */

import type { Hono, MiddlewareHandler } from 'hono'
import { serverPlugins } from '../plugins/server'
import { authMiddleware, globalAdminMiddleware } from './middleware/auth'
import { ciBodyLimit, isUploadPath, jsonBodyLimit } from './middleware/body-limit'
import { configMiddleware } from './middleware/config'
import { corsMiddleware } from './middleware/cors'
import { csrfProtection } from './middleware/csrf'
import { databaseMiddleware } from './middleware/database'
import { errorHandler, notFoundBody, notFoundHandler } from './middleware/error-handler'
import { authRateLimit } from './middleware/rate-limit'
import { requestIdMiddleware, requestLogger } from './middleware/request-logger'
import { securityHeaders } from './middleware/security-headers'
import { tracerMiddleware } from './middleware/tracing'
import { accessRequestsRouter } from './routes/access-requests'
import { activityRouter } from './routes/activity'
import { adminRouter } from './routes/admin'
import { adminApprovalPoliciesRouter } from './routes/admin-approval-policies'
import { adminSessionsRouter } from './routes/admin-sessions'
import { agentsRouter } from './routes/agents'
import { aguiRouter } from './routes/agui'
import { aiAgentModelsRouter } from './routes/ai-agent-models'
import { aiConfigRouter } from './routes/ai-config'
import { aiDocumentsRouter } from './routes/ai-documents'
import { aiPromptsRouter } from './routes/ai-prompts'
import { aiUsageRouter } from './routes/ai-usage'
import { appAccessRouter } from './routes/app-access'
import { approvalsRouter } from './routes/approvals'
import { appsRouter } from './routes/apps'
import { auditRouter } from './routes/audit'
import { authRouter } from './routes/auth/index'
import { chatRouter } from './routes/chat'
import { ciRouter } from './routes/ci'
import { evalsRouter } from './routes/evals'
import { featuresRouter } from './routes/features'
import { feedbackRouter } from './routes/feedback'
import { filesRouter } from './routes/files'
import { groupsRouter } from './routes/groups'
import { healthRouter } from './routes/health'
import { invitationsRouter } from './routes/invitations'
import { inviteRouter } from './routes/invite'
import { keysRouter } from './routes/keys'
import { meRouter } from './routes/me'
import { membersRouter } from './routes/members'
import { notificationsRouter } from './routes/notifications'
import { oidcRouter, wellKnownRouter } from './routes/oidc'
import { oidcAdminRouter } from './routes/oidc-admin'
import { sessionsRouter } from './routes/sessions'
import { setupRouter } from './routes/setup'
import { tenantRouter } from './routes/tenant'
import { tenantsRouter } from './routes/tenants'
import { tracesRouter } from './routes/traces'
import { wsRouter } from './routes/ws'
import type { AppEnv } from './types'
import { isApiPath } from './utils/routes/api-prefixes'
import { createRouter } from './utils/routes/router'

const app = createRouter()

// 1. Error envelope first so every later failure (including config validation) uses it.
app.onError(errorHandler)
app.notFound(notFoundHandler)

/**
 * The runtime's own namespace, answered BEFORE the logger so it never reaches the app at all.
 * `wrangler dev` sends its reload control to the Worker on `/cdn-cgi/ProxyWorker/pause|play`
 * whenever its internal auth header does not match the ProxyWorker's, and the SPA catch-all used to
 * answer those with `index.html` and a 200 — wrong, and a stream of `GET /cdn-cgi/ProxyWorker/pause
 * 200` lines burying the app's own in the dev log. Cloudflare answers `/cdn-cgi/*` at the edge in
 * production, so nothing legitimate arrives here. Miniflare's own endpoints (`/cdn-cgi/local/…`,
 * the local cron trigger) never reach the Worker — it handles them itself.
 */
app.all('/cdn-cgi/*', c => c.body(null, 404))

// 2–4. Request id + logger → validated config → security headers (wraps everything below).
app.use('*', requestIdMiddleware, requestLogger)
app.use('*', configMiddleware)
app.use('*', securityHeaders)

// 5. Reject oversized bodies before any parsing or DB work. The upload route mounts its own
//    (larger) limit — see middleware/body-limit.ts.
app.use('/api/*', (c, next) => (isUploadPath(c.req.path) ? next() : jsonBodyLimit(c, next)))
app.use('/auth/*', jsonBodyLimit)
// Launch's OIDC issuer (spec/05) is a protocol surface outside `/api`; its token and userinfo
// bodies are small forms, and nothing under it accepts an upload.
app.use('/oidc/*', jsonBodyLimit)
// Launch P2's GitHub-OIDC surface: 64 MB on the deployer's `upload` (a whole build as base64
// JSON), the JSON cap on everything else under it.
app.use('/ci/*', ciBodyLimit)

// 6–7. CORS answers preflights before CSRF can reject them; CSRF is cookie-only, no DB.
app.use('*', corsMiddleware)
app.use('*', csrfProtection)

// 8. Per-request DB client — last of the globals because it is the first thing with real cost.
app.use('*', databaseMiddleware)

// 9. Per-request tracer (D32): OTLP export when a backend is configured + the `ai_spans` store; flushed in
//    `waitUntil` after the handler. Streaming routes flush again before their stream closes.
app.use('/api/*', tracerMiddleware)

// 10. Mounts — auth is applied PER MOUNT so the public surface is enumerable: health, /auth/*,
//    /api/invite/:token (details; accept resolves the cookie itself). `/api/admin/*` is the only
//    tenant-free cross-tenant path (globalAdminMiddleware); everything else is `authMiddleware`.
app.route('/api', healthRouter)
app.route('/auth', authRouter)
// Launch as the company's OIDC issuer (spec/05). PUBLIC by design: discovery and the JWKS are
// anonymous, `/oidc/authorize` resolves the session cookie itself (as `/auth/cli` does), and
// `/oidc/token` / `/oidc/userinfo` authenticate the client or the access token, never a session.
// No `authRateLimit` on the token endpoint either — every app calls it from Cloudflare's shared
// egress, so an IP key would throttle the whole fleet as one caller.
app.route('/.well-known', wellKnownRouter)
app.route('/oidc', oidcRouter)
// Launch P2: the GitHub-OIDC surface (the deployer protocol, the scaffold job). PUBLIC by design:
// a CI job has no session. Every route beneath verifies the job's GitHub OIDC token and resolves
// the calling repo, environment and workflow before it touches a row (`routes/ci.ts`).
app.route('/ci', ciRouter)
app.use('/api/invite/:token/accept', authRateLimit)
app.route('/api/invite', inviteRouter)
app.use('/api/admin/*', globalAdminMiddleware)
// Launch's platform administration (spec/03, spec/05) — mounted BEFORE the kit's admin router so
// its prefixes are matched first. Both sit behind the `globalAdminMiddleware` above: the setup
// credentials and the issuer's signing keys belong to the deployment, not to an organisation.
app.route('/api/admin/setup', setupRouter)
app.route('/api/admin/oidc', oidcAdminRouter)
// Launch P3: live coding sessions and the drain before a deploy that touches the session image.
app.route('/api/admin/sessions', adminSessionsRouter)
app.route('/api/admin', adminRouter)
// WebSocket upgrade resolves the cookie itself (no authMiddleware: browsers can't set headers here).
app.route('/ws', wsRouter)
// A mount may carry a third element: a feature gate (D30). `requireFeature('x')` 404s
// `feature_disabled` on every route beneath the prefix, so a surface that ships dark is dark as a
// WHOLE rather than route by route — declared once here, like auth, instead of remembered in each
// handler. The kit ships no gated mount; an app adds `['/api/thing', thingRouter, requireFeature('thing')]`.
// Remember the other doors too: a surface with no nav entry (an analytics cube, a dashboard
// template, a CLI command) leaks independently of this one.
// D34: a plugin's PUBLIC mounts — consent callbacks and webhooks a third party calls with no
// session. Only under `/api/hooks/<plugin id>` (the config test refuses anything else, and refuses
// an authed mount there), so this line is the whole of the plugin-owned unauthenticated surface.
// Before the authed table, which never claims `/api/hooks`, so order is belt and braces.
for (const [prefix, router] of serverPlugins.flatMap(p => p.publicMounts ?? [])) {
  app.route(prefix, router)
}
const mounts: readonly (readonly [string, Hono<AppEnv>, MiddlewareHandler?])[] = [
  ['/api/me', meRouter],
  ['/api/tenant', tenantRouter],
  ['/api/tenants', tenantsRouter],
  ['/api/members', membersRouter],
  ['/api/groups', groupsRouter],
  ['/api/features', featuresRouter],
  ['/api/invitations', invitationsRouter],
  ['/api/keys', keysRouter],
  ['/api/notifications', notificationsRouter],
  ['/api/activity', activityRouter],
  ['/api/access-requests', accessRequestsRouter],
  ['/api/files', filesRouter],
  ['/api/ai/config', aiConfigRouter],
  ['/api/ai/prompts', aiPromptsRouter],
  ['/api/ai/usage', aiUsageRouter],
  ['/api/ai/agent-models', aiAgentModelsRouter],
  ['/api/ai/documents', aiDocumentsRouter],
  ['/api/chat', chatRouter],
  // A protocol surface with its own auth story, mounted beside chat rather than under it: this
  // list is the enumerable auth surface (D13).
  ['/api/agui', aguiRouter],
  ['/api/agents', agentsRouter],
  // D32: the local AI trace store, read by `launch traces` — admin+ (`read Trace`).
  ['/api/traces', tracesRouter],
  // D33: thumbs on AI answers (member create; admin+ read) and the eval-case export (admin+).
  ['/api/feedback', feedbackRouter],
  ['/api/evals', evalsRouter],
  // Launch (spec/05, 06, 08): the app registry, who may sign in to each app, and the audit log.
  ['/api/apps', appsRouter],
  ['/api/app-access', appAccessRouter],
  ['/api/audit', auditRouter],
  // Launch P3 (spec/07): one coding session by id — lifecycle, chat, ship (three routers, one
  // prefix). Starting one is `POST /api/apps/:id/sessions`.
  ['/api/sessions', sessionsRouter],
  // Launch P4 (spec/08): the approvals inbox and decisions, and the organisation's approval
  // policies — an ORGANISATION admin's settings, so behind `authMiddleware` + `manage
  // ApprovalPolicy` rather than under `/api/admin` (global admins only). An app's releases are
  // `/api/apps/:id/releases` (`app-releases.ts`, mounted by `apps.ts`).
  ['/api/approvals', approvalsRouter],
  ['/api/approval-policies', adminApprovalPoliciesRouter],
  // D31: installed plugins, last, so a plugin can never shadow a kit prefix — Hono matches in
  // registration order. Each mount gets `authMiddleware` and its own optional gate exactly like a
  // kit mount; the convention is `/api/<plugin id>`, and `tests/config/plugins.test.ts` is what
  // keeps two plugins from claiming the same one.
  ...serverPlugins.flatMap(p => p.mounts ?? []),
]
for (const [prefix, router, gate] of mounts) {
  app.use(prefix, authMiddleware)
  app.use(`${prefix}/*`, authMiddleware)
  // After auth, never before: the gate reads `auth.features`, which `authMiddleware` sets.
  if (gate) {
    app.use(prefix, gate)
    app.use(`${prefix}/*`, gate)
  }
  app.route(prefix, router)
}

// 11. SPA via Workers Static Assets. Hashed files are served by the assets layer before the
//     Worker runs; only navigations reach here. `not_found_handling = "single-page-application"`
//     makes ASSETS return index.html for client routes. API-shaped paths must 404 as JSON.
app.all('*', c => {
  const { pathname } = new URL(c.req.url)
  if (isApiPath(pathname)) return c.json(notFoundBody(pathname), 404)
  if (c.env.ASSETS) return c.env.ASSETS.fetch(c.req.raw)
  // No ASSETS binding (Vite serves the UI in dev, or a bare `app.request` in tests).
  return c.text('Not Found', 404)
})

export { app }
