// @vitest-isolate
// Spies on the global fetch (the relying party's calls to Launch) — it needs its own registry.
/**
 * The P1 exit test's other half, in-process: a Rocketflare 0.15 app signs its users in through
 * Launch with CONFIGURATION ONLY (plan decision 6). The kit's own generic OIDC relying party
 * (`api/auth/providers/oidc.ts` + `routes/auth/oauth.ts`) runs under an "app" env whose
 * `OIDC_ISSUER` is Launch; every fetch it makes to Launch — discovery, token, JWKS — is routed
 * into the same Hono app under Launch's env. Nothing here is Launch-specific on the app's side.
 */
import { logoutResponseSchema } from '@launch/shared/auth'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OAUTH_STATE_COOKIE_NAME, SESSION_COOKIE_NAME } from '@/api/auth/cookies'
import { resetOidcCaches } from '@/api/auth/providers/oidc'
import { auditEvents, oauthProviders } from '@/db/schema'
import {
  createTestSession,
  createTestTenantWithUser,
  createTestUser,
  linkUserToTenant,
  sessionCookieHeader,
} from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import {
  createTestOidcClient,
  ISSUER,
  issuerEnv,
  issuerFetch,
  setCookieValue,
  type TestOidcClient,
} from '../helpers/oidc'
import { json, request } from '../helpers/request'
import { createTestEnv } from '../mocks/bindings'

const db = setupTestDatabase()
const launch = issuerEnv()
const realFetch = globalThis.fetch

beforeEach(() => {
  resetOidcCaches()
  vi.spyOn(globalThis, 'fetch').mockImplementation(issuerFetch(launch, realFetch))
})

afterEach(() => {
  vi.restoreAllMocks()
})

/** The app: a Rocketflare deployment configured to sign in through Launch, and nothing else. */
function appEnv(client: TestOidcClient) {
  return createTestEnv({
    APP_URL: new URL(client.redirectUri).origin,
    OIDC_ISSUER: ISSUER,
    OIDC_CLIENT_ID: client.clientId,
    OIDC_CLIENT_SECRET: client.secret,
    AUTH_OIDC_ONLY: 'true',
  })
}

/** Drive one browser sign-in: app → Launch authorize (with a Launch session) → app callback. */
async function signInThroughLaunch(client: TestOidcClient, launchCookie: string) {
  const app = appEnv(client)
  const start = await request('/auth/oidc?returnUrl=/dashboard', {}, { env: app })
  expect(start.status).toBe(302)
  const authorizeUrl = new URL(start.headers.get('location') ?? '')
  expect(`${authorizeUrl.origin}${authorizeUrl.pathname}`).toBe(`${ISSUER}/oidc/authorize`)
  const flow = setCookieValue(start, OAUTH_STATE_COOKIE_NAME) as string

  const authorized = await request(
    `${authorizeUrl.pathname}${authorizeUrl.search}`,
    { headers: sessionCookieHeader(launchCookie) },
    { env: launch }
  )
  const back = new URL(authorized.headers.get('location') ?? '', ISSUER)
  const callback = await request(
    `${back.pathname}${back.search}`,
    { headers: { Cookie: `${OAUTH_STATE_COOKIE_NAME}=${flow}` } },
    { env: app }
  )
  return { app, authorizeUrl, authorized, back, callback }
}

