/**
 * Health polling for every registered app environment (spec/02 `health`, spec/06): the template's
 * two probes — `GET {url}/api/health` (liveness) and `GET {url}/api/ready` (readiness, a
 * `SELECT 1`) — each with a five-second timeout, on the `*\/5 * * * *` cron in `api/scheduled.ts`
 * and on demand from `POST /api/apps/:id/health-check`.
 *
 * - **Status**: `up` when both answer 200, `degraded` when health does and ready does not (the
 *   Worker runs, its database does not answer), otherwise `down` — a timeout, a DNS failure and a
 *   5xx from health all read the same to the person looking at the catalogue.
 * - **Writes per probe**: the environment's latest columns, one `app_health_checks` row, and an
 *   `app.health.changed` audit row **only on a transition**. The first observation of an
 *   environment (`unknown → x`) sets the baseline and is not audited — every import would
 *   otherwise log a "change" nobody made.
 * - **Per tenant, ten at a time** (the `runPruneAiSpans` pattern): tenants are listed from
 *   `tenants`, and every query below names one. Within a batch, environments are probed through a
 *   small pool — a Worker holds six connections open at once, and a request queued behind them
 *   would otherwise spend its timeout waiting.
 * - **Retention**: checks older than seven days are pruned per tenant on every run.
 */
import type { HealthStatus } from '@launch/shared/launch-apps'
import { and, eq, inArray, isNotNull, lt, ne } from 'drizzle-orm'
import { affected, type Database } from '../../../db/client'
import {
  type AppEnvironmentRow,
  appEnvironments,
  appHealthChecks,
  apps,
  tenants,
} from '../../../db/schema'
import type { ScheduledTask } from '../../scheduled'
import { recordAudit, SYSTEM_ACTOR } from './audit'

/** Per-probe timeout (spec/06). */
export const HEALTH_TIMEOUT_MS = 5000
/** How long `app_health_checks` rows are kept. */
export const HEALTH_RETENTION_DAYS = 7
/** Tenants handled per batch — the same figure `runPruneAiSpans` uses. */
const TENANT_CONCURRENCY = 10
/** Environments probed at once: two requests each, inside a Worker's six open connections. */
const ENVIRONMENT_CONCURRENCY = 3
/** The longest `health_error` kept — a probe's error is a sentence, not a response body. */
const ERROR_MAX = 300

export interface HealthPollOptions {
  /** Injected for tests; defaults to the global `fetch`. */
  fetch?: typeof fetch
  now?: Date
  /** Per-probe timeout; tests shorten it. */
  timeoutMs?: number
  /** Poll only these tenants (tests, so a run never probes another suite's environments). */
  tenantIds?: string[]
}

export interface HealthPollResult {
  /** Environments polled this run. */
  environments: number
  /** Environments whose status changed (each audited). */
  changed: number
  /** `app_health_checks` rows removed by the retention prune. */
  pruned: number
}

interface ProbeResult {
  status: number | null
  body: unknown
  error: string | null
  ms: number
}

function describeFailure(err: unknown, timeoutMs: number): string {
  const name = (err as { name?: unknown })?.name
  if (name === 'TimeoutError' || name === 'AbortError') return `timed out after ${timeoutMs} ms`
  const message = err instanceof Error ? err.message : String(err)
  return message.slice(0, ERROR_MAX)
}

/** One GET with its own timeout. Never throws: a failure is a result. */
async function probe(url: string, doFetch: typeof fetch, timeoutMs: number): Promise<ProbeResult> {
  const started = Date.now()
  try {
    const res = await doFetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'rocketflare-launch-health' },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    })
    let body: unknown = null
    try {
      body = await res.json()
    } catch {
      // A probe that is not JSON still has a status; that is all the verdict needs.
    }
    return { status: res.status, body, error: null, ms: Date.now() - started }
  } catch (err) {
    return {
      status: null,
      body: null,
      error: describeFailure(err, timeoutMs),
      ms: Date.now() - started,
    }
  }
}

export interface EnvironmentVerdict {
  status: Exclude<HealthStatus, 'unknown'>
  httpStatus: number | null
  readyStatus: number | null
  latencyMs: number
  version: string | null
  error: string | null
}

/** Both probes → one verdict. Exported for the unit test of the status rule. */
export function verdictOf(health: ProbeResult, ready: ProbeResult): EnvironmentVerdict {
  const status =
    health.status === 200 ? (ready.status === 200 ? 'up' : 'degraded') : ('down' as const)
  const version = (health.body as { version?: unknown } | null)?.version
  const problems = [
    health.status === 200
      ? null
      : `health: ${health.error ?? `HTTP ${health.status ?? 'no response'}`}`,
    ready.status === 200
      ? null
      : `ready: ${ready.error ?? `HTTP ${ready.status ?? 'no response'}`}`,
  ].filter((p): p is string => p !== null)
  return {
    status,
    httpStatus: health.status,
    readyStatus: ready.status,
    latencyMs: health.ms,
    version: typeof version === 'string' ? version.slice(0, 100) : null,
    error: problems.length ? problems.join('; ').slice(0, ERROR_MAX) : null,
  }
}

interface PolledEnvironment {
  env: AppEnvironmentRow
  appSlug: string
}

/**
 * Probe one environment and record the result. Returns the updated row and whether its status
 * changed (and was audited).
 */
