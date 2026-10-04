/**
 * The `SessionWorkflow`'s step retry policies (`workflows/session.ts`), here rather than in the
 * Workflow so the reconcile (`reconcile.ts`) can derive its stall windows from them: a healthy
 * instance between two attempts of a step writes no heartbeat, so a window must outlast the
 * longest retry delay ({@link longestRetryDelayMs}).
 */
import type { WorkflowStepConfig } from 'cloudflare:workers'

/** Boot steps: a few retries — each is idempotent (`steps.ts`). */
export const BOOT_STEP: WorkflowStepConfig = {
  retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' },
  timeout: '20 minutes',
}
/** Salvage: its sandbox calls are bounded and caught, so a retry only covers the database. */
export const SALVAGE_STEP: WorkflowStepConfig = {
  retries: { limit: 1, delay: '5 seconds', backoff: 'constant' },
  timeout: '15 minutes',
}
/** Cleanup must happen: more retries, patient. */
export const CLEANUP_STEP: WorkflowStepConfig = {
  retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' },
  timeout: '5 minutes',
}
/** The ship's short steps (claim, save, commit, summary, the PR, settle) and the landing's: idempotent, retried. */
export const SHIP_STEP: WorkflowStepConfig = {
  retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' },
  timeout: '10 minutes',
}
/** A gate command's retry (see {@link gateStepConfig}). */
const GATE_RETRIES = { limit: 1, delay: '5 seconds', backoff: 'constant' } as const
/**
 * A gate command: ONE retry, which re-attaches to the command still running
 * (`runInBackground`), and the command's own deadline plus a margin — the command is killed at
 * its deadline first, so the step answers red rather than being cut off.
 */
export function gateStepConfig(timeoutMs: number): WorkflowStepConfig {
  return { retries: GATE_RETRIES, timeout: `${Math.ceil(timeoutMs / 60_000) + 5} minutes` }
}
/**
 * A Phase B round's step (issue #5): the hooks are I/O against GitHub, Cloudflare and the app's
 * health; a throw after these retries counts as one more round, never a failed session.
 */
export const LAND_PHASE_B_STEP: WorkflowStepConfig = {
  retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' },
  timeout: '10 minutes',
}

const UNIT_MS: Record<string, number> = {
  second: 1000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
}

/** A Workflow duration (`'5 seconds'`, or milliseconds) in milliseconds. */
function durationMs(value: unknown): number {
  if (typeof value === 'number') return value
  const match =
    typeof value === 'string' ? /^(\d+)\s+(second|minute|hour|day)s?$/.exec(value) : null
  if (!match) throw new Error(`step-config: unsupported duration ${String(value)}`)
  return Number(match[1]) * (UNIT_MS[match[2] as string] ?? 0)
}

/**
 * The longest the platform waits between two attempts of a step with this config: the LAST retry's
 * delay (`exponential` doubles it each time, `linear` adds it). 0 with no retries.
 */
export function longestRetryDelayMs(config: WorkflowStepConfig): number {
  const retries = config.retries
  if (!retries || retries.limit <= 0) return 0
  const base = durationMs(retries.delay)
  switch (retries.backoff) {
    case 'exponential':
      return base * 2 ** (retries.limit - 1)
    case 'linear':
      return base * retries.limit
    default:
      return base
  }
}
