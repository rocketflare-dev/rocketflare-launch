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
 * - it has NEVER deployed (`app_already_deployed`): no `deploy`-purpose ticket ACTIVATED
 *   (`activated_at`, set only by `activate`: a version merely uploaded, then closed by `finish`
 *   because the job died before `activate`, never served a request);
 * - and, when a never-activated deploy ticket was handed the migrator credential, that
 *   environment's DATABASE says no migration ran (`rescaffold-database.ts`). The credential alone
 *   is only a proxy — the kit's `db:migrate:ci` can fail in its role phase before any migration —
 *   so the database is asked: rows in `drizzle.__drizzle_migrations` or any table in `public`
 *   block it ("staging has N applied migrations"), an empty database allows it, and a Neon that
 *   cannot answer blocks it, conservatively, saying why. Only the environments whose tickets got
 *   the credential are asked (staging; production too if one of its tickets ever got it).
 *
 * `rescaffoldVerdict` is the cheap part (Postgres only): the pipeline view uses it, so a GET never
 * calls a vendor, and it names in `checkDatabases` the environments the POST will ask about.
 * `rescaffoldBlock` is the definitive answer the POST acts on — the verdict, then those databases.
 *
 * The checks run cheapest first, so the ticket query is only made for a failed run.
 */
import type { AppEnvironmentName } from '@launch/shared/launch-apps'
import type { PipelineRunStatus, RescaffoldPipelineCode } from '@launch/shared/launch-pipeline'
import { and, eq, isNotNull, or } from 'drizzle-orm'
import type { Database } from '../../../../db/client'
import { type AppRow, appEnvironments, deployTickets } from '../../../../db/schema'
import type { NeonClient } from '../neon'
import { databaseEvidence } from './rescaffold-database'

export interface RescaffoldBlock {
  code: RescaffoldPipelineCode
  message: string
}

/** The cheap answer: blocked, or allowed once the named environments' databases are empty. */
export type RescaffoldVerdict =
  | { block: RescaffoldBlock }
  | { block: null; checkDatabases: AppEnvironmentName[] }

const UPGRADE = 'a deployed app takes a kit upgrade instead'
const ENV_ORDER: readonly AppEnvironmentName[] = ['staging', 'production']

/**
 * Whether any deploy of the app went out (see the header): `activated` when a version went live;
 * else `credentials` with the environments whose tickets were handed the migrator credential;
 * else null.
 */
export async function deployEvidence(
  db: Database,
  tenantId: string,
  appId: string
): Promise<
  { kind: 'activated' } | { kind: 'credentials'; environments: AppEnvironmentName[] } | null
> {
  const rows = await db
    .select({ activatedAt: deployTickets.activatedAt, environment: appEnvironments.name })
    .from(deployTickets)
    .innerJoin(
      appEnvironments,
      and(
        eq(appEnvironments.id, deployTickets.environmentId),
        eq(appEnvironments.tenantId, deployTickets.tenantId)
      )
    )
    .where(
      and(
        eq(deployTickets.tenantId, tenantId),
        eq(deployTickets.appId, appId),
        eq(deployTickets.purpose, 'deploy'),
        or(isNotNull(deployTickets.activatedAt), isNotNull(deployTickets.credentialsIssuedAt))
      )
    )
  if (rows.length === 0) return null
  if (rows.some(r => r.activatedAt)) return { kind: 'activated' }
  const seen = new Set(rows.map(r => r.environment))
  return { kind: 'credentials', environments: ENV_ORDER.filter(e => seen.has(e)) }
}

