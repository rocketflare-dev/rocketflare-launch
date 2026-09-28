/**
 * Whether an app may be RE-SCAFFOLDED (`POST /api/apps/:id/pipeline/rescaffold`, `rescaffold.ts`)
 * — kept apart from the action so the pipeline view (`runs.ts`) can answer `canRescaffold` without
 * importing it. A re-scaffold replaces the code on `main` with a fresh scaffold from the CURRENT
 * kit pin, which is only safe while nothing but the scaffold and Launch's config commit is there
 * and no build of it ever ran:
 *
 * - the app is not `archived` (`app_archived`) and not `live` (`app_live`);
 * - it has a create run (`no_run` — an imported app never has) and that run is `failed`
 *   (`run_not_failed`; Stop makes a stuck one failed);
 * - it has NEVER deployed (`app_already_deployed`): no `deploy`-purpose ticket that went out — one
 *   `active`/`finished` WITH an uploaded version (a job that died at its gate still calls `finish`,
 *   which closes an `approved` ticket as `finished` with no version, and that one never ran), or
 *   one that was handed the migrator credential (its migrations may have run against the
 *   database, whatever became of the upload after).
 *
 * The checks run cheapest first, so the ticket query is only made for a failed run.
 */
import type { PipelineRunStatus, RescaffoldPipelineCode } from '@launch/shared/launch-pipeline'
import { and, eq, inArray, isNotNull, or } from 'drizzle-orm'
import type { Database } from '../../../../db/client'
import { type AppRow, deployTickets } from '../../../../db/schema'

export interface RescaffoldBlock {
  code: RescaffoldPipelineCode
  message: string
}

const UPGRADE = 'a deployed app takes a kit upgrade instead'

/** Whether any deploy of the app ever went out (see the header). */
export async function hasEverDeployed(
  db: Database,
  tenantId: string,
  appId: string
): Promise<boolean> {
  const [row] = await db
    .select({ id: deployTickets.id })
    .from(deployTickets)
    .where(
      and(
        eq(deployTickets.tenantId, tenantId),
        eq(deployTickets.appId, appId),
        eq(deployTickets.purpose, 'deploy'),
        or(
          and(
            inArray(deployTickets.status, ['active', 'finished']),
            isNotNull(deployTickets.cfVersionId)
          ),
          isNotNull(deployTickets.credentialsIssuedAt)
        )
      )
    )
    .limit(1)
  return Boolean(row)
}

/** Why the app may not be re-scaffolded now, or null when it may. */
export async function rescaffoldBlock(
  db: Database,
  tenantId: string,
  app: Pick<AppRow, 'id' | 'status' | 'source'>,
  run: { runId: string | null; status: PipelineRunStatus }
): Promise<RescaffoldBlock | null> {
  if (app.status === 'archived') {
    return { code: 'app_archived', message: 'An archived app cannot be re-scaffolded' }
  }
  if (app.status === 'live') {
    return {
      code: 'app_live',
      message: `This app is live, so its code is not the scaffold's to replace: ${UPGRADE}`,
    }
  }
  if (app.source !== 'created' || !run.runId || run.status === 'none') {
    return { code: 'no_run', message: 'This app has no launch to re-scaffold' }
  }
  if (run.status !== 'failed') {
    return {
      code: 'run_not_failed',
      message: `Only a failed launch can be re-scaffolded (this one is ${run.status})`,
    }
  }
  if (await hasEverDeployed(db, tenantId, app.id)) {
    return {
      code: 'app_already_deployed',
      message: `This app has already deployed, so a new scaffold would replace code that ran: ${UPGRADE}`,
    }
  }
  return null
}
