/**
 * Launch as an OIDC issuer (spec/05), driven by a standard relying party: openid-client 6 plays
 * the app, its `customFetch` routed into the real Hono app, and the browser leg is a plain
 * `request()` carrying a Launch session cookie. Every S6 check (`spikes/s6-oidc-issuer/RESULT.md`)
 * is here, plus what the spike left for production: replay revocation, key rotation with a JWKS
 * overlap, the access policy and its request-access redirect, tenant isolation and the audit rows.
 */
import { and, eq } from 'drizzle-orm'
import {
  createLocalJWKSet,
  decodeProtectedHeader,
  type JSONWebKeySet,
  jwtVerify,
  SignJWT,
} from 'jose'
import * as oidc from 'openid-client'
import { beforeAll, describe, expect, it } from 'vitest'
import { SESSION_COOKIE_NAME } from '@/api/auth/cookies'
import { rotateKeys, signingKey } from '@/api/services/oidc/keys'
import { loadConfig } from '@/config'
import {
  auditEvents,
  oidcClientGrants,
  oidcCodes,
  oidcSigningKeys,
  userSessions,
} from '@/db/schema'
import {
  createTestGlobalAdmin,
  createTestSession,
  createTestTenantWithUser,
  createTestUser,
  linkUserToTenant,
  sessionCookieHeader,
} from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import {
  addTestAppOwner,
  createTestApp,
  createTestGroup,
  createTestOidcClient,
  ISSUER,
  issuerEnv,
  issuerFetch,
  setCookieValue,
  type TestOidcClient,
} from '../helpers/oidc'
import { json, request } from '../helpers/request'

const db = setupTestDatabase()
const env = issuerEnv()
const cfg = loadConfig(env)
const routed = issuerFetch(env)

// ---- The relying party ----------------------------------------------------------------------

async function rp(client: TestOidcClient): Promise<oidc.Configuration> {
  const config = await oidc.discovery(
    new URL(ISSUER),
    client.clientId,
    { client_secret: client.secret, redirect_uris: [client.redirectUri] },
    undefined,
    { [oidc.customFetch]: (url, options) => routed(url, options as RequestInit) }
  )
  config[oidc.customFetch] = (url, options) => routed(url, options as RequestInit)
  return config
}

interface Authorized {
  res: Response
  location: URL | null
  verifier: string
  nonce: string
  state: string
  redirectUri: string
}

/** The browser leg: GET /oidc/authorize with (or without) a Launch session cookie. */
async function authorize(
  config: oidc.Configuration,
  client: TestOidcClient,
  cookie: string | null,
  extra: { params?: Record<string, string>; dropPkce?: boolean; redirectUri?: string } = {}
): Promise<Authorized> {
  const verifier = oidc.randomPKCECodeVerifier()
  const nonce = oidc.randomNonce()
  const state = oidc.randomState()
  const redirectUri = extra.redirectUri ?? client.redirectUri
  const url = oidc.buildAuthorizationUrl(config, {
    redirect_uri: redirectUri,
    scope: 'openid email profile groups',
    code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
    code_challenge_method: 'S256',
    nonce,
    state,
    ...extra.params,
  })
  if (extra.dropPkce) {
    url.searchParams.delete('code_challenge')
    url.searchParams.delete('code_challenge_method')
  }
  const res = await request(
    `${url.pathname}${url.search}`,
    { headers: cookie ? sessionCookieHeader(cookie) : {} },
    { env }
  )
  const location = res.headers.get('location')
  return {
    res,
    location: location ? new URL(location, ISSUER) : null,
    verifier,
    nonce,
    state,
    redirectUri,
  }
}

function codeOf(a: Authorized): string {
  const code = a.location?.searchParams.get('code')
  if (!code) throw new Error(`no code in ${a.location}`)
  return code
}

async function grant(config: oidc.Configuration, a: Authorized) {
  if (!a.location) throw new Error('no redirect')
  return oidc.authorizationCodeGrant(config, a.location, {
    pkceCodeVerifier: a.verifier,
    expectedNonce: a.nonce,
    expectedState: a.state,
    idTokenExpected: true,
  })
}

/** A raw token request (client_secret_post unless `basic`). */
async function rawToken(
  body: Record<string, string>,
  options: { basic?: [string, string]; contentType?: string } = {}
) {
  const headers: Record<string, string> = {
    'Content-Type': options.contentType ?? 'application/x-www-form-urlencoded',
  }
  if (options.basic) headers.Authorization = `Basic ${btoa(options.basic.join(':'))}`
  const res = await request(
    '/oidc/token',
    { method: 'POST', headers, body: new URLSearchParams(body).toString() },
    { env }
  )
  return { res, body: (await res.json()) as Record<string, string> }
}

function redeem(client: TestOidcClient, a: Authorized, overrides: Record<string, string> = {}) {
  return rawToken({
    grant_type: 'authorization_code',
    code: codeOf(a),
    redirect_uri: a.redirectUri,
    code_verifier: a.verifier,
    client_id: client.clientId,
    client_secret: client.secret,
    ...overrides,
  })
}

async function publishedJwks(): Promise<JSONWebKeySet> {
  return json<JSONWebKeySet>(await request('/.well-known/jwks.json', {}, { env }))
}

