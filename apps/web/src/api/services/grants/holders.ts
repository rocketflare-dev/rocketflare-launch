/**
 * What an app holds, as the deploy gateway asks it (Launch P5, plan §1.5, §1.6, §4 5d):
 *
 * - `grantedKeys`: every item key of every LIVE grant of the app in `environment` — `uploadDeploy`
 *   drops the toml's `plain_text` / `json` bindings with those names and records them as
 *   `shadowedVars` (the grant wins, and the app's repo needs no change). LIVE includes
 *   `requested`: the first deploy after a request already stops shipping the var, so the push that
 *   follows the approval never meets a plain var of the same name (Cloudflare's 10053);
 * - `pushedSince`: the ACTIVE grants of the app in `environment` whose last push landed after
 *   `since` — `activateDeploy` passes the moment its upload began and starts a `repair` push for
 *   each, because `keep_bindings` copied the secrets as of the upload and activating would undo a
 *   newer push. A grant that is no longer active has nothing to re-push.
 *
 * Both name the tenant first; neither reads a value.
 *
 * **Slice 5d owns this file.**
 */
import type { AppEnvironmentName } from '@launch/shared/launch-apps'
import { LIVE_GRANT_STATUSES } from '@launch/shared/launch-grants'
import { and, eq, gt, inArray } from 'drizzle-orm'
import type { Database } from '../../../db/client'
import { type AppGrantRow, appGrants, sharedResources } from '../../../db/schema'

export async function grantedKeys(
  db: Database,
  tenantId: string,
  appId: string,
  environment: AppEnvironmentName
): Promise<string[]> {
  const rows = await db
    .select({ items: sharedResources.items })
    .from(appGrants)
    .innerJoin(
      sharedResources,
      and(
        eq(sharedResources.id, appGrants.resourceId),
        eq(sharedResources.tenantId, appGrants.tenantId)
      )
    )
    .where(
      and(
        eq(appGrants.tenantId, tenantId),
        eq(appGrants.appId, appId),
        eq(appGrants.environment, environment),
        inArray(appGrants.status, [...LIVE_GRANT_STATUSES])
      )
    )
  const keys = new Set<string>()
  for (const row of rows) for (const item of row.items) keys.add(item.key)
  return [...keys].sort()
}

export async function pushedSince(
  db: Database,
  tenantId: string,
  appId: string,
  environment: AppEnvironmentName,
  since: Date
): Promise<AppGrantRow[]> {
  return db
    .select()
    .from(appGrants)
    .where(
      and(
        eq(appGrants.tenantId, tenantId),
        eq(appGrants.appId, appId),
        eq(appGrants.environment, environment),
        eq(appGrants.status, 'active'),
        gt(appGrants.pushedAt, since)
      )
    )
}
