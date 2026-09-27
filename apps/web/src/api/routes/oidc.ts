/**
 * Launch as the company's OIDC issuer (spec/05) — the PUBLIC protocol surface every app calls.
 * Mounted outside `/api` with no `authMiddleware`: `/.well-known/*` is anonymous by definition,
 * `/oidc/authorize` reads the session cookie itself (like `/auth/cli`), and `/oidc/token` /
 * `/oidc/userinfo` authenticate the CLIENT or the access token, not a Launch session.
 *
 * Ported from the S6 spike (`spikes/s6-oidc-issuer`), with what it left for production: codes in
 * Postgres (hashed, single-use, replay REVOKES the first redemption's access token), signing-key
 * rotation, the per-app access policy with a request-access page, and an audit row per decision.
 *
 * The rules this file keeps, and where:
 *
 * - **Never redirect to an unregistered URI.** An unknown or disabled client, or a `redirect_uri`
 *   that is not an exact string match for a registered one, gets an HTML error page and no
 *   redirect (RFC 6749 §4.1.2.1). Only after both check out do errors go back to the app, always
 *   with `state` and `iss` (RFC 9207). `post_logout_redirect_uri` is held to the same rule.
 * - **Errors are RFC 6749 / OIDC Core shaped** (`{ error, error_description }`), not the kit
 *   envelope: a relying party's OAuth library parses these, so this file answers them by hand
 *   rather than by throwing the kit's typed errors. Every token and userinfo response is
 *   `Cache-Control: no-store`.
 * - **Code flow + PKCE S256 only.** No implicit or hybrid flow, no `plain` challenge, no request
 *   objects; unknown scopes are dropped (RFC 6749 §3.3).
 * - **No `authRateLimit`** on the token endpoint: every app calls it from Cloudflare's shared
 *   egress, so an IP key would throttle the whole fleet as one caller (`api/index.ts`).
 *
 * `prompt=login` and a `max_age` the session is older than END the Launch session and send the
 * person to sign in again (`reauthenticate`); with `prompt=none` that is `login_required`.
 *
 * Known gaps (spec/05): a re-authentication ends the person's Launch session (the login page has
 * no "sign in again while signed in" mode), and when Launch itself signs in through an upstream
 * OIDC issuer that issuer may answer silently from its own session — `prompt=login` is not
 * forwarded upstream; there are no refresh tokens; the authorization endpoint answers GET only,
 * because a cross-site POST that carries the session cookie is refused by the CSRF middleware —
 * for the same reason RP-initiated logout is GET (a form POST is the confirmation page's own).
 */
import type { Database } from '../../db/client'
import type { OidcClientRow } from '../../db/schema'
import { clearSessionCookie, readSessionToken } from '../auth/cookies'
import { deleteSession, resolveSession } from '../auth/sessions'
import { resolveCookieAuth } from '../middleware/auth'
import { listUserGroups } from '../services/groups'
import { auditActor, recordAudit } from '../services/launch/audit'
import {
  CODE_RETENTION_S,
  CODE_TTL_S,
  discoveryDocument,
  issuerOf,
  SUPPORTED_SCOPES,
} from '../services/oidc/discovery'
import { jwks } from '../services/oidc/keys'
import { evaluateAccess } from '../services/oidc/policy'
import {
  consumeCode,
  findClientByClientId,
  findCodeByAccessTokenJti,
  findCodeByHash,
  findUser,
  insertCode,
  pruneExpiredCodes,
  recordAccessTokenJti,
  revokeCode,
  sessionCreatedAt,
} from '../services/oidc/store'
import {
  CODE_CHALLENGE_RE,
  clientSecretMatches,
  identityClaims,
  issueTokens,
  verifyAccessToken,
  verifyIdTokenHint,
  verifyPkce,
} from '../services/oidc/tokens'
import type { AppContext, AuthContext } from '../types'
import { ForbiddenError } from '../utils/core/errors'
import { hashToken } from '../utils/core/hash'
import { randomToken } from '../utils/core/ids'
import { makeDefer } from '../utils/routes/route-helpers'
import { createRouter } from '../utils/routes/router'

/** `/oidc/*` — authorize, token, userinfo, logout. */
export const oidcRouter = createRouter()

/** `/.well-known/*` — discovery and the JWKS. */
export const wellKnownRouter = createRouter()