async function auditRows(tenantId: string, action: string) {
  return db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.tenantId, tenantId), eq(auditEvents.action, action)))
}

// ---- Fixtures -------------------------------------------------------------------------------

let tenantId: string
let alice: { id: string; email: string; name: string }
let aliceCookie: string
let appA: TestOidcClient
let appB: TestOidcClient
let A: oidc.Configuration
let B: oidc.Configuration

beforeAll(async () => {
  const owner = await createTestTenantWithUser(db, 'member', { name: 'Alice Example' })
  tenantId = owner.tenant.id
  alice = owner.user
  aliceCookie = await createTestSession(db, alice.id, tenantId)
  await createTestGroup(db, tenantId, 'Finance', [alice.id])
  appA = await createTestOidcClient(db, tenantId)
  appB = await createTestOidcClient(db, tenantId)
  A = await rp(appA)
  B = await rp(appB)
})

// ---- Discovery ------------------------------------------------------------------------------

describe('discovery and JWKS', () => {
  it('openid-client accepts the issuer metadata', () => {
    const meta = A.serverMetadata()
    expect(meta.issuer).toBe(ISSUER)
    expect(meta.authorization_endpoint).toBe(`${ISSUER}/oidc/authorize`)
    expect(meta.token_endpoint).toBe(`${ISSUER}/oidc/token`)
    expect(meta.jwks_uri).toBe(`${ISSUER}/.well-known/jwks.json`)
    expect(meta.end_session_endpoint).toBe(`${ISSUER}/oidc/logout`)
    expect(meta.code_challenge_methods_supported).toEqual(['S256'])
    expect(meta.response_types_supported).toEqual(['code'])
    expect(meta.authorization_response_iss_parameter_supported).toBe(true)
  })

  it('publishes ES256 public keys only — never a private member', async () => {
    const set = await publishedJwks()
    expect(set.keys.length).toBeGreaterThanOrEqual(2) // active + the published next
    for (const key of set.keys) {
      expect(key).toMatchObject({ kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig' })
      expect(key.kid).toBeTruthy()
      expect(key).not.toHaveProperty('d')
    }
  })

  it('seals private keys at rest', async () => {
    const rows = await db.select().from(oidcSigningKeys)
    for (const row of rows) {
      expect(row.privateJwkSealed).not.toContain('"d"')
      expect(JSON.stringify(row.publicJwk)).not.toContain('"d"')
    }
  })

  it('refuses an OIDC_ISSUER equal to APP_URL (Launch cannot be its own upstream)', () => {
    expect(() => loadConfig(issuerEnv({ OIDC_ISSUER: `${ISSUER}/`, OIDC_CLIENT_ID: 'x' }))).toThrow(
      /OIDC_ISSUER must not be APP_URL/
    )
  })
})

// ---- The code flow --------------------------------------------------------------------------

describe('authorization code flow', () => {
  it('openid-client validates the whole flow: iss on the redirect, state, nonce, the id_token', async () => {
    const a = await authorize(A, appA, aliceCookie)
    expect(a.res.status).toBe(302)
    expect(a.location?.origin + (a.location?.pathname ?? '')).toBe(appA.redirectUri)
    expect(a.location?.searchParams.get('iss')).toBe(ISSUER)
    expect(a.location?.searchParams.get('state')).toBe(a.state)

    const tokens = await grant(A, a)
    const claims = tokens.claims()
    expect(claims).toMatchObject({
      iss: ISSUER,
      sub: alice.id,
      aud: appA.clientId,
      email: alice.email,
      email_verified: true,
      name: 'Alice Example',
      groups: ['Finance'],
      nonce: a.nonce,
    })
    expect(typeof claims?.auth_time).toBe('number')
    expect(tokens.token_type.toLowerCase()).toBe('bearer')

    // The signature, independently: ES256 against the published JWKS.
    const { payload, protectedHeader } = await jwtVerify(
      tokens.id_token as string,
      createLocalJWKSet(await publishedJwks()),
      { issuer: ISSUER, audience: appA.clientId, algorithms: ['ES256'] }
    )
    expect(payload.sub).toBe(alice.id)
    expect(protectedHeader.alg).toBe('ES256')
    expect(decodeProtectedHeader(tokens.access_token).typ).toBe('at+jwt')
  })

  it('auth_time is when the Launch session began', async () => {
    const a = await authorize(A, appA, aliceCookie)
    const claims = (await grant(A, a)).claims()
    const [session] = await db
      .select({ createdAt: userSessions.createdAt })
      .from(userSessions)
      .where(eq(userSessions.userId, alice.id))
    expect(claims?.auth_time).toBe(Math.floor((session?.createdAt.getTime() ?? 0) / 1000))
  })

  it('userinfo returns the same subject and the scoped claims', async () => {
    const a = await authorize(A, appA, aliceCookie)
    const tokens = await grant(A, a)
    const info = await oidc.fetchUserInfo(A, tokens.access_token, alice.id)
    expect(info).toMatchObject({ sub: alice.id, email: alice.email, email_verified: true })
    expect(info.groups).toEqual(['Finance'])
  })

  it('releases only what the scopes ask for', async () => {
    const a = await authorize(A, appA, aliceCookie, { params: { scope: 'openid unknown' } })
    const tokens = await grant(A, a)
    expect(tokens.scope).toBe('openid')
    const claims = tokens.claims()
    expect(claims?.email).toBeUndefined()
    expect(claims?.groups).toBeUndefined()
    expect(claims?.sub).toBe(alice.id)
  })

  it('the token response is never cached', async () => {
    const a = await authorize(A, appA, aliceCookie)
    const { res } = await redeem(appA, a)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('pragma')).toBe('no-cache')
  })

  it('accepts client_secret_basic', async () => {
    const a = await authorize(A, appA, aliceCookie)
    const { res, body } = await rawToken(
      {
        grant_type: 'authorization_code',
        code: codeOf(a),
        redirect_uri: a.redirectUri,
        code_verifier: a.verifier,
      },
      { basic: [appA.clientId, appA.secret] }
    )
    expect(res.status).toBe(200)
    expect(body.id_token).toBeTruthy()
  })

  it('stores codes hashed, never in plaintext', async () => {
    const a = await authorize(A, appA, aliceCookie)
    const code = codeOf(a)
    const rows = await db.select().from(oidcCodes).where(eq(oidcCodes.tenantId, tenantId))
    expect(rows.some(r => r.codeHash === code)).toBe(false)
    expect(rows.every(r => /^[0-9a-f]{64}$/.test(r.codeHash))).toBe(true)
  })
})

// ---- What a strict issuer refuses -----------------------------------------------------------

describe('refusals', () => {
  it('a replayed code is refused AND revokes the first redemption’s access token', async () => {
    const a = await authorize(A, appA, aliceCookie)
    const first = await redeem(appA, a)
    expect(first.res.status).toBe(200)
    const accessToken = first.body.access_token as string
    const before = await request(
      '/oidc/userinfo',
      { headers: { Authorization: `Bearer ${accessToken}` } },
      { env }
    )
    expect(before.status).toBe(200)

    const replay = await redeem(appA, a)
    expect(replay.res.status).toBe(400)
    expect(replay.body.error).toBe('invalid_grant')
    expect(replay.res.headers.get('cache-control')).toBe('no-store')

    const after = await request(
      '/oidc/userinfo',
      { headers: { Authorization: `Bearer ${accessToken}` } },
      { env }
    )
    expect(after.status).toBe(401)
    expect(after.headers.get('www-authenticate')).toContain('invalid_token')

    const replays = await auditRows(tenantId, 'oidc.code_replayed')
    expect(replays.some(r => r.targetId === appA.clientId && r.actorType === 'app')).toBe(true)
  })

  it('a wrong PKCE verifier is refused', async () => {
    const a = await authorize(A, appA, aliceCookie)
    const { res, body } = await redeem(appA, a, { code_verifier: oidc.randomPKCECodeVerifier() })
    expect(res.status).toBe(400)
    expect(body.error).toBe('invalid_grant')
  })

  it('a wrong client secret is refused with a Basic challenge', async () => {
    const a = await authorize(A, appA, aliceCookie)
    const { res, body } = await redeem(appA, a, { client_secret: 'nope' })
    expect(res.status).toBe(401)
    expect(body.error).toBe('invalid_client')
    expect(res.headers.get('www-authenticate')).toMatch(/^Basic /)
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('an unknown client_id is invalid_client, not a hint that it does not exist', async () => {
    const { res, body } = await rawToken({
      grant_type: 'authorization_code',
      code: 'x',
      client_id: 'lc_nobody',
      client_secret: 'nope',
    })
    expect(res.status).toBe(401)
    expect(body.error).toBe('invalid_client')
  })

  it("app B cannot redeem app A's code — and A still can", async () => {
    const a = await authorize(A, appA, aliceCookie)
    const cross = await redeem(appB, a, { client_id: appB.clientId, client_secret: appB.secret })
    expect(cross.res.status).toBe(400)
    expect(cross.body.error).toBe('invalid_grant')
    // The code was not burned by the wrong client.
    const own = await redeem(appA, a)
    expect(own.res.status).toBe(200)
  })

  it('a redirect_uri that differs from the authorization is refused', async () => {
    const a = await authorize(A, appA, aliceCookie)
    const { body } = await redeem(appA, a, { redirect_uri: `${appA.redirectUri}/x` })
    expect(body.error).toBe('invalid_grant')
  })

  it('an expired code is refused', async () => {
    const a = await authorize(A, appA, aliceCookie)
    await db
      .update(oidcCodes)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(and(eq(oidcCodes.tenantId, tenantId), eq(oidcCodes.clientRowId, appA.row.id)))
    const { body } = await redeem(appA, a)
    expect(body.error).toBe('invalid_grant')
  })

  it('refuses a non-form token request, a foreign grant type and a repeated parameter', async () => {
    const a = await authorize(A, appA, aliceCookie)
    const notForm = await rawToken(
      { grant_type: 'authorization_code', code: codeOf(a) },
      { contentType: 'application/json' }
    )
    expect(notForm.body.error).toBe('invalid_request')
    const refresh = await redeem(appA, a, { grant_type: 'refresh_token' })
    expect(refresh.body.error).toBe('unsupported_grant_type')
    const res = await request(
      '/oidc/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=authorization_code&code=a&code=b&client_id=${appA.clientId}&client_secret=${appA.secret}`,
      },
      { env }
    )
    expect(((await res.json()) as { error: string }).error).toBe('invalid_request')
  })

  it('an unregistered redirect_uri gets an error page, never a redirect', async () => {
    const bad = await authorize(A, appA, aliceCookie, {
      redirectUri: 'https://attacker.example/callback',
    })
    expect(bad.res.status).toBe(400)
    expect(bad.res.headers.get('location')).toBeNull()
    expect(bad.res.headers.get('content-type')).toContain('text/html')
    // A registered URI with a suffix is not a registered URI: the match is exact.
    const prefix = await authorize(A, appA, aliceCookie, {
      redirectUri: `${appA.redirectUri}?next=https://attacker.example`,
    })
    expect(prefix.res.status).toBe(400)
    expect(prefix.res.headers.get('location')).toBeNull()
  })

  it('an unknown or disabled client gets an error page, never a redirect', async () => {
    const res = await request(
      `/oidc/authorize?client_id=lc_nobody&redirect_uri=${encodeURIComponent(appA.redirectUri)}&response_type=code&scope=openid`,
      { headers: sessionCookieHeader(aliceCookie) },
      { env }
    )
    expect(res.status).toBe(400)
    expect(res.headers.get('location')).toBeNull()

    const disabled = await createTestOidcClient(db, tenantId, { disabled: true })
    const d = await authorize(await rp(appA), disabled, aliceCookie, {
      params: { client_id: disabled.clientId },
    })
    expect(d.res.status).toBe(400)
    expect(d.res.headers.get('location')).toBeNull()
  })

  it('a request without PKCE is refused back to the app, with state and iss', async () => {
    const a = await authorize(A, appA, aliceCookie, { dropPkce: true })
    expect(a.res.status).toBe(302)
    expect(a.location?.searchParams.get('error')).toBe('invalid_request')
    expect(a.location?.searchParams.get('state')).toBe(a.state)
    expect(a.location?.searchParams.get('iss')).toBe(ISSUER)
    expect(a.location?.searchParams.get('code')).toBeNull()
  })

  it('refuses plain PKCE, the implicit flow and a missing openid scope', async () => {
    const plain = await authorize(A, appA, aliceCookie, {
      params: { code_challenge_method: 'plain' },
    })
    expect(plain.location?.searchParams.get('error')).toBe('invalid_request')
    const implicit = await authorize(A, appA, aliceCookie, {
      params: { response_type: 'id_token' },
    })
    expect(implicit.location?.searchParams.get('error')).toBe('unsupported_response_type')
    const noOpenid = await authorize(A, appA, aliceCookie, { params: { scope: 'email' } })
    expect(noOpenid.location?.searchParams.get('error')).toBe('invalid_scope')
    const requestObject = await authorize(A, appA, aliceCookie, { params: { request: 'x.y.z' } })
    expect(requestObject.location?.searchParams.get('error')).toBe('request_not_supported')
  })

  it('a tampered id_token fails against the JWKS', async () => {
    const a = await authorize(A, appA, aliceCookie)
    const tokens = await grant(A, a)
    const [h, , s] = (tokens.id_token as string).split('.')
    const forged = Buffer.from(
      JSON.stringify({ ...tokens.claims(), sub: 'someone-else' })
    ).toString('base64url')
    const ok = await jwtVerify(`${h}.${forged}.${s}`, createLocalJWKSet(await publishedJwks()), {
      issuer: ISSUER,
      audience: appA.clientId,
    }).then(
      () => true,
      () => false
    )
    expect(ok).toBe(false)
  })

  it('userinfo refuses a missing, malformed or id_token-shaped token', async () => {
    const none = await request('/oidc/userinfo', {}, { env })
    expect(none.status).toBe(401)
    expect(none.headers.get('www-authenticate')).toBe('Bearer realm="launch"')
    const junk = await request(
      '/oidc/userinfo',
      { headers: { Authorization: 'Bearer not.a.jwt' } },
      { env }
    )
    expect(junk.status).toBe(401)
    // An id_token is not an access token (typ and audience differ).
    const a = await authorize(A, appA, aliceCookie)
    const tokens = await grant(A, a)
    const wrong = await request(
      '/oidc/userinfo',
      { headers: { Authorization: `Bearer ${tokens.id_token}` } },
      { env }
    )
    expect(wrong.status).toBe(401)
  })
})

// ---- Sessions, SSO and logout ---------------------------------------------------------------

describe('sessions', () => {
  it('no Launch session: sent to sign in, and back here afterwards', async () => {
    const a = await authorize(A, appA, null)
    expect(a.res.status).toBe(302)
    expect(a.location?.pathname).toBe('/login')
    const returnUrl = a.location?.searchParams.get('returnUrl') ?? ''
    expect(returnUrl.startsWith('/oidc/authorize?')).toBe(true)
    expect(new URL(returnUrl, ISSUER).searchParams.get('client_id')).toBe(appA.clientId)
  })

  it('prompt=none with no session answers login_required to the app', async () => {
    const a = await authorize(A, appA, null, { params: { prompt: 'none' } })
    expect(a.location?.origin).toBe(new URL(appA.redirectUri).origin)
    expect(a.location?.searchParams.get('error')).toBe('login_required')
    expect(a.location?.searchParams.get('iss')).toBe(ISSUER)
  })

  it('prompt=none with a session signs in silently', async () => {
    const a = await authorize(A, appA, aliceCookie, { params: { prompt: 'none' } })
    expect((await grant(A, a)).claims()?.sub).toBe(alice.id)
  })

  it('single sign-on: an existing Launch session signs alice in to app B with no prompt', async () => {
    const a = await authorize(A, appA, aliceCookie)
    const b = await authorize(B, appB, aliceCookie)
    const [ta, tb] = [await grant(A, a), await grant(B, b)]
    expect(ta.claims()?.sub).toBe(alice.id)
    expect(tb.claims()?.sub).toBe(alice.id)
    expect(tb.claims()?.aud).toBe(appB.clientId)
  })
})

// ---- Re-authentication: prompt=login and max_age --------------------------------------------

describe('re-authentication', () => {
  /** A fresh member of alice's organisation, so ending sessions here never touches hers. */
  async function person() {
    const user = await createTestUser(db)
    await linkUserToTenant(db, user.id, tenantId, 'member')
    return user
  }

  async function sessionFor(userId: string, ageSeconds = 0) {
    const cookie = await createTestSession(db, userId, tenantId)
    if (ageSeconds > 0) {
      await db
        .update(userSessions)
        .set({ createdAt: new Date(Date.now() - ageSeconds * 1000) })
        .where(eq(userSessions.userId, userId))
    }
    return cookie
  }

  async function liveSessions(userId: string) {
    return db.select().from(userSessions).where(eq(userSessions.userId, userId))
  }

  /** The authorize URL the login page will return to. */
  function returnUrlOf(a: Authorized): URL {
    expect(a.location?.pathname).toBe('/login')
    return new URL(a.location?.searchParams.get('returnUrl') ?? '', ISSUER)
  }

  it('prompt=login ends the session and sends the person to sign in, without looping', async () => {
    const carol = await person()
    const cookie = await sessionFor(carol.id)
    const a = await authorize(A, appA, cookie, { params: { prompt: 'login' } })
    expect(a.res.status).toBe(302)
    expect(setCookieValue(a.res, SESSION_COOKIE_NAME)).toBe('')
    expect(await liveSessions(carol.id)).toHaveLength(0)
    const back = returnUrlOf(a)
    expect(back.searchParams.has('prompt')).toBe(false)
    expect(Number(back.searchParams.get('launch_reauth'))).toBeGreaterThan(0)

    // Signed in again: the return URL issues a code, and auth_time is the NEW sign-in.
    const fresh = await sessionFor(carol.id)
    const res = await request(
      `${back.pathname}${back.search}`,
      { headers: sessionCookieHeader(fresh) },
      { env }
    )
    const location = new URL(res.headers.get('location') ?? '')
    const tokens = await grant(A, { ...a, res, location })
    const [session] = await liveSessions(carol.id)
    expect(tokens.claims()?.auth_time).toBe(Math.floor((session?.createdAt.getTime() ?? 0) / 1000))
  })

  it('max_age: a session older than it re-authenticates; a younger one signs in', async () => {
    const dave = await person()
    const old = await sessionFor(dave.id, 3600)
    const young = await authorize(A, appA, old, { params: { max_age: '7200' } })
    expect(young.location?.searchParams.get('code')).toBeTruthy()
    const stale = await authorize(A, appA, old, { params: { max_age: '60' } })
    expect(returnUrlOf(stale).searchParams.get('max_age')).toBe('60')
    expect(await liveSessions(dave.id)).toHaveLength(0)
  })

  it('max_age=0 is satisfied by the sign-in it forced (the marker), not by an older one', async () => {
    const erin = await person()
    const first = await authorize(A, appA, await sessionFor(erin.id), {
      params: { max_age: '0' },
    })
    const back = returnUrlOf(first)
    const fresh = await sessionFor(erin.id)
    const res = await request(
      `${back.pathname}${back.search}`,
      { headers: sessionCookieHeader(fresh) },
      { env }
    )
    expect(new URL(res.headers.get('location') ?? '').searchParams.get('code')).toBeTruthy()

    // A marker older than the window proves nothing.
    const stale = new URL(back)
    stale.searchParams.set('launch_reauth', String(Math.floor(Date.now() / 1000) - 3600))
    const again = await request(
      `${stale.pathname}${stale.search}`,
      { headers: sessionCookieHeader(await sessionFor(erin.id, 7200)) },
      { env }
    )
    expect(new URL(again.headers.get('location') ?? '', ISSUER).pathname).toBe('/login')
  })

  it('prompt=none with a session older than max_age answers login_required', async () => {
    const frank = await person()
    const cookie = await sessionFor(frank.id, 3600)
    const a = await authorize(A, appA, cookie, { params: { prompt: 'none', max_age: '60' } })
    expect(a.location?.searchParams.get('error')).toBe('login_required')
    expect(await liveSessions(frank.id)).toHaveLength(1)
  })

  it('a malformed max_age is invalid_request', async () => {
    const a = await authorize(A, appA, aliceCookie, { params: { max_age: '-5' } })
    expect(a.location?.searchParams.get('error')).toBe('invalid_request')
  })
})

// ---- RP-initiated logout --------------------------------------------------------------------

describe('logout', () => {
  /** Alice's id_token from app A, from a real sign-in on `cookie`. */
  async function idTokenFor(cookie: string): Promise<string> {
    const tokens = await grant(A, await authorize(A, appA, cookie))
    return tokens.id_token as string
  }

  async function sessionAlive(cookie: string): Promise<boolean> {
    const a = await authorize(A, appA, cookie)
    return a.location?.pathname !== '/login'
  }

  function logoutGet(params: Record<string, string>, cookie?: string) {
    return request(
      `/oidc/logout?${new URLSearchParams(params)}`,
      { headers: cookie ? sessionCookieHeader(cookie) : {} },
      { env }
    )
  }

  function logoutPost(form: Record<string, string>, cookie: string, site = 'same-origin') {
    return request(
      '/oidc/logout',
      {
        method: 'POST',
        headers: {
          ...sessionCookieHeader(cookie),
          'Content-Type': 'application/x-www-form-urlencoded',
          'Sec-Fetch-Site': site,
          Origin: site === 'same-origin' ? ISSUER : 'https://attacker.example',
        },
        body: new URLSearchParams(form).toString(),
      },
      { env }
    )
  }

  it("with the app's id_token_hint: signed out at once, back to the registered URI with state", async () => {
    const cookie = await createTestSession(db, alice.id, tenantId)
    const url = oidc.buildEndSessionUrl(A, {
      id_token_hint: await idTokenFor(cookie),
      post_logout_redirect_uri: appA.postLogoutRedirectUri,
      state: 'bye',
    })
    const res = await request(
      `${url.pathname}${url.search}`,
      { headers: sessionCookieHeader(cookie) },
      { env }
    )
    expect(res.status).toBe(302)
    const back = new URL(res.headers.get('location') ?? '')
    expect(`${back.origin}${back.pathname}`).toBe(
      `${new URL(appA.postLogoutRedirectUri).origin}/login`
    )
    expect(back.searchParams.get('signedOut')).toBe('1')
    expect(back.searchParams.get('state')).toBe('bye')
    expect(setCookieValue(res, SESSION_COOKIE_NAME)).toBe('')
    expect(await sessionAlive(cookie)).toBe(false)
    expect((await auditRows(tenantId, 'oidc.logout')).length).toBeGreaterThan(0)
  })

  it('an EXPIRED hint signed by Launch still counts', async () => {
    const cookie = await createTestSession(db, alice.id, tenantId)
    const { kid, key } = await signingKey(db, cfg)
    const past = Math.floor(Date.now() / 1000) - 86_400
    const expired = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid, typ: 'JWT' })
      .setIssuer(ISSUER)
      .setSubject(alice.id)
      .setAudience(appA.clientId)
      .setIssuedAt(past - 300)
      .setExpirationTime(past)
      .sign(key)
    const res = await logoutGet(
      { id_token_hint: expired, post_logout_redirect_uri: appA.postLogoutRedirectUri },
      cookie
    )
    expect(res.status).toBe(302)
    expect(await sessionAlive(cookie)).toBe(false)
  })

  it('no hint (what a Rocketflare app sends): a confirmation page, and nothing ends until its POST', async () => {
    const cookie = await createTestSession(db, alice.id, tenantId)
    const res = await logoutGet(
      {
        client_id: appA.clientId,
        post_logout_redirect_uri: appA.postLogoutRedirectUri,
        state: 's1',
      },
      cookie
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('location')).toBeNull()
    const page = await res.text()
    expect(page).toContain('<form method="post" action="/oidc/logout">')
    expect(page).toContain(`name="client_id" value="${appA.clientId}"`)
    expect(page).toContain(alice.email)
    // Under a no-referrer policy the browser would send `Origin: null` with the form, and CSRF
    // refuses that (found driving a real browser through the confirmation).
    expect(page).not.toContain('no-referrer')
    expect(await sessionAlive(cookie)).toBe(true)

    // A cross-site POST carrying the cookie is refused by the CSRF middleware.
    const forged = await logoutPost({ client_id: appA.clientId }, cookie, 'cross-site')
    expect(forged.status).toBe(403)
    expect(await sessionAlive(cookie)).toBe(true)

    // The page's own (same-origin) POST signs out and returns to the app — by a meta refresh,
    // because the CSP's form-action 'self' governs a form response's redirect too.
    const confirmed = await logoutPost(
      {
        client_id: appA.clientId,
        post_logout_redirect_uri: appA.postLogoutRedirectUri,
        state: 's1',
      },
      cookie
    )
    expect(confirmed.status).toBe(200)
    expect(setCookieValue(confirmed, SESSION_COOKIE_NAME)).toBe('')
    const body = await confirmed.text()
    const target = new URL(appA.postLogoutRedirectUri)
    target.searchParams.set('state', 's1')
    expect(body).toContain(
      `<meta http-equiv="refresh" content="0;url=${target.toString().replace(/&/g, '&#38;')}">`
    )
    expect(await sessionAlive(cookie)).toBe(false)
  })

  it("a forged hint, or another person's, is not a proof: the person is asked", async () => {
    const cookie = await createTestSession(db, alice.id, tenantId)
    const real = await idTokenFor(cookie)
    const [h, p, sig] = real.split('.')
    const tampered = `${h}.${p}.${sig?.startsWith('A') ? 'B' : 'A'}${sig?.slice(1)}`
    expect((await logoutGet({ id_token_hint: tampered }, cookie)).status).toBe(200)
    expect(await sessionAlive(cookie)).toBe(true)

    const bobUser = await createTestUser(db)
    await linkUserToTenant(db, bobUser.id, tenantId, 'member')
    const bobCookie = await createTestSession(db, bobUser.id, tenantId)
    const res = await logoutGet(
      { id_token_hint: real, post_logout_redirect_uri: appA.postLogoutRedirectUri },
      bobCookie
    )
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Sign out of Launch?')

    // A hint for app A presented as app B is not a proof for either.
    const mixed = await logoutGet({ id_token_hint: real, client_id: appB.clientId }, cookie)
    expect(mixed.status).toBe(200)
    expect(await sessionAlive(cookie)).toBe(true)
  })

  it('logout never redirects to an unregistered URI', async () => {
    const url = oidc.buildEndSessionUrl(A, {
      client_id: appA.clientId,
      post_logout_redirect_uri: 'https://attacker.example/',
    })
    const res = await request(`${url.pathname}${url.search}`, {}, { env })
    expect(res.status).toBe(200)
    expect(res.headers.get('location')).toBeNull()
    // Another client's registered URI is not this client's.
    const other = await logoutGet({
      client_id: appA.clientId,
      post_logout_redirect_uri: appB.postLogoutRedirectUri,
    })
    expect(other.status).toBe(200)
    expect(other.headers.get('location')).toBeNull()
    // With nobody signed in there is nothing to confirm: straight back to a registered URI.
    const none = await logoutGet({
      client_id: appA.clientId,
      post_logout_redirect_uri: appA.postLogoutRedirectUri,
    })
    expect(none.status).toBe(302)
    expect(none.headers.get('location')).toBe(appA.postLogoutRedirectUri)
  })
})