/** Why the app may not be re-scaffolded, from Postgres alone — never a vendor call. */
export async function rescaffoldVerdict(
  db: Database,
  tenantId: string,
  app: Pick<AppRow, 'id' | 'status' | 'source'>,
  run: { runId: string | null; status: PipelineRunStatus }
): Promise<RescaffoldVerdict> {
  if (app.status === 'archived') {
    return { block: { code: 'app_archived', message: 'An archived app cannot be re-scaffolded' } }
  }
  if (app.status === 'live') {
    return {
      block: {
        code: 'app_live',
        message: `This app is live, so its code is not the scaffold's to replace: ${UPGRADE}`,
      },
    }
  }
  if (app.source !== 'created' || !run.runId || run.status === 'none') {
    return { block: { code: 'no_run', message: 'This app has no launch to re-scaffold' } }
  }
  if (run.status !== 'failed') {
    return {
      block: {
        code: 'run_not_failed',
        message: `Only a failed launch can be re-scaffolded (this one is ${run.status})`,
      },
    }
  }
  const evidence = await deployEvidence(db, tenantId, app.id)
  if (evidence?.kind === 'activated') {
    return {
      block: {
        code: 'app_already_deployed',
        message: `This app has already deployed, so a new scaffold would replace code that ran: ${UPGRADE}`,
      },
    }
  }
  return { block: null, checkDatabases: evidence?.environments ?? [] }
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

/**
 * Ask each environment's database whether a migration ran (see the header). Null when every one
 * is empty; otherwise the block, with the count — or with why Neon could not be asked.
 */
export async function databaseBlock(
  db: Database,
  tenantId: string,
  appId: string,
  environments: readonly AppEnvironmentName[],
  loadNeon: () => Promise<NeonClient | null>
): Promise<RescaffoldBlock | null> {
  if (environments.length === 0) return null
  const given = 'A deploy of this app was given its database migration credentials'
  const unchecked = (why: string) => ({
    code: 'app_already_deployed' as const,
    message: `${given}, and Launch could not check its database (${why}), so its migrations may have run: try again once Neon answers`,
  })
  const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))
  // Where each database is, before any vendor call: nothing recorded means nothing to ask.
  const rows = await db
    .select({ name: appEnvironments.name, neon: appEnvironments.neon })
    .from(appEnvironments)
    .where(and(eq(appEnvironments.tenantId, tenantId), eq(appEnvironments.appId, appId)))
  const targets = environments.map(name => ({
    name,
    neon: rows.find(r => r.name === name)?.neon ?? null,
  }))
  const unrecorded = targets.find(t => !t.neon?.projectId || !t.neon.branchId)
  if (unrecorded) return unchecked(`no Neon branch is recorded for ${unrecorded.name}`)
  let client: NeonClient | null
  try {
    client = await loadNeon()
  } catch (err) {
    return unchecked(`Neon's key could not be read: ${errorText(err)}`)
  }
  if (!client) return unchecked('Neon is not connected in Setup')
  for (const { name, neon } of targets) {
    let found: Awaited<ReturnType<typeof databaseEvidence>>
    try {
      found = await databaseEvidence(client, neon)
    } catch (err) {
      return unchecked(`${name}: ${errorText(err)}`)
    }
    if (found.migrations > 0 || found.tables > 0) {
      const counts = [
        found.migrations > 0 ? plural(found.migrations, 'applied migration') : null,
        found.tables > 0 ? `${plural(found.tables, 'table')} in public` : null,
      ]
      const what = `${name} has ${counts.filter(Boolean).join(' and ')}`
      return {
        code: 'app_already_deployed',
        message: `${given} and its database is not empty (${what}), so a new scaffold would replace code that already ran against it: ${UPGRADE}`,
      }
    }
  }
  return null
}

/**
 * Why the app may not be re-scaffolded now, or null when it may — the POST's definitive check:
 * the verdict, then (only when a credential went out and nothing activated) the databases.
 */
export async function rescaffoldBlock(
  db: Database,
  tenantId: string,
  app: Pick<AppRow, 'id' | 'status' | 'source'>,
  run: { runId: string | null; status: PipelineRunStatus },
  loadNeon: () => Promise<NeonClient | null>
): Promise<RescaffoldBlock | null> {
  const verdict = await rescaffoldVerdict(db, tenantId, app, run)
  if (verdict.block) return verdict.block
  return databaseBlock(db, tenantId, app.id, verdict.checkDatabases, loadNeon)
}
