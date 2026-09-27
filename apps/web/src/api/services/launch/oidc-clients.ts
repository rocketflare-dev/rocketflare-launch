/**
 * An app's OIDC client registration (spec/05, spec/06 step 9): the `oidc_clients` row Launch's
 * issuer (slice 1b) authenticates the app's relying party against. One client per app, covering
 * both environments.
 *
 * - **The secret exists in plaintext exactly once**: `randomToken(32)`, returned in the create /
 *   rotate response and stored only as `hashToken(secret)` — the token endpoint compares hashes in
 *   constant time. `secret_hint` (the last four characters) lets an admin tell two apart.
 * - **Redirect URIs are derived, then editable**: `{url}/auth/oidc/callback` and
 *   `{url}/login?signedOut=1` for every environment with a URL — the kit relying party's own
 *   paths (P1 plan decision 6). `PATCH …/redirect-uris` replaces them (a vanity host, a dev URL).
 * - **The issuer is `cfg.APP_URL`** with no trailing slash (decision 5), and the snippet is
 *   `appOidcConfigSnippet` from the shared contract, so the UI and the response say the same thing.
 * - Audited: `oidc_client.created`, `oidc_client.secret_rotated`,
 *   `oidc_client.redirect_uris_updated` — never with the secret or its hash.
 */
import {
  type AppOidcClient,
  type AppOidcClientSecretResponse,
  appOidcConfigSnippet,
  type UpdateAppRedirectUrisRequest,
} from '@launch/shared/launch-apps'
import { and, eq } from 'drizzle-orm'
import type { AppConfig } from '../../../config'
import type { Database } from '../../../db/client'
import { type AppRow, appEnvironments, type OidcClientRow, oidcClients } from '../../../db/schema'
import { ApiError, ConflictError, isUniqueViolation, NotFoundError } from '../../utils/core/errors'
import { hashToken } from '../../utils/core/hash'
import { randomToken } from '../../utils/core/ids'
import { type AuditActor, recordAudit } from './audit'

/** Public client ids are `lc_…` ("Launch client"), globally unique. */
export const CLIENT_ID_PREFIX = 'lc_'

/** The relying party's callback and signed-out landing, relative to an environment's URL. */
export const RP_CALLBACK_PATH = '/auth/oidc/callback'
export const RP_SIGNED_OUT_PATH = '/login?signedOut=1'

export function toAppOidcClient(row: OidcClientRow): AppOidcClient {
  return {
    id: row.id,
    clientId: row.clientId,
    secretHint: row.secretHint,
    secretRotatedAt: row.secretRotatedAt,
    redirectUris: row.redirectUris ?? [],
    postLogoutRedirectUris: row.postLogoutRedirectUris ?? [],
    accessPolicy: row.accessPolicy,
    disabledAt: row.disabledAt,
    createdAt: row.createdAt,
  }
}

/** Launch's issuer identifier: the console's own origin, no trailing slash. */
export function issuerOf(cfg: AppConfig): string {
  return cfg.APP_URL.replace(/\/+$/, '')
}

async function newSecret(): Promise<{ secret: string; secretHash: string; secretHint: string }> {
  const secret = randomToken(32)
  return { secret, secretHash: await hashToken(secret), secretHint: secret.slice(-4) }
}

function secretResponse(
  cfg: AppConfig,
  row: OidcClientRow,
  secret: string
): AppOidcClientSecretResponse {
  const issuer = issuerOf(cfg)
  return {
    client: toAppOidcClient(row),
    clientId: row.clientId,
    clientSecret: secret,
    issuer,
    snippet: appOidcConfigSnippet({ issuer, clientId: row.clientId }),
  }
}

/** The app's client, or null when none is registered. */
export async function getAppOidcClient(
  db: Database,
  tenantId: string,
  appId: string
): Promise<OidcClientRow | null> {
  const [row] = await db
    .select()
    .from(oidcClients)
    .where(and(eq(oidcClients.tenantId, tenantId), eq(oidcClients.appId, appId)))
  return row ?? null
}

async function requireClient(db: Database, tenantId: string, appId: string) {
  const row = await getAppOidcClient(db, tenantId, appId)
  if (!row) throw new NotFoundError('This app has no OIDC client yet', 'oidc_client_not_found')
  return row
}

/** Every environment's callback and signed-out URL, staging first. */
async function derivedRedirectUris(db: Database, tenantId: string, appId: string) {
  const envs = await db
    .select({ name: appEnvironments.name, url: appEnvironments.url })
    .from(appEnvironments)
    .where(and(eq(appEnvironments.tenantId, tenantId), eq(appEnvironments.appId, appId)))
  const urls = envs
    .sort((a, b) => (a.name === b.name ? 0 : a.name === 'staging' ? -1 : 1))
    .map(e => e.url?.replace(/\/+$/, ''))
    .filter((u): u is string => Boolean(u))
  return {
    redirectUris: urls.map(u => `${u}${RP_CALLBACK_PATH}`),
    postLogoutRedirectUris: urls.map(u => `${u}${RP_SIGNED_OUT_PATH}`),
  }
}