async function pollEnvironment(
  db: Database,
  target: PolledEnvironment,
  doFetch: typeof fetch,
  timeoutMs: number,
  now: Date
): Promise<{ row: AppEnvironmentRow; changed: boolean }> {
  const { env } = target
  const base = (env.url ?? '').replace(/\/+$/, '')
  const [health, ready] = await Promise.all([
    probe(`${base}/api/health`, doFetch, timeoutMs),
    probe(`${base}/api/ready`, doFetch, timeoutMs),
  ])
  const verdict = verdictOf(health, ready)
  const previous = env.healthStatus
  const transitioned = previous !== verdict.status
  const audited = transitioned && previous !== 'unknown'

  const [row] = await db
    .update(appEnvironments)
    .set({
      healthStatus: verdict.status,
      healthCheckedAt: now,
      healthChangedAt: transitioned ? now : env.healthChangedAt,
      healthVersion: verdict.version,
      healthLatencyMs: verdict.latencyMs,
      healthError: verdict.error,
    })
    .where(and(eq(appEnvironments.tenantId, env.tenantId), eq(appEnvironments.id, env.id)))
    .returning()
  await db.insert(appHealthChecks).values({
    tenantId: env.tenantId,
    environmentId: env.id,
    checkedAt: now,
    status: verdict.status,
    httpStatus: verdict.httpStatus,
    readyStatus: verdict.readyStatus,
    latencyMs: verdict.latencyMs,
    version: verdict.version,
    error: verdict.error,
  })
  if (audited) {
    await recordAudit(db, {
      tenantId: env.tenantId,
      ...SYSTEM_ACTOR,
      action: 'app.health.changed',
      targetType: 'AppEnvironment',
      targetId: env.id,
      appId: env.appId,
      summary: {
        before: { status: previous },
        after: {
          status: verdict.status,
          environment: env.name,
          app: target.appSlug,
          ...(verdict.error ? { error: verdict.error } : {}),
        },
      },
    })
  }
  return { row: row ?? env, changed: audited }
}

/** Run `fn` over `items`, at most `limit` at a time, keeping the input order in the output. */
async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index] as T)
    }
  })
  await Promise.all(workers)
  return results
}

/** One tenant's pollable environments: a URL, on an app that is not archived. */
async function pollableEnvironments(
  db: Database,
  tenantId: string,
  appId?: string
): Promise<PolledEnvironment[]> {
  const rows = await db
    .select({ env: appEnvironments, appSlug: apps.slug })
    .from(appEnvironments)
    .innerJoin(apps, and(eq(apps.id, appEnvironments.appId), eq(apps.tenantId, tenantId)))
    .where(
      and(
        eq(appEnvironments.tenantId, tenantId),
        isNotNull(appEnvironments.url),
        ne(apps.status, 'archived'),
        appId ? eq(appEnvironments.appId, appId) : undefined
      )
    )
  return rows
}

/** One poll across every tenant — the cron's body. */
export async function runHealthPoll(
  db: Database,
  opts: HealthPollOptions = {}
): Promise<HealthPollResult> {
  const doFetch = opts.fetch ?? fetch
  const now = opts.now ?? new Date()
  const timeoutMs = opts.timeoutMs ?? HEALTH_TIMEOUT_MS
  const cutoff = new Date(now.getTime() - HEALTH_RETENTION_DAYS * 24 * 60 * 60 * 1000)
  const tenantRows = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(opts.tenantIds ? inArray(tenants.id, opts.tenantIds) : undefined)
  const result: HealthPollResult = { environments: 0, changed: 0, pruned: 0 }

  for (let i = 0; i < tenantRows.length; i += TENANT_CONCURRENCY) {
    const batch = tenantRows.slice(i, i + TENANT_CONCURRENCY)
    const perTenant = await Promise.all(
      batch.map(({ id: tenantId }) => pollableEnvironments(db, tenantId))
    )
    const targets = perTenant.flat()
    const outcomes = await pool(targets, ENVIRONMENT_CONCURRENCY, target =>
      pollEnvironment(db, target, doFetch, timeoutMs, now)
    )
    result.environments += outcomes.length
    result.changed += outcomes.filter(o => o.changed).length
    const pruned = await Promise.all(
      batch.map(async ({ id: tenantId }) =>
        affected(
          await db
            .delete(appHealthChecks)
            .where(
              and(eq(appHealthChecks.tenantId, tenantId), lt(appHealthChecks.checkedAt, cutoff))
            )
        )
      )
    )
    for (const count of pruned) result.pruned += count
  }
  return result
}

/**
 * Probe one app's environments now (`POST /api/apps/:id/health-check`) and return the updated
 * rows, staging first. The caller has already proved the app is this tenant's.
 */
export async function checkAppHealth(
  db: Database,
  tenantId: string,
  appId: string,
  opts: HealthPollOptions = {}
): Promise<AppEnvironmentRow[]> {
  const doFetch = opts.fetch ?? fetch
  const now = opts.now ?? new Date()
  const timeoutMs = opts.timeoutMs ?? HEALTH_TIMEOUT_MS
  const targets = await pollableEnvironments(db, tenantId, appId)
  const outcomes = await pool(targets, ENVIRONMENT_CONCURRENCY, target =>
    pollEnvironment(db, target, doFetch, timeoutMs, now)
  )
  const polled = new Set(outcomes.map(o => o.row.id))
  // Environments with no URL are returned as they are, so the caller sees the whole app.
  const rest = await db
    .select()
    .from(appEnvironments)
    .where(and(eq(appEnvironments.tenantId, tenantId), eq(appEnvironments.appId, appId)))
  return [...outcomes.map(o => o.row), ...rest.filter(r => !polled.has(r.id))]
}

/** The `*\/5` cron task, over the given options (a test injects `fetch` and its own tenants). */
export function healthPollTask(opts: HealthPollOptions = {}): ScheduledTask {
  return {
    name: 'healthPoll',
    async run({ db, logger }) {
      const result = await runHealthPoll(db, opts)
      logger.info(result, 'healthPoll: polled app environments')
    },
  }
}

/** The task the cron runs: every tenant, the global `fetch`. */
export const healthPoll: ScheduledTask = healthPollTask()