// ---- The access policy ----------------------------------------------------------------------

describe('access policy', () => {
  it('restricted: a member with no grant is sent to request access, and it is audited', async () => {
    const restricted = await createTestOidcClient(db, tenantId, { accessPolicy: 'restricted' })
    const bob = await createTestUser(db)
    await linkUserToTenant(db, bob.id, tenantId)
    const bobCookie = await createTestSession(db, bob.id, tenantId)
    const a = await authorize(await rp(restricted), restricted, bobCookie)
    expect(a.res.status).toBe(302)
    expect(a.location?.origin).toBe(ISSUER)
    expect(a.location?.pathname).toBe('/request-access')
    expect(a.location?.searchParams.get('client_id')).toBe(restricted.clientId)
    expect(a.location?.searchParams.get('return')?.startsWith('/oidc/authorize?')).toBe(true)
    const denied = await auditRows(tenantId, 'oidc.denied')
    expect(
      denied.some(r => r.actorUserId === bob.id && r.summary.after?.reason === 'not_granted')
    ).toBe(true)

    // prompt=none cannot show a page: it answers access_denied to the app instead.
    const silent = await authorize(await rp(restricted), restricted, bobCookie, {
      params: { prompt: 'none' },
    })
    expect(silent.location?.searchParams.get('error')).toBe('access_denied')
  })

  it('restricted: a user grant, a group grant, a named owner and the owner group are admitted', async () => {
    const app = await createTestApp(db, tenantId)
    const restricted = await createTestOidcClient(db, tenantId, {
      appId: app.id,
      accessPolicy: 'restricted',
    })
    const config = await rp(restricted)
    const signInAs = async () => {
      const u = await createTestUser(db)
      await linkUserToTenant(db, u.id, tenantId)
      return { user: u, cookie: await createTestSession(db, u.id, tenantId) }
    }

    const granted = await signInAs()
    await db.insert(oidcClientGrants).values({
      tenantId,
      clientId: restricted.row.id,
      userId: granted.user.id,
    })
    expect(codeOf(await authorize(config, restricted, granted.cookie))).toBeTruthy()

    const inGroup = await signInAs()
    const group = await createTestGroup(db, tenantId, 'Payroll', [inGroup.user.id])
    await db
      .insert(oidcClientGrants)
      .values({ tenantId, clientId: restricted.row.id, groupId: group.id })
    expect(codeOf(await authorize(config, restricted, inGroup.cookie))).toBeTruthy()

    const owner = await signInAs()
    await addTestAppOwner(db, tenantId, app.id, owner.user.id)
    expect(codeOf(await authorize(config, restricted, owner.cookie))).toBeTruthy()

    const ownerGroupMember = await signInAs()
    const ownerGroup = await createTestGroup(db, tenantId, 'App team', [ownerGroupMember.user.id])
    const appWithGroup = await createTestApp(db, tenantId, { ownerGroupId: ownerGroup.id })
    const groupOwned = await createTestOidcClient(db, tenantId, {
      appId: appWithGroup.id,
      accessPolicy: 'restricted',
    })
    expect(
      codeOf(await authorize(await rp(groupOwned), groupOwned, ownerGroupMember.cookie))
    ).toBeTruthy()
  })

  it('records oidc.signin with the person, the app and the client', async () => {
    const a = await authorize(A, appA, aliceCookie)
    expect(codeOf(a)).toBeTruthy()
    const rows = await auditRows(tenantId, 'oidc.signin')
    const row = rows.find(r => r.targetId === appA.clientId && r.actorUserId === alice.id)
    expect(row).toMatchObject({
      actorType: 'user',
      actorEmail: alice.email,
      appId: appA.appId,
      targetType: 'oidc_client',
    })
  })
})

