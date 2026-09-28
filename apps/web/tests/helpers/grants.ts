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
 * The plan's end-to-end helpers (`seedM365(cloud)`, `installM365`, `m365Host`) are added here by
 * the integration pass. Slice 5a owns this file; a slice that needs a helper of its own writes it
 * in its own test file (or stops and reports).
 */
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
