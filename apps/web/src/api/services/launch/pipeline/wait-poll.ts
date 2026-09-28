/**
 * Polling a launch's open WAIT on read (Launch P2) — `GET /api/apps/:id/pipeline`'s look at the
 * job a run is waiting on, so a job that died on GitHub shows on the page at the next read instead
 * of at the Workflow's next round.
 *
 * Inside the Workflow a wait is rounds (`launch-steps.ts`): `…poll#N`, then `waitForEvent` for one
 * round (1 minute for the scaffold, 3 for the staging deploy). A job that dies before it reaches
 * Launch sends no event, so the failure waits for the next poll — up to one round deployed, and
 * for ever under local wrangler, whose `waitForEvent` timeout does not always wake the instance.
 * The reconcile (`reconcile.ts`) cannot help: the instance says `waiting`, which is healthy.
 *
 * So on read, for the latest create run whose `scaffold.wait` / `deploy_staging.wait` row is
 * `running`:
 *
 * 1. **Throttled in the database, per wait row**: a compare-and-set stamps `readPolledAt` in the
 *    row's `external_ids` when the last stamp is older than {@link WAIT_POLL_WINDOW_MS} (20 s),
 *    and only the request whose update landed polls — however many tabs read the page. The row's
 *    `updated_at` is left as it was: it is the reconcile's staleness clock, and a read must not
 *    keep a dead run looking fresh. No migration: `external_ids` is jsonb, and a retry's
 *    `openWait` clears it with the rest of the dead job's ids.
 * 2. **The wait's own poll** (`scaffoldPoll` / `deployPoll`) with the request's deps — the same
 *    function the Workflow runs, so the run's `runId`/`runUrl` are recorded the moment GitHub lists
 *    it, and a run that concluded non-success fails the wait with the same readable message.
 * 3. **Settled** (failed, or the job is done) → the event the wait listens for
 *    (`SCAFFOLD_FINISHED_EVENT` / `DEPLOY_FINISHED_EVENT`) goes to the live instance
 *    (`launchInstanceOf`), so a live Workflow wakes and its next poll proceeds or fails. A failed
 *    wait also fails the app now (`markLaunchFailed`, `app.launch_failed` with the step's error —
 *    once: the Workflow's own failure path finds it failed and writes nothing). The run derives
 *    `failed` from the row either way, so Retry is offered even if the instance never wakes.
 *
 * {@link pollOpenWaitsSafely} is what the route calls: it never throws into the request.
 */
import {
  type AppLaunchParams,
  DEPLOY_FINISHED_EVENT,
  SCAFFOLD_FINISHED_EVENT,
} from '@launch/shared/launch-pipeline'
import { and, eq, sql } from 'drizzle-orm'
import type { Database } from '../../../../db/client'
import { type AppOperationRow, type AppRow, appOperations } from '../../../../db/schema'
import { markLaunchFailed } from './create'
import { launchInstanceOf } from './instance'
import { deployPoll, type PipelineDeps, scaffoldPoll, type WaitState } from './launch-steps'
import type { ReconcileLogger } from './reconcile'
import { deriveRunStatus, latestRunId, runRows } from './runs'

/** One read poll per wait row per window, however many readers. */
export const WAIT_POLL_WINDOW_MS = 20_000

/** The `external_ids` key the read poll's claim is stamped under (an ISO time). */
export const WAIT_POLL_CLAIM_KEY = 'readPolledAt'

/** The slice of `APP_LAUNCH_WORKFLOW` a nudge needs — `RecordingWorkflow` satisfies it. */
export interface WaitEventSender {
  get(id: string): Promise<{ sendEvent(event: { type: string; payload?: unknown }): Promise<void> }>
}

interface OpenWait {
  poll: (d: PipelineDeps, params: AppLaunchParams) => Promise<WaitState>
  event: string
}

const OPEN_WAITS: Record<string, OpenWait> = {
  'scaffold.wait': { poll: scaffoldPoll, event: SCAFFOLD_FINISHED_EVENT },
  'deploy_staging.wait': { poll: deployPoll, event: DEPLOY_FINISHED_EVENT },
}

