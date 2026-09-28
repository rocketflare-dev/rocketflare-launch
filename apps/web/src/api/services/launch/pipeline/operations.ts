/**
 * `runStep` (Launch P2) — one pipeline step's durable record in `app_operations`, and the reason a
 * retried run resumes rather than repeats. Every step of `AppLaunchWorkflow` and
 * `AppTeardownWorkflow` runs its body through this, inside its `step.do`:
 *
 * - The row is keyed `(run_id, step)` (`app_operations_run_step_key`). A row that already
 *   `succeeded` (or was `skipped`) is NOT run again: its stored `externalIds` come back and `fn` is
 *   never called — which is what makes a retry instance `<runId>-rN` with the same `runId` skip
 *   everything that worked.
 * - Otherwise the row becomes `running` with `attempt + 1`, and `fn(ctx)` gets `ctx.prior` (the ids
 *   an earlier, failed attempt recorded — "the KV namespace already exists, adopt it") and
 *   `ctx.record(partial)`, which writes ids to the row IMMEDIATELY. Record each id the moment the
 *   vendor returns it: a throw two calls later must not orphan what the first call created.
 * - It ends `succeeded` with `fn`'s returned ids merged in, or `failed` with the error message
 *   passed through `scrub()` (every value handed to `ctx.redact` is masked), and the ORIGINAL error
 *   rethrown so the Workflow's retry policy sees it.
 *
 * **Ids only.** `externalIds` is shown on the app page and returned from `step.do` (Workflows
 * persist step results), so a secret never goes in it — the step that mints a secret puts it on the
 * Worker in the same step and records nothing but the resource id.
 */
import type { AppOperationExternalIds } from '@launch/shared/launch-apps'
import { and, eq, notInArray, sql } from 'drizzle-orm'
import type { Database } from '../../../../db/client'
import { type AppOperationRow, appOperations } from '../../../../db/schema'
import { scrub } from '../setup'

export interface StepKey {
  tenantId: string
  appId: string
  runId: string
  /** `create` | `teardown` (`PIPELINE_KINDS`). */
  kind: string
  /** The `app_operations.step` key — `APP_LAUNCH_STEPS[i].step`. */
  step: string
}

export interface StepContext {
  /** Ids an earlier attempt of this step recorded (`{}` on the first). */
  readonly prior: Readonly<AppOperationExternalIds>
  /** This attempt's number, 1-based. */
  readonly attempt: number
  /** Merge ids into the row NOW, before the next vendor call can throw. */
  record(partial: AppOperationExternalIds): Promise<void>
  /** Values to mask if they turn up in the error message (a password, a token). */
  redact(...values: (string | null | undefined)[]): void
}

export interface StepResult {
  externalIds: AppOperationExternalIds
  /** True when the row had already succeeded and `fn` did not run. */
  skipped: boolean
  attempt: number
}

/** Statuses a re-entered step does not run again. */
const SETTLED = ['succeeded', 'skipped'] as const

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function readStep(db: Database, key: StepKey): Promise<AppOperationRow | null> {
  const [row] = await db
    .select()
    .from(appOperations)
    .where(
      and(
        eq(appOperations.tenantId, key.tenantId),
        eq(appOperations.runId, key.runId),
        eq(appOperations.step, key.step)
      )
    )
    .limit(1)
  return row ?? null
}

export interface RunStepOptions {
  /**
   * The row may already be `running` because `openWait` opened it when the job started: carry on
   * with that attempt and its `startedAt` (the wait's whole duration) rather than counting a new
   * attempt. A `failed` row still counts one.
   */
  continuesWait?: boolean
}

/** Run one step at most once to success. See the header for the contract. */
export async function runStep(
  db: Database,
  key: StepKey,
  fn: (ctx: StepContext) => Promise<AppOperationExternalIds | undefined | void>,
  options: RunStepOptions = {}
): Promise<StepResult> {
  const now = new Date()
  const open = sql`${appOperations.status} = 'running'`
  const [claimed] = await db
    .insert(appOperations)
    .values({
      tenantId: key.tenantId,
      appId: key.appId,
      runId: key.runId,
      kind: key.kind,
      step: key.step,
      status: 'running',
      attempt: 1,
      startedAt: now,
    })
    .onConflictDoUpdate({
      target: [appOperations.runId, appOperations.step],
      set: options.continuesWait
        ? {
            status: 'running',
            attempt: sql`CASE WHEN ${open} THEN ${appOperations.attempt} ELSE ${appOperations.attempt} + 1 END`,
            error: null,
            startedAt: sql`CASE WHEN ${open} THEN ${appOperations.startedAt} ELSE ${now.toISOString()}::timestamptz END`,
            finishedAt: null,
            updatedAt: now,
          }
        : {
            status: 'running',
            attempt: sql`${appOperations.attempt} + 1`,
            error: null,
            startedAt: now,
            finishedAt: null,
            updatedAt: now,
          },
      setWhere: and(
        eq(appOperations.tenantId, key.tenantId),
        notInArray(appOperations.status, [...SETTLED])
      ),
    })
    .returning()

  if (!claimed) {
    const settled = await readStep(db, key)
    if (!settled) throw new Error(`app_operations ${key.runId}/${key.step} vanished mid-claim`)
    return { externalIds: settled.externalIds, skipped: true, attempt: settled.attempt }
  }

  let ids: AppOperationExternalIds = { ...claimed.externalIds }
  const secrets: string[] = []
  const ctx: StepContext = {
    prior: { ...claimed.externalIds },
    attempt: claimed.attempt,
    async record(partial) {
      ids = { ...ids, ...partial }
      await db
        .update(appOperations)
        .set({
          externalIds: sql`${appOperations.externalIds} || ${JSON.stringify(partial)}::jsonb`,
          updatedAt: new Date(),
        })
        .where(and(eq(appOperations.tenantId, key.tenantId), eq(appOperations.id, claimed.id)))
    },
    redact(...values) {
      for (const v of values) if (v) secrets.push(v)
    },
  }

  try {
    const returned = await fn(ctx)
    if (returned) ids = { ...ids, ...returned }
    await db
      .update(appOperations)
      .set({ status: 'succeeded', externalIds: ids, finishedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(appOperations.tenantId, key.tenantId), eq(appOperations.id, claimed.id)))
    return { externalIds: ids, skipped: false, attempt: claimed.attempt }
  } catch (err) {
    await db
      .update(appOperations)
      .set({
        status: 'failed',
        error: scrub(errorMessage(err), secrets),
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(appOperations.tenantId, key.tenantId), eq(appOperations.id, claimed.id)))
    throw err
  }
}

