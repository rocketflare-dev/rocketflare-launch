/**
 * Health polling for every registered app environment (spec/06): `GET {url}/api/health` and
 * `/api/ready`, the environment's latest status, one `app_health_checks` row per poll, an
 * `app.health.changed` audit row on a transition, and a seven-day prune. Registered on the
 * `*\/5 * * * *` cron in `api/scheduled.ts`.
 *
 * STUB (slice 1a): the task is registered and dispatches, and polls nothing. Slice 1d owns this
 * file and keeps the two exported names — `scheduled.ts` imports `healthPoll`.
 */
import type { Database } from '../../../db/client'
import type { ScheduledTask } from '../../scheduled'

export interface HealthPollOptions {
  /** Injected for tests; defaults to the global `fetch`. */
  fetch?: typeof fetch
  now?: Date
}

export interface HealthPollResult {
  /** Environments polled this run. */
  environments: number
  /** Environments whose status changed (each audited). */
  changed: number
  /** `app_health_checks` rows removed by the retention prune. */
  pruned: number
}

/** One poll across every tenant. */
export async function runHealthPoll(
  _db: Database,
  _opts: HealthPollOptions = {}
): Promise<HealthPollResult> {
  return { environments: 0, changed: 0, pruned: 0 }
}

/** The `*\/5` cron task. */
export const healthPoll: ScheduledTask = {
  name: 'healthPoll',
  async run({ db, logger }) {
    const result = await runHealthPoll(db)
    logger.info(result, 'healthPoll: polled app environments')
  },
}
