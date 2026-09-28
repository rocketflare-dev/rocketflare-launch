/**
 * Shared config and grants fixtures (Launch P5, `docs/plans/p5-grants.md`). Rows are written
 * DIRECTLY — never through the services — so each slice's suite can stand up a resource, its values
 * and its holders without waiting on the slice that builds the service:
 *
 * - `M365_ITEMS` / `M365_VALUES` — the plan's worked example (two vars and a secret);
 * - `seedSharedResource(db, tenantId, { ownerGroupId, … })` → the `shared_resources` row;
 * - `seedResourceValues(db, cfg, resource, env, values, { version?, status? })` → a sealed version
 *   (`sealed.sealValues`, the real seal);
 * - `seedGrant(db, { tenantId, appId, resourceId, environment, status?, pushedVersionId? })` →
 *   an `app_grants` row;
 * - `grantDeps(db, env, now?)` — the approvals engine's deps shape, which is `GrantDeps`.
 *
 * The end-to-end helpers (`tests/api/grants-e2e.test.ts`, plan §4):
 *
 * - `m365Files(slug)` — `launch.plugins.json` + the fixture connector's `plugin.json` at its anchor,
 *   as `pnpm plugin add` leaves them (what detection reads); `withM365Vars(toml)` — the two vars a
 *   plugin install writes into an app's `[vars]`;
 * - `FakeAzure` + `m365Host(cloud, azure, { host, script })` — the connector plugin standing in on
 *   the app's host: `GET /api/connectors/m365/status` answers 503 unless the Worker's live env
 *   (`cloud.cloudflare.envOf(script)`) has all three keys, and otherwise exchanges the client
 *   credentials at `login.microsoftonline.com`, which accepts only a secret `azure.valid` holds.
 *   `/api/health` answers as a deployed kit app does (its `RELEASE_VERSION`).
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { AppEnvironmentName } from '@launch/shared/launch-apps'
import type {
  GrantStatus,
  SharedResourceItem,
  SharedResourcePolicies,
  SharedResourceValueStatus,
} from '@launch/shared/launch-grants'
import { sealValues } from '@/api/services/grants/sealed'
import type { GrantDeps } from '@/api/services/grants/types'
import type { AppConfig } from '@/config'
import type { Database } from '@/db/client'
import {
  type AppGrantRow,
  appGrants,
  type SharedResourceRow,
  type SharedResourceValueRow,
  sharedResources,
  sharedResourceValues,
} from '@/db/schema'
import type { TestEnv } from '../mocks/bindings'
import { approvalDeps } from './approvals'
import { uniqueId } from './auth'
import type { FakeCloud } from './fake-cloud'

/** The M365 connector's config (plan §1.1): the tenant and client ids are vars, the secret a secret. */
export const M365_ITEMS: SharedResourceItem[] = [
  { key: 'M365_TENANT_ID', kind: 'var', description: 'The company Entra tenant' },
  { key: 'M365_CLIENT_ID', kind: 'var' },
  { key: 'M365_CLIENT_SECRET', kind: 'secret', rotationDays: 180 },
]

/** Values that are obviously fixtures — and a sentinel secret a "never echoed" test searches for. */
export const M365_VALUES = {
  M365_TENANT_ID: '00000000-0000-4000-8000-00000000e17a',
  M365_CLIENT_ID: '00000000-0000-4000-8000-0000000c11e7',
  M365_CLIENT_SECRET: 'sentinel-m365-secret-do-not-echo',
} as const

export interface SeedSharedResourceInput {
  ownerGroupId: string
  slug?: string
  displayName?: string
  description?: string | null
  items?: SharedResourceItem[]
  policies?: SharedResourcePolicies
  createdByUserId?: string | null
  archivedAt?: Date | null
}

export async function seedSharedResource(
  db: Database,
  tenantId: string,
  input: SeedSharedResourceInput
): Promise<SharedResourceRow> {
  const [row] = await db
    .insert(sharedResources)
    .values({
      tenantId,
      slug: input.slug ?? `m365-${uniqueId().slice(0, 8)}`,
      displayName: input.displayName ?? 'M365 (company tenant)',
      description: input.description ?? null,
      ownerGroupId: input.ownerGroupId,
      items: input.items ?? M365_ITEMS,
      policies: input.policies ?? {},
      createdByUserId: input.createdByUserId ?? null,
      archivedAt: input.archivedAt ?? null,
    })
    .returning()
  if (!row) throw new Error('seedSharedResource: no row')
  return row
}

export interface SeedValuesOptions {
  version?: number
  status?: SharedResourceValueStatus
  setByUserId?: string | null
  setAt?: Date
}

/** One sealed version of `resource`'s values in `environment` (default version 1, `active`). */
export async function seedResourceValues(
  db: Database,
  cfg: AppConfig,
  resource: Pick<SharedResourceRow, 'id' | 'tenantId'>,
  environment: AppEnvironmentName,
  values: Record<string, string> = { ...M365_VALUES },
  opts: SeedValuesOptions = {}
): Promise<SharedResourceValueRow> {
  const [row] = await db
    .insert(sharedResourceValues)
    .values({
      tenantId: resource.tenantId,
      resourceId: resource.id,
      environment,
      version: opts.version ?? 1,
      sealed: await sealValues(cfg, values),
      status: opts.status ?? 'active',
      setByUserId: opts.setByUserId ?? null,
      ...(opts.setAt ? { setAt: opts.setAt } : {}),
    })
    .returning()
  if (!row) throw new Error('seedResourceValues: no row')
  return row
}

