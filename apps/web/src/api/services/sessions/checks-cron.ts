/**
 * The `sessions.checks` cron task (Launch P3, plan §1.10): on the `*\/5` schedule, every shipped
 * session whose PR's CI is still pending (or was never read) gets its checks refreshed
 * (`runSessionChecks` in `ship.ts`), so the session page and the app's sessions card show green
 * or red without anyone having to open the PR. Reads also refresh on demand (`GET
 * /api/sessions/:id/pr`, at most every 30 s); this is what settles a PR nobody is looking at.
 *
 * Registered in `api/scheduled.ts` under `'*\/5 * * * *'`, beside `healthPoll`.
 */
import type { Database } from '../../../db/client'
import type { ScheduledTask } from '../../scheduled'
import { defaultSessionPorts, type RepoHostPort } from './ports'
import { runSessionChecks } from './ship'

/** The task over an injected repo host (tests); the default binds the backend's own. */
export function sessionsChecksTask(repoHostFor?: (db: Database) => RepoHostPort): ScheduledTask {
  return {
    name: 'sessions.checks',
    async run({ db, env, config, logger }) {
      const result = await runSessionChecks(
        db,
        repoHostFor ?? (d => defaultSessionPorts(env, config).repoHost(d))
      )
      logger.info(result, 'sessions.checks: refreshed pending pull request checks')
    },
  }
}

export const sessionsChecks: ScheduledTask = sessionsChecksTask()
