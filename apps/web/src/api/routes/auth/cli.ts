/**
 * `GET /auth/cli?redirect_uri=` (D26): the browser-based CLI login. `redirect_uri` MUST be a
 * loopback `http://127.0.0.1:<port>/callback` or `http://localhost:<port>/callback` — that
 * allowlist is what makes handing the key over in a query string acceptable. No session → the
 * login page with a `returnUrl` back here; session but no tenant → `/select-tenant`; otherwise
 * mint a tenant API key named `cli:<hostname>` (scopes `['*']`, via the same helper `POST /api/keys`
 * uses) and 302 to `redirect_uri?key=&tenant_id=&tenant_name=`. The key is never logged.
 *
 * `&scope=admin` (`launch login --admin`) asks for an ADMIN key — the one credential besides the
 * cookie that `/api/admin/*` and `/api/platform/*` accept. Honoured only when the signed-in person
 * passes `canAdministerPlatform` right now (the gate `platformAdminMiddleware` applies; `/api/admin`
 * additionally re-checks the global flag per request); anyone else is sent back to the CLI with
 * `?error=admin_key_forbidden` and nothing is minted. The key is `cli-admin:<hostname>`, scope
 * `admin`, and expires after `ADMIN_API_KEY_TTL_DAYS` — a credential this strong never lives forever.
 * Recorded like every key: `api_key.created` (activity + audit chain) with `scope: 'admin'`.
 * Any other `scope` value is a 400.
 */
import { ADMIN_API_KEY_TTL_DAYS, apiKeyAccessScopeSchema } from '@launch/shared/api-keys'
import { canAdministerPlatform } from '../../../permissions'
import { mintApiKey } from '../../auth/api-keys'
import { resolveCookieAuth } from '../../middleware/auth'
import { recordActivity } from '../../services/activity'
import { BadRequestError } from '../../utils/core/errors'
import { makeDefer } from '../../utils/routes/route-helpers'
import { createRouter } from '../../utils/routes/router'

export const cliAuthRouter = createRouter()

/** `http://127.0.0.1:<port>/callback` | `http://localhost:<port>/callback`, nothing else. */
export function validateCliRedirectUri(value: string | undefined): URL | null {
  if (!value) return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'http:') return null
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') return null
  if (url.pathname !== '/callback') return null
  if (url.search || url.hash || url.username || url.password) return null
  return url
}

/** The CLI's error code when a non-administrator asks for `scope=admin`. */
export const ADMIN_KEY_FORBIDDEN = 'admin_key_forbidden'

function keyName(hostname: string | undefined, admin: boolean): string {
  const clean = (hostname ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '')
    .slice(0, 64)
  return `${admin ? 'cli-admin' : 'cli'}:${clean || 'cli'}`
}

cliAuthRouter.get('/cli', async c => {
  const redirectUri = validateCliRedirectUri(c.req.query('redirect_uri'))
  if (!redirectUri) {
    throw new BadRequestError(
      'redirect_uri must be http://127.0.0.1:<port>/callback or http://localhost:<port>/callback',
      'invalid_redirect_uri'
    )
  }
  const scopeParam = c.req.query('scope')
  const parsedScope = apiKeyAccessScopeSchema.safeParse(scopeParam ?? 'tenant')
  if (!parsedScope.success) {
    throw new BadRequestError('scope must be tenant or admin', 'invalid_scope')
  }
  const admin = parsedScope.data === 'admin'
  const hostname = c.req.query('hostname')
  // The login / select-tenant round trip comes back here with everything the CLI asked for.
  const back = new URLSearchParams({ redirect_uri: redirectUri.toString() })
  if (hostname) back.set('hostname', hostname)
  if (admin) back.set('scope', 'admin')
  const returnUrl = `/auth/cli?${back.toString()}`
  const auth = await resolveCookieAuth(c)
  if (!auth) return c.redirect(`/login?returnUrl=${encodeURIComponent(returnUrl)}`, 302)
  if (!auth.tenantId || !auth.tenant) {
    return c.redirect(`/select-tenant?returnUrl=${encodeURIComponent(returnUrl)}`, 302)
  }

  if (admin && !canAdministerPlatform(auth, c.get('config'))) {
    const refused = new URL(redirectUri.toString())
    refused.searchParams.set('error', ADMIN_KEY_FORBIDDEN)
    return c.redirect(refused.toString(), 302)
  }

  const db = c.get('db')
  const { row, plaintext } = await mintApiKey(db, {
    tenantId: auth.tenantId,
    createdByUserId: auth.user.id,
    name: keyName(hostname, admin),
    scopes: ['*'],
    scope: admin ? 'admin' : 'tenant',
    expiresAt: admin ? new Date(Date.now() + ADMIN_API_KEY_TTL_DAYS * 86_400_000) : null,
  })
  makeDefer(c)(() =>
    recordActivity(db, {
      tenantId: row.tenantId,
      userId: auth.user.id,
      type: 'api_key.created',
      subjectType: 'ApiKey',
      subjectId: row.id,
      // `api_key.created` also lands in the audit chain (`recordActivity`); the scope says which.
      metadata: {
        name: row.name,
        via: 'cli',
        scope: row.scope,
        expiresAt: row.expiresAt?.toISOString() ?? null,
      },
    })
  )

  const target = new URL(redirectUri.toString())
  target.searchParams.set('key', plaintext)
  target.searchParams.set('tenant_id', auth.tenantId)
  target.searchParams.set('tenant_name', auth.tenant.name)
  return c.redirect(target.toString(), 302)
})