export interface PolledWait {
  step: string
  state: WaitState
  /** Whether the wait's event reached the instance (settled waits only). */
  notified: boolean
}

export interface WaitPollResult {
  /** The waits this read polled — empty when none was open, or another reader holds the window. */
  polled: PolledWait[]
}

/** Take the wait row's read-poll turn: true for the one request whose compare-and-set landed. */
async function claimTurn(
  db: Database,
  tenantId: string,
  row: AppOperationRow,
  now: Date
): Promise<boolean> {
  const cutoff = new Date(now.getTime() - WAIT_POLL_WINDOW_MS).toISOString()
  const stamp = JSON.stringify({ [WAIT_POLL_CLAIM_KEY]: now.toISOString() })
  const claimed = await db
    .update(appOperations)
    .set({
      externalIds: sql`${appOperations.externalIds} || ${stamp}::jsonb`,
      // Kept: `updated_at` is the reconcile's staleness clock, not a read counter.
      updatedAt: sql`${appOperations.updatedAt}`,
    })
    .where(
      and(
        eq(appOperations.tenantId, tenantId),
        eq(appOperations.id, row.id),
        eq(appOperations.status, 'running'),
        // ISO-8601 UTC stamps order as text; no stamp yet is ''.
        sql`coalesce(${appOperations.externalIds} ->> ${WAIT_POLL_CLAIM_KEY}, '') < ${cutoff}`
      )
    )
    .returning({ id: appOperations.id })
  return claimed.length > 0
}

/** Poll the latest create run's open waits (see the header). Throws on a database or vendor error. */
export async function pollOpenWaits(
  db: Database,
  deps: PipelineDeps,
  workflow: WaitEventSender | undefined,
  tenantId: string,
  app: AppRow,
  options: { now?: Date; logger?: ReconcileLogger } = {}
): Promise<WaitPollResult> {
  const now = options.now ?? new Date()
  const runId = await latestRunId(db, tenantId, app, 'create')
  if (!runId) return { polled: [] }
  const rows = await runRows(db, tenantId, runId)
  if (rows.length === 0 || deriveRunStatus('create', rows) !== 'running') return { polled: [] }
  const open = rows.filter(r => r.status === 'running' && OPEN_WAITS[r.step])
  const polled: PolledWait[] = []
  for (const row of open) {
    const wait = OPEN_WAITS[row.step] as OpenWait
    if (!(await claimTurn(db, tenantId, row, now))) continue
    const params: AppLaunchParams = {
      tenantId,
      appId: app.id,
      runId,
      userId: null,
      options: { deployStaging: true },
    }
    const state = await wait.poll(deps, params)
    let notified = false
    if (state.done) {
      if (state.error && app.status === 'provisioning') {
        await markLaunchFailed(
          db,
          tenantId,
          app.id,
          runId,
          new Error(`${row.step}: ${state.error}`)
        )
      }
      notified = await nudge(workflow, launchInstanceOf(app, runId), wait.event, options.logger)
    }
    polled.push({ step: row.step, state, notified })
  }
  return { polled }
}

/** Send the wait's event to the instance — best effort: the rows are the truth. */
async function nudge(
  workflow: WaitEventSender | undefined,
  instanceId: string,
  type: string,
  logger?: ReconcileLogger
): Promise<boolean> {
  if (!workflow) return false
  try {
    await (await workflow.get(instanceId)).sendEvent({ type, payload: { polledOnRead: true } })
    return true
  } catch (err) {
    logger?.warn({ err, instanceId, type }, 'wait poll: could not wake the launch run')
    return false
  }
}

/** {@link pollOpenWaits} for a route: any error is logged and the request carries on. */
export async function pollOpenWaitsSafely(
  db: Database,
  deps: PipelineDeps,
  workflow: WaitEventSender | undefined,
  tenantId: string,
  app: AppRow,
  options: { now?: Date; logger?: ReconcileLogger } = {}
): Promise<WaitPollResult> {
  try {
    return await pollOpenWaits(db, deps, workflow, tenantId, app, options)
  } catch (err) {
    options.logger?.error({ err, appId: app.id }, 'wait poll on read failed; the view is unchanged')
    return { polled: [] }
  }
}