/**
 * Record a step that deliberately did not run (P2's `production`: "waits for the first release and
 * an owner's approval"). Idempotent; a settled row is left alone.
 */
export async function skipStep(db: Database, key: StepKey, reason?: string): Promise<void> {
  const now = new Date()
  await db
    .insert(appOperations)
    .values({
      tenantId: key.tenantId,
      appId: key.appId,
      runId: key.runId,
      kind: key.kind,
      step: key.step,
      status: 'skipped',
      error: reason ?? null,
      startedAt: now,
      finishedAt: now,
    })
    .onConflictDoUpdate({
      target: [appOperations.runId, appOperations.step],
      set: { status: 'skipped', error: reason ?? null, finishedAt: now, updatedAt: now },
      setWhere: and(
        eq(appOperations.tenantId, key.tenantId),
        notInArray(appOperations.status, [...SETTLED])
      ),
    })
}

// ---- waits ---------------------------------------------------------------------------------------

/**
 * Open a WAIT's row (`scaffold.wait`, `deploy_staging.wait`) as `running` the moment the step that
 * started its job has dispatched it — so the step list shows the job running rather than a tick on
 * "Start …" and a hollow circle — with no ids yet. A row left by an earlier job (failed, or open
 * from a job a retry replaced) is restarted: attempt + 1, error and ids cleared. A settled row is
 * left alone.
 */
export async function openWait(db: Database, key: StepKey): Promise<void> {
  const now = new Date()
  await db
    .insert(appOperations)
    .values({
      tenantId: key.tenantId,
      appId: key.appId,
      runId: key.runId,
      kind: key.kind,
      step: key.step,
      status: 'running',
      attempt: 1,
      startedAt: now,
    })
    .onConflictDoUpdate({
      target: [appOperations.runId, appOperations.step],
      set: {
        status: 'running',
        attempt: sql`${appOperations.attempt} + 1`,
        error: null,
        externalIds: {},
        startedAt: now,
        finishedAt: null,
        updatedAt: now,
      },
      setWhere: and(
        eq(appOperations.tenantId, key.tenantId),
        notInArray(appOperations.status, [...SETTLED])
      ),
    })
}

/** Merge ids into a row that is still `running` (a wait learning its job's run id and URL). */
export async function recordRunningIds(
  db: Database,
  key: StepKey,
  partial: AppOperationExternalIds
): Promise<void> {
  await db
    .update(appOperations)
    .set({
      externalIds: sql`${appOperations.externalIds} || ${JSON.stringify(partial)}::jsonb`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(appOperations.tenantId, key.tenantId),
        eq(appOperations.runId, key.runId),
        eq(appOperations.step, key.step),
        eq(appOperations.status, 'running')
      )
    )
}

/**
 * Mark a step `failed` with `message` (scrubbed), keeping the ids it recorded — for a failure found
 * OUTSIDE the step's body (a wait's poll, a cancel). Inserts the row when there is none; a settled
 * row is left alone. Does not throw.
 */
export async function failOpenStep(
  db: Database,
  key: StepKey,
  message: string,
  secrets: readonly string[] = []
): Promise<void> {
  const now = new Date()
  const error = scrub(message, secrets)
  await db
    .insert(appOperations)
    .values({
      tenantId: key.tenantId,
      appId: key.appId,
      runId: key.runId,
      kind: key.kind,
      step: key.step,
      status: 'failed',
      attempt: 1,
      error,
      startedAt: now,
      finishedAt: now,
    })
    .onConflictDoUpdate({
      target: [appOperations.runId, appOperations.step],
      set: { status: 'failed', error, finishedAt: now, updatedAt: now },
      setWhere: and(
        eq(appOperations.tenantId, key.tenantId),
        notInArray(appOperations.status, [...SETTLED])
      ),
    })
}