export interface SeedGrantInput {
  tenantId: string
  appId: string
  resourceId: string
  environment: AppEnvironmentName
  status?: GrantStatus
  pushedVersionId?: string | null
  pushedAt?: Date | null
  approvalId?: string | null
  requestedByUserId?: string | null
  expiresAt?: Date | null
  reason?: string | null
}

export async function seedGrant(db: Database, input: SeedGrantInput): Promise<AppGrantRow> {
  const [row] = await db
    .insert(appGrants)
    .values({
      tenantId: input.tenantId,
      appId: input.appId,
      resourceId: input.resourceId,
      environment: input.environment,
      status: input.status ?? 'active',
      pushedVersionId: input.pushedVersionId ?? null,
      pushedAt: input.pushedAt ?? null,
      approvalId: input.approvalId ?? null,
      requestedByUserId: input.requestedByUserId ?? null,
      expiresAt: input.expiresAt ?? null,
      reason: input.reason ?? 'fixture',
    })
    .returning()
  if (!row) throw new Error('seedGrant: no row')
  return row
}

/** A service's dependencies over a test env (the approvals engine's shape — `GrantDeps` is it). */
export function grantDeps(db: Database, env: TestEnv, now?: () => Date): GrantDeps {
  return approvalDeps(db, env, now)
}

// ---- end to end (plan §4) ----------------------------------------------------------------------

/** Where `pnpm plugin add` puts the connector's manifest in an app repo. */
export const M365_ANCHOR = 'apps/web/src/plugins/m365-connector/plugin.json'

const M365_PLUGIN_JSON = readFileSync(
  path.resolve(__dirname, '../fixtures/plugins/m365-connector/plugin.json'),
  'utf8'
)

/** `launch.plugins.json` + the connector's `plugin.json`: an app repo with the M365 connector. */
export function m365Files(slug: string): Record<string, string> {
  return {
    'launch.plugins.json': JSON.stringify({
      kitVersion: '0.15.0',
      app: { slug, display: `App ${slug}`, domain: 'apps.test' },
      surfaces: [
        { id: 'm365-connector', kind: 'plugin', label: 'M365', anchor: M365_ANCHOR, paths: [] },
      ],
    }),
    [M365_ANCHOR]: M365_PLUGIN_JSON,
  }
}

/** The value a plugin install writes for the two vars (its `example`) — never a real credential. */
export const M365_TOML_PLACEHOLDER = 'from-the-toml'

/** `toml` with the connector's two non-secret vars in `[vars]`, as a plugin install leaves it. */
export function withM365Vars(toml: string): string {
  if (!toml.includes('[vars]\n')) throw new Error('withM365Vars: the toml has no [vars] table')
  return toml.replace(
    '[vars]\n',
    `[vars]\nM365_TENANT_ID = "${M365_TOML_PLACEHOLDER}"\nM365_CLIENT_ID = "${M365_TOML_PLACEHOLDER}"\n`
  )
}

/** The Entra token endpoint's view of the app registration: which client secrets work now. */
export class FakeAzure {
  readonly valid = new Set<string>()
  /** Every exchange: the tenant and client asked for, and whether it worked (never the secret). */
  readonly exchanges: { tenant: string; clientId: string; ok: boolean }[] = []

  install(cloud: FakeCloud): void {
    cloud.onHost('login.microsoftonline.com', req => {
      const tenant = req.url.pathname.split('/')[1] ?? ''
      const body = (req.json ?? {}) as { client_id?: string; client_secret?: string }
      const ok =
        tenant === M365_VALUES.M365_TENANT_ID &&
        body.client_id === M365_VALUES.M365_CLIENT_ID &&
        this.valid.has(body.client_secret ?? '')
      this.exchanges.push({ tenant, clientId: body.client_id ?? '', ok })
      return ok
        ? Response.json({ token_type: 'Bearer', access_token: 'fake-graph-token' })
        : Response.json({ error: 'invalid_client' }, { status: 401 })
    })
  }
}

/** The connector plugin on an app's host (header). */
export function m365Host(cloud: FakeCloud, target: { host: string; script: string }): void {
  cloud.onHost(target.host, async req => {
    const env = cloud.cloudflare.envOf(target.script)
    if (req.url.pathname === '/api/health') {
      if (!env) return Response.json({ error: 'placeholder Worker' }, { status: 503 })
      return Response.json({ status: 'ok', version: env.RELEASE_VERSION ?? null })
    }
    if (req.url.pathname !== '/api/connectors/m365/status') {
      return Response.json({ error: 'Not found', statusCode: 404 }, { status: 404 })
    }
    const missing = M365_ITEMS.map(i => i.key).filter(key => !env?.[key])
    if (missing.length > 0) {
      // The kit's missing-config convention: 503 naming the keys.
      return Response.json(
        { error: 'M365 is not configured', statusCode: 503, details: { missing } },
        { status: 503 }
      )
    }
    const exchange = await cloud.fetch(
      `https://login.microsoftonline.com/${env?.M365_TENANT_ID}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'client_credentials',
          client_id: env?.M365_CLIENT_ID,
          client_secret: env?.M365_CLIENT_SECRET,
          scope: 'https://graph.microsoft.com/.default',
        }),
      }
    )
    return exchange.ok
      ? Response.json({ status: 'connected' })
      : Response.json({ error: 'M365 refused the credentials', statusCode: 502 }, { status: 502 })
  })
}