const NO_STORE = { 'Cache-Control': 'no-store', Pragma: 'no-cache' } as const
/** Public metadata: cacheable briefly, readable from any origin (a browser-side client may fetch it). */
const PUBLIC_METADATA = {
  'Cache-Control': 'public, max-age=300',
  'Access-Control-Allow-Origin': '*',
} as const

const NONCE_MAX = 512
const STATE_MAX = 2048

// ---- Discovery -----------------------------------------------------------------------------

wellKnownRouter.get('/openid-configuration', c =>
  c.json(discoveryDocument(c.get('config')), 200, PUBLIC_METADATA)
)

wellKnownRouter.get('/jwks.json', async c =>
  c.json(await jwks(c.get('db'), c.get('config')), 200, PUBLIC_METADATA)
)

// ---- Helpers -------------------------------------------------------------------------------

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`)

/**
 * The issuer's own pages — an error that must not go back to the app, the logout confirmation —
 * are plain server-rendered HTML, not the SPA: they answer before (or without) a Launch session,
 * and a relying party may land on them from anywhere. Styled inline in the Afterburner palette
 * (the CSP allows inline styles, never inline scripts), light or dark with the system.
 *
 * No `no-referrer` policy here: under it a browser sends `Origin: null` with the confirmation
 * form's POST, and the CSRF middleware (rightly) refuses an origin it cannot match.
 */
const PAGE_STYLE = `:root{color-scheme:light dark;--bg:#faf7f2;--panel:#fff;--text:#1c1917;--muted:#57534e;--line:#dcd4cb;--primary:#c2410c;--on-primary:#fff}@media (prefers-color-scheme:dark){:root{--bg:#120d1f;--panel:#1d1630;--text:#f5f3ff;--muted:#d6d1e6;--line:#3d3358;--primary:#ff7a45;--on-primary:#1a0b05}}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}main{width:min(26rem,calc(100vw - 2rem));background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:1.75rem}.brand{font-weight:600;letter-spacing:.02em;color:var(--primary);margin:0 0 1rem}h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:0 0 1rem;color:var(--muted)}form{display:flex;gap:.5rem;margin:0}button,a.button{font:inherit;cursor:pointer;border-radius:5px;padding:.5rem 1rem;text-decoration:none}button{background:var(--primary);color:var(--on-primary);border:1px solid var(--primary)}a.button{border:1px solid var(--line);color:var(--text)}`

function htmlPage(
  c: AppContext,
  status: 200 | 400,
  title: string,
  message: string,
  extra: { body?: string; head?: string } = {}
) {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${extra.head ?? ''}<title>${escapeHtml(title)} · Launch</title><style>${PAGE_STYLE}</style></head><body><main><p class="brand">Launch</p><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>${extra.body ?? ''}</main></body></html>`
  return c.html(body, status, NO_STORE)
}

/** RFC 6749 §5.2 error body. `invalid_client` carries the challenge the RFC requires. */
function tokenError(c: AppContext, status: 400 | 401, error: string, description: string) {
  const headers: Record<string, string> = { ...NO_STORE }
  if (status === 401) headers['WWW-Authenticate'] = 'Basic realm="launch", charset="UTF-8"'
  return c.json({ error, error_description: description }, status, headers)
}

/** RFC 6750 §3: a Bearer challenge; no error code when no token was sent at all. */
function bearerError(c: AppContext, error?: 'invalid_token' | 'invalid_request') {
  const challenge = error ? `Bearer realm="launch", error="${error}"` : 'Bearer realm="launch"'
  return c.body(null, 401, { ...NO_STORE, 'WWW-Authenticate': challenge })
}

/** A parameter sent more than once is an error for OAuth endpoints (RFC 6749 §3.1, §3.2). */
function repeatedParam(params: URLSearchParams): string | null {
  const seen = new Set<string>()
  for (const key of params.keys()) {
    if (seen.has(key)) return key
    seen.add(key)
  }
  return null
}

/** `application/x-www-form-urlencoded` decoding of one Basic credential half (RFC 6749 §2.3.1). */
function formDecode(value: string): string | null {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '))
  } catch {
    return null
  }
}

function clientTarget(client: Pick<OidcClientRow, 'clientId' | 'appId'>) {
  return { targetType: 'oidc_client', targetId: client.clientId, appId: client.appId }
}

// ---- Re-authentication (prompt=login, max_age) ----------------------------------------------

/**
 * The marker a forced re-authentication adds to the authorize URL it returns to: the time (unix
 * seconds) Launch sent the person to sign in again. A session that began after it satisfies
 * `prompt=login` and `max_age`, which is what stops `max_age=0` looping. A marker older than
 * `REAUTH_WINDOW_S` proves nothing, and one from the future matches no session; forging one only
 * weakens the request its forger built, and the id_token's `auth_time` still tells the app the
 * truth.
 */
export const REAUTH_PARAM = 'launch_reauth'
const REAUTH_WINDOW_S = 30 * 60
/** Worker and database clocks may disagree by a little; the session row is stamped by Postgres. */
const REAUTH_SKEW_S = 30

function reauthenticated(q: URLSearchParams, authTime: Date): boolean {
  const marker = Number(q.get(REAUTH_PARAM))
  if (!Number.isInteger(marker) || marker <= 0) return false
  const nowS = Date.now() / 1000
  if (nowS - marker > REAUTH_WINDOW_S || marker - nowS > REAUTH_SKEW_S) return false
  return authTime.getTime() / 1000 >= marker - REAUTH_SKEW_S
}

/**
 * Send the person to sign in again. The Launch session ENDS first — the login page forwards a
 * signed-in visitor straight back, so keeping it would loop — and the return URL drops
 * `prompt=login` and carries the marker.
 */
async function reauthenticate(c: AppContext, url: URL, sessionId: string) {
  await deleteSession(c.get('db'), sessionId)
  clearSessionCookie(c)
  const next = new URL(url)
  const prompt = (next.searchParams.get('prompt') ?? '')
    .split(' ')
    .filter(p => p && p !== 'login')
    .join(' ')
  if (prompt) next.searchParams.set('prompt', prompt)
  else next.searchParams.delete('prompt')
  next.searchParams.set(REAUTH_PARAM, String(Math.floor(Date.now() / 1000)))
  return c.redirect(`/login?returnUrl=${encodeURIComponent(`${next.pathname}${next.search}`)}`, 302)
}

// ---- Authorization endpoint ----------------------------------------------------------------

oidcRouter.get('/authorize', async c => {
  const cfg = c.get('config')
  const db = c.get('db')
  const url = new URL(c.req.url)
  const q = url.searchParams
  const iss = issuerOf(cfg)

  // 1. Who is asking, and where would we send the answer? Until both are proven, no redirect.
  const clientId = q.getAll('client_id')
  const redirectUri = q.getAll('redirect_uri')
  if (clientId.length !== 1 || !clientId[0]) {
    return htmlPage(c, 400, 'Sign-in error', 'The request did not name the app (client_id).')
  }
  const client = await findClientByClientId(db, clientId[0])
  if (!client || client.disabledAt) {
    return htmlPage(c, 400, 'Sign-in error', 'This app is not registered with Launch.')
  }
  if (
    redirectUri.length !== 1 ||
    !redirectUri[0] ||
    !client.redirectUris.includes(redirectUri[0])
  ) {
    return htmlPage(
      c,
      400,
      'Sign-in error',
      'The address this app asked Launch to return to is not one it registered.'
    )
  }
  const returnTo = redirectUri[0]
  const state = q.get('state')

  const back = (params: Record<string, string | undefined>) => {
    const target = new URL(returnTo)
    for (const [k, v] of Object.entries(params)) if (v) target.searchParams.set(k, v)
    if (state) target.searchParams.set('state', state)
    target.searchParams.set('iss', iss)
    return c.redirect(target.toString(), 302)
  }
  const fail = (error: string, description: string) =>
    back({ error, error_description: description })

  // 2. The request itself. From here on, errors go back to the app.
  const repeated = repeatedParam(q)
  if (repeated) return fail('invalid_request', `${repeated} was sent more than once`)
  if (q.has('request')) return fail('request_not_supported', 'Request objects are not supported')
  if (q.has('request_uri')) {
    return fail('request_uri_not_supported', 'request_uri is not supported')
  }
  if (q.get('response_type') !== 'code') {
    return fail('unsupported_response_type', 'Only the authorization code flow is supported')
  }
  const responseMode = q.get('response_mode')
  if (responseMode && responseMode !== 'query') {
    return fail('invalid_request', 'Only response_mode=query is supported')
  }
  const requested = (q.get('scope') ?? '').split(' ').filter(Boolean)
  if (!requested.includes('openid')) return fail('invalid_scope', 'The openid scope is required')
  const scope = requested
    .filter(
      (s, i) => (SUPPORTED_SCOPES as readonly string[]).includes(s) && requested.indexOf(s) === i
    )
    .join(' ')
  const challenge = q.get('code_challenge') ?? ''
  if (q.get('code_challenge_method') !== 'S256' || !CODE_CHALLENGE_RE.test(challenge)) {
    return fail('invalid_request', 'PKCE with code_challenge_method=S256 is required')
  }
  const nonce = q.get('nonce')
  if ((nonce && nonce.length > NONCE_MAX) || (state && state.length > STATE_MAX)) {
    return fail('invalid_request', 'nonce or state is too long')
  }
  const prompt = (q.get('prompt') ?? '').split(' ').filter(Boolean)
  const silent = prompt.includes('none')
  if (silent && prompt.length > 1) {
    return fail('invalid_request', 'prompt=none cannot be combined with other values')
  }
  const maxAgeParam = q.get('max_age')
  if (maxAgeParam !== null && !/^\d{1,9}$/.test(maxAgeParam)) {
    return fail('invalid_request', 'max_age must be a whole number of seconds')
  }
  const maxAge = maxAgeParam === null ? null : Number(maxAgeParam)

  // 3. Who is signed in to Launch? Nobody → the login page, which returns here.
  let auth: AuthContext | null
  try {
    auth = await resolveCookieAuth(c)
  } catch (err) {
    // A blocked account (or a suspended organisation) is a refusal, not a server error.
    if (err instanceof ForbiddenError) return fail('access_denied', 'Sign-in is not allowed')
    throw err
  }
  if (!auth) {
    if (silent) return fail('login_required', 'No Launch session')
    const here = `${url.pathname}${url.search}`
    return c.redirect(`/login?returnUrl=${encodeURIComponent(here)}`, 302)
  }
  const user = auth.user

  // 3b. Fresh enough? `prompt=login`, or a session older than `max_age`, means sign in again —
  // unless this request is the return from exactly that (see `reauthenticate`).
  const authTime = (await sessionCreatedAt(db, auth.session.id)) ?? new Date()
  // `max_age=0` is `prompt=login` (OIDC Core §3.1.2.1), whatever the clocks say.
  const tooOld =
    maxAge !== null && (maxAge === 0 || Date.now() - authTime.getTime() > maxAge * 1000)
  if ((prompt.includes('login') || tooOld) && !reauthenticated(q, authTime)) {
    if (silent) return fail('login_required', 'The Launch sign-in is older than max_age')
    return reauthenticate(c, url, auth.session.id)
  }

  // 4. May they use this app? The policy runs in the CLIENT's tenant, not the session's.
  const groups = await listUserGroups(db, client.tenantId, user.id)
  const decision = await evaluateAccess(db, {
    client,
    userId: user.id,
    groupIds: groups.map(g => g.id),
  })
  if (!decision.allowed) {
    await recordAudit(db, {
      tenantId: client.tenantId,
      ...auditActor(c, user),
      action: 'oidc.denied',
      ...clientTarget(client),
      summary: { after: { reason: decision.reason } },
    })
    // A member the policy does not admit may ask for access; anyone else is simply refused.
    if (silent || decision.reason !== 'not_granted') {
      return fail('access_denied', 'You do not have access to this app')
    }
    const params = new URLSearchParams({
      client_id: client.clientId,
      return: `${url.pathname}${url.search}`,
    })
    return c.redirect(`/request-access?${params}`, 302)
  }

  // 5. Issue a single-use code, stored hashed, bound to everything the token request must repeat.
  const code = randomToken(32)
  const now = Date.now()
  await insertCode(db, {
    tenantId: client.tenantId,
    clientRowId: client.id,
    codeHash: await hashToken(code),
    userId: user.id,
    sessionId: auth.session.id,
    redirectUri: returnTo,
    codeChallenge: challenge,
    nonce: nonce || null,
    scope,
    authTime,
    expiresAt: new Date(now + CODE_TTL_S * 1000),
  })
  await recordAudit(db, {
    tenantId: client.tenantId,
    ...auditActor(c, user),
    action: 'oidc.signin',
    ...clientTarget(client),
    summary: { after: { scope, via: decision.reason } },
  })
  makeDefer(c)(() =>
    pruneExpiredCodes(db, client.tenantId, new Date(now - CODE_RETENTION_S * 1000))
  )
  return back({ code })
})

// ---- Token endpoint ------------------------------------------------------------------------

/** client_secret_basic or client_secret_post — exactly one of them (RFC 6749 §2.3). */
async function authenticateClient(
  c: AppContext,
  db: Database,
  form: URLSearchParams
): Promise<OidcClientRow | Response> {
  const header = c.req.header('Authorization')
  let id: string | null
  let secrets: string[]
  if (header && /^basic\s/i.test(header)) {
    if (form.has('client_secret')) {
      return tokenError(c, 400, 'invalid_request', 'Use one client authentication method')
    }
    let raw: string
    try {
      raw = atob(header.replace(/^basic\s+/i, '').trim())
    } catch {
      return tokenError(c, 401, 'invalid_client', 'Client authentication failed')
    }
    const colon = raw.indexOf(':')
    if (colon < 0) return tokenError(c, 401, 'invalid_client', 'Client authentication failed')
    // RFC 6749 form-encodes both halves; some clients (arctic) send them verbatim. Accept either.
    const rawId = raw.slice(0, colon)
    const rawSecret = raw.slice(colon + 1)
    id = formDecode(rawId) ?? rawId
    secrets = [...new Set([rawSecret, formDecode(rawSecret) ?? rawSecret])]
    const bodyId = form.get('client_id')
    if (bodyId && bodyId !== id && bodyId !== rawId) {
      return tokenError(c, 400, 'invalid_request', 'client_id does not match the credentials')
    }
  } else {
    id = form.get('client_id')
    const secret = form.get('client_secret')
    secrets = secret ? [secret] : []
  }
  if (!id || secrets.length === 0) {
    return tokenError(c, 401, 'invalid_client', 'Client authentication failed')
  }
  const client = await findClientByClientId(db, id)
  // Every candidate is checked, hit or miss, so the timing does not say which half was wrong.
  const matches = await Promise.all(secrets.map(s => clientSecretMatches(client, s)))
  if (!client || client.disabledAt || !matches.some(Boolean)) {
    return tokenError(c, 401, 'invalid_client', 'Client authentication failed')
  }
  return client
}

oidcRouter.post('/token', async c => {
  const cfg = c.get('config')
  const db = c.get('db')
  const contentType = c.req.header('Content-Type') ?? ''
  if (!contentType.toLowerCase().startsWith('application/x-www-form-urlencoded')) {
    return tokenError(c, 400, 'invalid_request', 'Send the token request form-encoded')
  }
  const form = new URLSearchParams(await c.req.text())
  const repeated = repeatedParam(form)
  if (repeated) return tokenError(c, 400, 'invalid_request', `${repeated} was sent more than once`)

  const client = await authenticateClient(c, db, form)
  if (client instanceof Response) return client
  if (form.get('grant_type') !== 'authorization_code') {
    return tokenError(c, 400, 'unsupported_grant_type', 'Only authorization_code is supported')
  }
  const code = form.get('code')
  if (!code) return tokenError(c, 400, 'invalid_request', 'code is required')

  const invalidGrant = () =>
    tokenError(c, 400, 'invalid_grant', 'The code is invalid, expired or already used')
  const codeHash = await hashToken(code)
  const issued = await findCodeByHash(db, codeHash)
  // Another client's code is refused WITHOUT burning it: the rightful app may still redeem it.
  if (!issued || issued.clientRowId !== client.id) return invalidGrant()

  const row = await consumeCode(db, codeHash)
  if (!row) {
    // A REPLAY. Revoke what the first redemption issued (RFC 6749 §4.1.2): userinfo now refuses
    // its access token. Recorded once, however many times the code is replayed.
    if (await revokeCode(db, issued)) {
      await recordAudit(db, {
        tenantId: issued.tenantId,
        // The caller is the app (it authenticated as the client), not a person.
        ...auditActor(c, null),
        actorType: 'app',
        action: 'oidc.code_replayed',
        ...clientTarget(client),
        summary: { after: { userId: issued.userId, revoked: true } },
      })
    }
    return invalidGrant()
  }
  if (row.revokedAt || row.expiresAt.getTime() <= Date.now()) return invalidGrant()
  if (form.get('redirect_uri') !== row.redirectUri) {
    return tokenError(c, 400, 'invalid_grant', 'redirect_uri does not match the authorization')
  }
  if (!(await verifyPkce(form.get('code_verifier'), row.codeChallenge))) {
    return tokenError(c, 400, 'invalid_grant', 'PKCE verification failed')
  }

  // The person, as they are NOW: still a member, not blocked.
  const decision = await evaluateAccess(db, { client, userId: row.userId })
  const person = await findUser(db, row.userId)
  if (!person || person.blockedAt || decision.reason === 'not_member') return invalidGrant()
  const groups = await listUserGroups(db, row.tenantId, row.userId)

  const tokens = await issueTokens(db, cfg, {
    client,
    user: person,
    groups,
    scope: row.scope,
    nonce: row.nonce,
    authTime: row.authTime,
  })
  await recordAccessTokenJti(db, row, tokens.jti)
  return c.json(
    {
      access_token: tokens.accessToken,
      token_type: 'Bearer',
      expires_in: tokens.expiresIn,
      id_token: tokens.idToken,
      scope: row.scope,
    },
    200,
    NO_STORE
  )
})

// ---- UserInfo endpoint ---------------------------------------------------------------------

async function userinfo(c: AppContext) {
  const cfg = c.get('config')
  const db = c.get('db')
  const header = c.req.header('Authorization')
  let token: string | null = null
  if (header && /^bearer\s/i.test(header)) token = header.replace(/^bearer\s+/i, '').trim()
  if (!token && c.req.method === 'POST') {
    const contentType = c.req.header('Content-Type') ?? ''
    if (contentType.toLowerCase().startsWith('application/x-www-form-urlencoded')) {
      token = new URLSearchParams(await c.req.text()).get('access_token')
    }
  }
  if (!token) return bearerError(c)

  const claims = await verifyAccessToken(db, cfg, token)
  if (!claims) return bearerError(c, 'invalid_token')
  // Revoked by a replay of the code it came from, or issued from a code since pruned: refused.
  const origin = await findCodeByAccessTokenJti(db, claims.jti)
  if (!origin || origin.revokedAt || origin.userId !== claims.sub) {
    return bearerError(c, 'invalid_token')
  }
  const person = await findUser(db, origin.userId)
  const client = await findClientByClientId(db, claims.client_id)
  if (!person || person.blockedAt || !client || client.tenantId !== origin.tenantId) {
    return bearerError(c, 'invalid_token')
  }
  const decision = await evaluateAccess(db, { client, userId: person.id })
  if (decision.reason === 'not_member' || decision.reason === 'tenant_suspended') {
    return bearerError(c, 'invalid_token')
  }
  const groups = await listUserGroups(db, origin.tenantId, person.id)
  return c.json({ sub: person.id, ...identityClaims(person, groups, origin.scope) }, 200, NO_STORE)
}

oidcRouter.get('/userinfo', userinfo)
oidcRouter.post('/userinfo', userinfo)

// ---- RP-initiated logout -------------------------------------------------------------------

/**
 * OIDC RP-Initiated Logout 1.0. A GET that signs someone out is a cross-site request any page can
 * make, so the Launch session ends WITHOUT asking only when the request proves which app sent it:
 * an `id_token_hint` this issuer signed (any published key, retiring included; expiry is not
 * checked, as §2 allows), for a registered, enabled client, naming the person signed in (or with
 * nobody signed in). Anything else with a live session gets a confirmation page whose button is a
 * same-origin form POST — the CSRF middleware refuses a cross-site one carrying the session cookie
 * (`Sec-Fetch-Site`, then `Origin`), and the `SameSite=Lax` cookie is not sent on one anyway.
 *
 * Either way the browser is only ever sent to a `post_logout_redirect_uri` registered for that
 * client (exact match), with `state`. After the confirmation POST it is a page with a meta refresh
 * rather than a 302: the CSP's `form-action 'self'` also governs where a form's response
 * redirects, and the app is another origin.
 */
interface LogoutRequest {
  client: OidcClientRow | null
  /** The registered URI to return to, if the request named one of this client's. */
  target: string | null
  state: string | null
  /** The verified hint's subject, when an `id_token_hint` checked out. */
  hintSub: string | null
}

async function readLogoutRequest(c: AppContext, params: URLSearchParams): Promise<LogoutRequest> {
  const db = c.get('db')
  const hint = params.get('id_token_hint')
  let clientId = params.get('client_id')
  let hintSub: string | null = null
  if (hint) {
    const verified = await verifyIdTokenHint(db, c.get('config'), hint)
    // A hint for another client than the one named is not a proof for either; an invalid hint
    // is treated as absent (the person is asked), never as a proof.
    if (verified && (!clientId || clientId === verified.clientId)) {
      clientId = verified.clientId
      hintSub = verified.sub
    }
  }
  const found = clientId ? await findClientByClientId(db, clientId) : null
  const client = found && !found.disabledAt ? found : null
  if (!client) hintSub = null
  const requested = params.get('post_logout_redirect_uri')
  const target =
    client && requested && client.postLogoutRedirectUris.includes(requested) ? requested : null
  const state = params.get('state')
  return {
    client,
    target,
    state: state && state.length <= STATE_MAX ? state : null,
    hintSub,
  }
}

function logoutTarget(req: LogoutRequest): string | null {
  if (!req.target) return null
  const back = new URL(req.target)
  if (req.state) back.searchParams.set('state', req.state)
  return back.toString()
}

/** End the Launch session (if any), audit it against the client, clear the cookie. */
async function endLaunchSession(c: AppContext, req: LogoutRequest, via: 'hint' | 'confirmed') {
  const db = c.get('db')
  const token = readSessionToken(c)
  if (token) {
    const resolved = await resolveSession(db, token)
    if (resolved) {
      await deleteSession(db, resolved.session.id)
      if (req.client) {
        await recordAudit(db, {
          tenantId: req.client.tenantId,
          ...auditActor(c, resolved.user),
          action: 'oidc.logout',
          ...clientTarget(req.client),
          summary: { after: { via } },
        })
      }
    }
  }
  clearSessionCookie(c)
}

function signedOutPage(c: AppContext, req: LogoutRequest, afterPost: boolean) {
  const target = logoutTarget(req)
  if (target && !afterPost) return c.redirect(target, 302)
  if (target) {
    const href = escapeHtml(target)
    return htmlPage(c, 200, 'Signed out', 'You have been signed out of Launch.', {
      head: `<meta http-equiv="refresh" content="0;url=${href}">`,
      body: `<p><a class="button" href="${href}">Return to the app</a></p>`,
    })
  }
  return htmlPage(c, 200, 'Signed out', 'You have been signed out of Launch.')
}

oidcRouter.get('/logout', async c => {
  const req = await readLogoutRequest(c, new URL(c.req.url).searchParams)
  const token = readSessionToken(c)
  const found = token ? await resolveSession(c.get('db'), token) : null
  const resolved = found && found.session.expiresAt.getTime() > Date.now() ? found : null

  // Nobody signed in: nothing to end, nothing to forge. Back to the (registered) app.
  if (!resolved) {
    clearSessionCookie(c)
    return signedOutPage(c, req, false)
  }
  // Proven by the app, about this person: sign out without asking.
  if (req.hintSub && req.hintSub === resolved.user.id) {
    await endLaunchSession(c, req, 'hint')
    return signedOutPage(c, req, false)
  }
  // Otherwise ask. The form carries only what the POST needs to find its way back.
  const fields: Array<[string, string | null | undefined]> = [
    ['client_id', req.client?.clientId],
    ['post_logout_redirect_uri', req.target],
    ['state', req.state],
  ]
  const hidden = fields
    .filter((f): f is [string, string] => Boolean(f[1]))
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${escapeHtml(v)}">`)
    .join('')
  const cancel = req.target
    ? `<a class="button" href="${escapeHtml(req.target)}">Stay signed in</a>`
    : ''
  const who = resolved.user.email
  return htmlPage(
    c,
    200,
    'Sign out of Launch?',
    `You are signed in to Launch as ${who}. Signing out also ends single sign-on for every app that uses Launch.`,
    {
      body: `<form method="post" action="/oidc/logout">${hidden}<button type="submit">Sign out</button>${cancel}</form>`,
    }
  )
})

/** The confirmation page's form. A cross-site POST with the session cookie never gets here (CSRF). */
oidcRouter.post('/logout', async c => {
  const contentType = c.req.header('Content-Type') ?? ''
  const form = contentType.toLowerCase().startsWith('application/x-www-form-urlencoded')
    ? new URLSearchParams(await c.req.text())
    : new URLSearchParams()
  const req = await readLogoutRequest(c, form)
  await endLaunchSession(c, req, 'confirmed')
  return signedOutPage(c, req, true)
})
