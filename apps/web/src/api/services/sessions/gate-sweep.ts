/**
 * `sessions.gate-sweep` — the `*\/5` cron's backstop for the ship gate's throwaway database branches
 * (issue #1, `gate-branch.ts`). A gate branch lives for one attempt's test step and is deleted by
 * `ship.db-clean` right after it, by the next attempt's `ship.db`, by the round's settle after a
 * thrown step, and by cleanup (before the session's own branch). This finds what all of those
 * missed — a Workflow instance that died between `ship.db` and its clean, a Neon call that failed
 * every retry — by NAME: every branch of an app's Neon project matching `gate-<short>-<n>` and
 * created more than `GATE_BRANCH_MAX_AGE_MS` ago is deleted. No row records a gate branch, so
 * nothing can drift out of step with Neon.
 *
 * Only apps that have run a session are looked at (`apps.session_db` set: their `dev` exists),
 * each through its production environment's Neon project. Cross-tenant by design, like every
 * cron: each app is read with its own tenant id. One app's failure is logged and the sweep moves
 * on.
 */
import { and, eq, isNotNull } from 'drizzle-orm'
import type { Database } from '../../../db/client'
import { appEnvironments, apps } from '../../../db/schema'
import type { ScheduledTask } from '../../scheduled'
import type { Logger } from '../../utils/core/logger'
import { GATE_BRANCH_MAX_AGE_MS } from './gate-branch'
import { defaultSessionPorts, type SessionAppRef, type SessionDbPort } from './ports'

export interface GateSweepResult {
  apps: number
  deleted: number
  failed: number
}

/** Sweep every session-running app's project for gate branches older than `maxAgeMs`. */
export async function runGateSweep(
  db: Database,
  sessionDb: (db: Database) => SessionDbPort,
  opts: { now?: Date; maxAgeMs?: number; logger?: Pick<Logger, 'warn' | 'info'> } = {}
): Promise<GateSweepResult> {
  const now = opts.now ?? new Date()
  const olderThan = new Date(now.getTime() - (opts.maxAgeMs ?? GATE_BRANCH_MAX_AGE_MS))
  const rows = await db
    .select({ app: apps, neon: appEnvironments.neon })
    .from(apps)
    .innerJoin(
      appEnvironments,
      and(
        eq(appEnvironments.tenantId, apps.tenantId),
        eq(appEnvironments.appId, apps.id),
        eq(appEnvironments.name, 'production')
      )
    )
    .where(isNotNull(apps.sessionDb))
  const port = sessionDb(db)
  const out: GateSweepResult = { apps: 0, deleted: 0, failed: 0 }
  for (const { app, neon } of rows) {
    const projectId = neon?.projectId
    if (!projectId) continue
    out.apps++
    const ref: SessionAppRef = {
      id: app.id,
      tenantId: app.tenantId,
      slug: app.slug,
      repoOwner: app.repoOwner ?? '',
      repoName: app.repoName ?? '',
      defaultBranch: app.defaultBranch ?? 'main',
      neonProjectId: projectId,
      sessionDb: app.sessionDb ?? null,
    }
    try {
      const deleted = await port.sweepGateBranches(ref, olderThan)
      out.deleted += deleted.length
      if (deleted.length > 0) {
        opts.logger?.info(
          { appId: app.id, tenantId: app.tenantId, branches: deleted },
          'sessions.gate-sweep: deleted orphaned gate branches'
        )
      }
    } catch (err) {
      out.failed++
      opts.logger?.warn({ err, appId: app.id }, 'sessions.gate-sweep: could not sweep an app')
    }
  }
  return out
}

/** The task over an injected database port (tests); the default binds the backend's own. */
export function sessionsGateSweepTask(
  sessionDbFor?: (db: Database) => SessionDbPort
): ScheduledTask {
  return {
    name: 'sessions.gate-sweep',
    async run({ db, env, config, logger }) {
      const result = await runGateSweep(
        db,
        sessionDbFor ?? (d => defaultSessionPorts(env, config).sessionDb(d)),
        { logger }
      )
      logger.info(result, 'sessions.gate-sweep: swept the ship gate branches')
    },
  }
}

export const sessionsGateSweep: ScheduledTask = sessionsGateSweepTask()