/** Register the app's client. 409 when it has one; 422 when no environment has a URL. */
export async function createAppOidcClient(
  db: Database,
  cfg: AppConfig,
  tenantId: string,
  app: AppRow,
  actor: AuditActor
): Promise<AppOidcClientSecretResponse> {
  if (await getAppOidcClient(db, tenantId, app.id)) {
    throw new ConflictError('This app already has an OIDC client', 'oidc_client_exists')
  }
  const uris = await derivedRedirectUris(db, tenantId, app.id)
  if (uris.redirectUris.length === 0) {
    throw new ApiError(
      422,
      'No environment of this app has a URL to redirect to',
      'no_environment_url'
    )
  }
  const { secret, secretHash, secretHint } = await newSecret()
  try {
    const row = await db.transaction(async tx => {
      const [row] = await tx
        .insert(oidcClients)
        .values({
          tenantId,
          appId: app.id,
          clientId: `${CLIENT_ID_PREFIX}${randomToken(16)}`,
          secretHash,
          secretHint,
          redirectUris: uris.redirectUris,
          postLogoutRedirectUris: uris.postLogoutRedirectUris,
          createdByUserId: actor.actorUserId,
        })
        .returning()
      if (!row) throw new Error('oidc_clients insert returned no row')
      await recordAudit(tx, {
        tenantId,
        ...actor,
        action: 'oidc_client.created',
        targetType: 'OidcClient',
        targetId: row.id,
        appId: app.id,
        summary: {
          after: { clientId: row.clientId, redirectUris: row.redirectUris, secret: 'set' },
        },
      })
      return row
    })
    return secretResponse(cfg, row, secret)
  } catch (err) {
    // Two admins registering at once: `oidc_clients_app_id_key` lets one through.
    if (isUniqueViolation(err)) {
      throw new ConflictError('This app already has an OIDC client', 'oidc_client_exists')
    }
    throw err
  }
}

/** A new secret; the old one stops working at once. */
export async function rotateAppOidcSecret(
  db: Database,
  cfg: AppConfig,
  tenantId: string,
  app: AppRow,
  actor: AuditActor
): Promise<AppOidcClientSecretResponse> {
  const existing = await requireClient(db, tenantId, app.id)
  const { secret, secretHash, secretHint } = await newSecret()
  const now = new Date()
  const row = await db.transaction(async tx => {
    const [row] = await tx
      .update(oidcClients)
      .set({ secretHash, secretHint, secretRotatedAt: now, updatedAt: now })
      .where(and(eq(oidcClients.tenantId, tenantId), eq(oidcClients.id, existing.id)))
      .returning()
    if (!row) throw new NotFoundError('This app has no OIDC client yet', 'oidc_client_not_found')
    await recordAudit(tx, {
      tenantId,
      ...actor,
      action: 'oidc_client.secret_rotated',
      targetType: 'OidcClient',
      targetId: row.id,
      appId: app.id,
      summary: { before: { secretHint: existing.secretHint }, after: { secretHint } },
    })
    return row
  })
  return secretResponse(cfg, row, secret)
}

/** Replace the registered redirect URIs (and, when given, the post-logout ones). */
export async function updateAppRedirectUris(
  db: Database,
  tenantId: string,
  app: AppRow,
  input: UpdateAppRedirectUrisRequest,
  actor: AuditActor
): Promise<AppOidcClient> {
  const existing = await requireClient(db, tenantId, app.id)
  const redirectUris = [...new Set(input.redirectUris)]
  const postLogoutRedirectUris = input.postLogoutRedirectUris
    ? [...new Set(input.postLogoutRedirectUris)]
    : existing.postLogoutRedirectUris
  const row = await db.transaction(async tx => {
    const [row] = await tx
      .update(oidcClients)
      .set({ redirectUris, postLogoutRedirectUris, updatedAt: new Date() })
      .where(and(eq(oidcClients.tenantId, tenantId), eq(oidcClients.id, existing.id)))
      .returning()
    if (!row) throw new NotFoundError('This app has no OIDC client yet', 'oidc_client_not_found')
    await recordAudit(tx, {
      tenantId,
      ...actor,
      action: 'oidc_client.redirect_uris_updated',
      targetType: 'OidcClient',
      targetId: row.id,
      appId: app.id,
      summary: {
        before: {
          redirectUris: existing.redirectUris,
          postLogoutRedirectUris: existing.postLogoutRedirectUris,
        },
        after: { redirectUris, postLogoutRedirectUris },
      },
    })
    return row
  })
  return toAppOidcClient(row)
}