// ---- Tenant isolation -----------------------------------------------------------------------

describe('tenant isolation', () => {
  it('a member of another organisation is refused — and is not offered the request page', async () => {
    const other = await createTestTenantWithUser(db, 'owner')
    const otherCookie = await createTestSession(db, other.user.id, other.tenant.id)
    const a = await authorize(A, appA, otherCookie)
    expect(a.location?.origin).toBe(new URL(appA.redirectUri).origin)
    expect(a.location?.searchParams.get('error')).toBe('access_denied')
    // The refusal is recorded in the APP's organisation, never the requester's.
    const denied = await auditRows(tenantId, 'oidc.denied')
    expect(denied.some(r => r.actorUserId === other.user.id)).toBe(true)
    expect((await auditRows(other.tenant.id, 'oidc.denied')).length).toBe(0)
  })

  it("groups come from the client's organisation only", async () => {
    const other = await createTestTenantWithUser(db, 'owner')
    await linkUserToTenant(db, other.user.id, tenantId)
    await createTestGroup(db, other.tenant.id, 'Elsewhere', [other.user.id])
    // Session pinned to the OTHER tenant: the policy and the claims still use the client's.
    const cookie = await createTestSession(db, other.user.id, other.tenant.id)
    const tokens = await grant(A, await authorize(A, appA, cookie))
    expect(tokens.claims()?.groups).toEqual([])
  })
})