describe("the kit's OIDC relying party against Launch's issuer", () => {
  it('signs a Launch user in to the app, and the app records who it was', async () => {
    const { tenant, user } = await createTestTenantWithUser(db, 'member')
    const launchCookie = await createTestSession(db, user.id, tenant.id)
    const client = await createTestOidcClient(db, tenant.id)

    const { authorizeUrl, back, callback } = await signInThroughLaunch(client, launchCookie)
    // What the kit RP asks for: code + PKCE S256 + a nonce, with the registered callback.
    expect(authorizeUrl.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authorizeUrl.searchParams.get('nonce')).toBeTruthy()
    expect(authorizeUrl.searchParams.get('redirect_uri')).toBe(client.redirectUri)
    expect(`${back.origin}${back.pathname}`).toBe(client.redirectUri)
    expect(back.searchParams.get('iss')).toBe(ISSUER)

    // The app accepted the id_token (ES256 against Launch's JWKS, nonce, email_verified) and
    // minted its OWN session.
    expect(callback.status).toBe(302)
    expect(callback.headers.get('location')).toBe('/dashboard')
    const appSession = setCookieValue(callback, SESSION_COOKIE_NAME)
    expect(appSession).toBeTruthy()

    // The app's identity key is `${iss}|${sub}` — Launch's issuer and Launch's user id.
    const [link] = await db
      .select()
      .from(oauthProviders)
      .where(
        and(
          eq(oauthProviders.provider, 'oidc'),
          eq(oauthProviders.providerUserId, `${ISSUER}|${user.id}`)
        )
      )
    expect(link?.userId).toBe(user.id)

    const signins = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.tenantId, tenant.id), eq(auditEvents.action, 'oidc.signin')))
    expect(signins.some(r => r.targetId === client.clientId && r.actorUserId === user.id)).toBe(
      true
    )
  })

  it('the kit RP authenticates with client_secret_basic, the way a deployed app will', async () => {
    const { tenant, user } = await createTestTenantWithUser(db, 'member')
    const launchCookie = await createTestSession(db, user.id, tenant.id)
    const client = await createTestOidcClient(db, tenant.id)
    const routed = issuerFetch(launch, realFetch)
    const tokenAuth: (string | null)[] = []
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const req = new Request(input, init)
      if (req.url === `${ISSUER}/oidc/token`) tokenAuth.push(req.headers.get('authorization'))
      return routed(req)
    })
    const { callback } = await signInThroughLaunch(client, launchCookie)
    expect(callback.headers.get('location')).toBe('/dashboard')
    expect(tokenAuth).toHaveLength(1)
    expect(tokenAuth[0]).toMatch(/^Basic /)
  })

  it("a user Launch's policy refuses never reaches the app's callback", async () => {
    const { tenant } = await createTestTenantWithUser(db, 'owner')
    const outsider = await createTestUser(db)
    await linkUserToTenant(db, outsider.id, tenant.id)
    const cookie = await createTestSession(db, outsider.id, tenant.id)
    const client = await createTestOidcClient(db, tenant.id, { accessPolicy: 'restricted' })

    const { authorized } = await signInThroughLaunch(client, cookie)
    const location = new URL(authorized.headers.get('location') ?? '', ISSUER)
    expect(location.origin).toBe(ISSUER)
    expect(location.pathname).toBe('/request-access')
  })

  it("the app's logout ends the Launch session and comes back to the app's login page", async () => {
    const { tenant, user } = await createTestTenantWithUser(db, 'member')
    const launchCookie = await createTestSession(db, user.id, tenant.id)
    const client = await createTestOidcClient(db, tenant.id)
    const { app, callback } = await signInThroughLaunch(client, launchCookie)
    const appSession = setCookieValue(callback, SESSION_COOKIE_NAME) as string

    const out = await request(
      '/auth/logout',
      { method: 'POST', headers: sessionCookieHeader(appSession) },
      { env: app }
    )
    const { endSessionUrl } = logoutResponseSchema.parse(await json(out))
    expect(endSessionUrl).toBeTruthy()
    const end = new URL(endSessionUrl as string)
    expect(`${end.origin}${end.pathname}`).toBe(`${ISSUER}/oidc/logout`)

    // The kit keeps no id_token, so it sends no id_token_hint: Launch asks before signing out.
    const res = await request(
      `${end.pathname}${end.search}`,
      { headers: sessionCookieHeader(launchCookie) },
      { env: launch }
    )
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Sign out of Launch?')
    const confirmed = await request(
      '/oidc/logout',
      {
        method: 'POST',
        headers: {
          ...sessionCookieHeader(launchCookie),
          'Content-Type': 'application/x-www-form-urlencoded',
          'Sec-Fetch-Site': 'same-origin',
          Origin: ISSUER,
        },
        body: new URLSearchParams({
          client_id: client.clientId,
          post_logout_redirect_uri: end.searchParams.get('post_logout_redirect_uri') ?? '',
        }).toString(),
      },
      { env: launch }
    )
    expect(confirmed.status).toBe(200)
    expect(await confirmed.text()).toContain(
      `content="0;url=${client.postLogoutRedirectUri.replace(/&/g, '&#38;')}"`
    )

    // Signed out of Launch too: the next app sign-in has to go through the login page.
    const again = await request(
      `/oidc/authorize?${new URLSearchParams({
        client_id: client.clientId,
        redirect_uri: client.redirectUri,
        response_type: 'code',
        scope: 'openid',
        code_challenge: 'a'.repeat(43),
        code_challenge_method: 'S256',
      })}`,
      { headers: sessionCookieHeader(launchCookie) },
      { env: launch }
    )
    expect(new URL(again.headers.get('location') ?? '', ISSUER).pathname).toBe('/login')
  })
})
