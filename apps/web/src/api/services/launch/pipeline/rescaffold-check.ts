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
 *   ACTIVATED (`activated_at`, set only by `activate`: a version merely uploaded, then closed by
 *   `finish` because the job died before `activate`, never served a request), or one that was
 *   handed the migrator credential (its migrations may have run against the database, whatever
 *   became of the upload after).
 *
 * The checks run cheapest first, so the ticket query is only made for a failed run.
 */
import type { PipelineRunStatus, RescaffoldPipelineCode } from '@launch/shared/launch-pipeline'
import { and, eq, isNotNull, or, sql } from 'drizzle-orm'
import type { Database } from '../../../../db/client'
import { type AppRow, deployTickets } from '../../../../db/schema'

export interface RescaffoldBlock {
  code: RescaffoldPipelineCode
  message: string
}

const UPGRADE = 'a deployed app takes a kit upgrade instead'

/**
 * Whether any deploy of the app ever went out (see the header): `activated` when a version went
 * live, `migrated` when none did but a job was handed the migrator credential, else null.
 */
export async function deployEvidence(
  db: Database,
  tenantId: string,
  appId: string
): Promise<'activated' | 'migrated' | null> {
  const rows = await db
    .select({ activatedAt: deployTickets.activatedAt })
    .from(deployTickets)
    .where(
      and(
        eq(deployTickets.tenantId, tenantId),
        eq(deployTickets.appId, appId),
        eq(deployTickets.purpose, 'deploy'),
        or(isNotNull(deployTickets.activatedAt), isNotNull(deployTickets.credentialsIssuedAt))
      )
    )
    .orderBy(sql`${deployTickets.activatedAt} IS NULL`)
    .limit(1)
  const [row] = rows
  if (!row) return null
  return row.activatedAt ? 'activated' : 'migrated'
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
  const evidence = await deployEvidence(db, tenantId, app.id)
  if (evidence === 'activated') {
    return {
      code: 'app_already_deployed',
      message: `This app has already deployed, so a new scaffold would replace code that ran: ${UPGRADE}`,
    }
  }
  if (evidence === 'migrated') {
    return {
      code: 'app_already_deployed',
      message: `A deploy of this app was given its database migration credentials, so its migrations may have run: ${UPGRADE}`,
    }
  }
  return null
}