// ---- Keys -----------------------------------------------------------------------------------

describe('signing-key rotation', () => {
  it('a token signed before a rotation still verifies after it; new tokens use the pre-published key', async () => {
    const before = await grant(A, await authorize(A, appA, aliceCookie))
    const oldKid = decodeProtectedHeader(before.id_token as string).kid
    const jwksBefore = await publishedJwks()

    const result = await rotateKeys(db, cfg, null)
    expect(result.retiring?.kid).toBe(oldKid)
    // The key that now signs was already in the JWKS before the rotation (published as next).
    expect(jwksBefore.keys.map(k => k.kid)).toContain(result.active.kid)

    const jwksAfter = await publishedJwks()
    const kids = jwksAfter.keys.map(k => k.kid)
    expect(kids).toContain(oldKid)
    expect(kids).toContain(result.active.kid)
    expect(kids).toContain(result.next.kid)
    await expect(
      jwtVerify(before.id_token as string, createLocalJWKSet(jwksAfter), {
        issuer: ISSUER,
        audience: appA.clientId,
      })
    ).resolves.toBeTruthy()
    // The access token from before still opens userinfo.
    expect((await oidc.fetchUserInfo(A, before.access_token, alice.id)).sub).toBe(alice.id)

    const after = await grant(A, await authorize(A, appA, aliceCookie))
    expect(decodeProtectedHeader(after.id_token as string).kid).toBe(result.active.kid)
  })

  it('a retiring key leaves the JWKS once its retire_after has passed', async () => {
    const { retiring } = await rotateKeys(db, cfg, null)
    expect(retiring).not.toBeNull()
    await db
      .update(oidcSigningKeys)
      .set({ retireAfter: new Date(Date.now() - 1000) })
      .where(eq(oidcSigningKeys.id, retiring?.id ?? ''))
    const kids = (await publishedJwks()).keys.map(k => k.kid)
    expect(kids).not.toContain(retiring?.kid)
  })

  it('the admin API lists keys without material and rotates, for global admins only', async () => {
    const member = await createTestSession(db, alice.id, tenantId)
    const forbidden = await request(
      '/api/platform/oidc/keys',
      { headers: sessionCookieHeader(member) },
      { env }
    )
    expect(forbidden.status).toBe(403)

    const admin = await createTestGlobalAdmin(db)
    await linkUserToTenant(db, admin.id, tenantId, 'owner')
    const cookie = await createTestSession(db, admin.id, tenantId)
    const list = await request(
      '/api/platform/oidc/keys',
      { headers: sessionCookieHeader(cookie) },
      { env }
    )
    expect(list.status).toBe(200)
    const body = await json<{
      issuer: string
      discoveryUrl: string
      keys: Record<string, unknown>[]
    }>(list)
    expect(body.issuer).toBe(ISSUER)
    expect(body.discoveryUrl).toBe(`${ISSUER}/.well-known/openid-configuration`)
    expect(JSON.stringify(body)).not.toMatch(/"d"|privateJwk|sealed/i)

    const rotated = await request(
      '/api/platform/oidc/keys/rotate',
      { method: 'POST', headers: sessionCookieHeader(cookie) },
      { env }
    )
    expect(rotated.status).toBe(200)
    const { active } = await json<{ active: { kid: string } }>(rotated)
    const audit = await auditRows(tenantId, 'oidc.key.rotated')
    expect(audit.some(r => r.targetId === active.kid && r.actorUserId === admin.id)).toBe(true)
  })
})
