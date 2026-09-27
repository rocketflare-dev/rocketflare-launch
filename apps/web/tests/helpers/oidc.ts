/**
 * Fixtures for Launch as an OIDC issuer (spec/05): an app, its OIDC client (the row slice 1d's
 * app page will create — inserted directly here, with the secret stored as `hashToken(secret)`
 * exactly as production stores it), and a `fetch` that routes an openid-client (or the kit's own
 * relying party) into the real Hono app instead of the network.
 *
 * The issuer runs at `ISSUER` (`APP_URL` in `issuerEnv()`), an https origin so openid-client needs
 * no insecure-request override.
 */
import type { OidcAccessPolicy } from '@launch/shared/launch-oidc'
import { hashToken } from '@/api/utils/core/hash'
import { randomToken } from '@/api/utils/core/ids'
import type { Database } from '@/db/client'
import {
  appOwners,
  apps,
  groupMembers,
  groups,
  groupTypes,
  type NewAppRow,
  oidcClients,
} from '@/db/schema'
import { createTestEnv, type TestEnv } from '../mocks/bindings'
import { uniqueId } from './auth'
import { request } from './request'

export const ISSUER = 'https://launch.test'

/** A test env whose `APP_URL` — and so whose issuer — is `ISSUER`. */
export function issuerEnv(overrides: Partial<TestEnv> = {}): TestEnv {
  return createTestEnv({ APP_URL: ISSUER, ...overrides })
}

export async function createTestApp(
  db: Database,
  tenantId: string,
  overrides: Partial<NewAppRow> = {}
) {
  const id = uniqueId().toLowerCase().replace(/_/g, '-')
  const [app] = await db
    .insert(apps)
    .values({
      tenantId,
      slug: `app-${id}`,
      displayName: `App ${id}`,
      source: 'imported',
      status: 'live',
      ...overrides,
    })
    .returning()
  if (!app) throw new Error('createTestApp: insert returned no row')
  return app
}

/** A group (under a fresh group type) with `memberIds` in it. */
export async function createTestGroup(
  db: Database,
  tenantId: string,
  name: string,
  memberIds: string[] = []
) {
  const [type] = await db
    .insert(groupTypes)
    .values({ tenantId, name: `Team ${uniqueId()}` })
    .returning()
  if (!type) throw new Error('createTestGroup: no group type')
  const [group] = await db
    .insert(groups)
    .values({ tenantId, groupTypeId: type.id, name })
    .returning()
  if (!group) throw new Error('createTestGroup: no group')
  if (memberIds.length > 0) {
    await db
      .insert(groupMembers)
      .values(memberIds.map(userId => ({ tenantId, groupId: group.id, userId })))
  }
  return group
}

export async function addTestAppOwner(
  db: Database,
  tenantId: string,
  appId: string,
  userId: string
) {
  await db.insert(appOwners).values({ tenantId, appId, userId })
}

export interface TestOidcClient {
  row: typeof oidcClients.$inferSelect
  clientId: string
  secret: string
  redirectUri: string
  postLogoutRedirectUri: string
  appId: string
}

/**
 * An app plus its OIDC client. Redirect URIs follow the kit relying party's shape
 * (`{APP_URL}/auth/oidc/callback`, `{APP_URL}/login?signedOut=1`) on a per-client origin.
 */
export async function createTestOidcClient(
  db: Database,
  tenantId: string,
  options: {
    appId?: string
    accessPolicy?: OidcAccessPolicy
    origin?: string
    redirectUris?: string[]
    postLogoutRedirectUris?: string[]
    disabled?: boolean
  } = {}
): Promise<TestOidcClient> {
  const appId = options.appId ?? (await createTestApp(db, tenantId)).id
  const origin =
    options.origin ?? `https://${uniqueId().toLowerCase().replace(/_/g, '-')}.apps.test`
  const clientId = `lc_${randomToken(12)}`
  const secret = randomToken(32)
  const redirectUri = `${origin}/auth/oidc/callback`
  const postLogoutRedirectUri = `${origin}/login?signedOut=1`
  const [row] = await db
    .insert(oidcClients)
    .values({
      tenantId,
      appId,
      clientId,
      secretHash: await hashToken(secret),
      secretHint: secret.slice(-4),
      redirectUris: options.redirectUris ?? [redirectUri],
      postLogoutRedirectUris: options.postLogoutRedirectUris ?? [postLogoutRedirectUri],
      accessPolicy: options.accessPolicy ?? 'company',
      disabledAt: options.disabled ? new Date() : null,
    })
    .returning()
  if (!row) throw new Error('createTestOidcClient: insert returned no row')
  return { row, clientId, secret, redirectUri, postLogoutRedirectUri, appId }
}

/**
 * A `fetch` for anything addressed to `ISSUER`: the request is handed to the real app (every
 * middleware) under `env`. Anything else falls through to `fallback`.
 */
export function issuerFetch(
  env: TestEnv,
  fallback: typeof fetch = globalThis.fetch
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    const req = new Request(input, init)
    const url = new URL(req.url)
    if (url.origin !== ISSUER) return fallback(input, init)
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.text()
    return request(
      `${url.pathname}${url.search}`,
      { method: req.method, headers: req.headers, body },
      { env }
    )
  }
}

/** The `Set-Cookie` value for `name`, or undefined. */
export function setCookieValue(res: Response, name: string): string | undefined {
  return res.headers
    .getSetCookie()
    .find(c => c.startsWith(`${name}=`))
    ?.split(';')[0]
    ?.slice(name.length + 1)
}
