/**
 * Issue #8: how long each phase of a session's boot took — the baseline every boot change is
 * measured against.
 *
 * - **Each boot step times itself** (`withProgress`, `steps.ts`): its result carries a
 *   {@link BootStepTiming} — when it started and how long it ran, by the step's own clock. The
 *   Workflow collects them from step RESULTS (replayed unchanged), never from a clock read of its
 *   own, and hands them to the boot's LAST step (`dev`, on every kind of boot).
 * - **That step writes ONE `boot.timing` event** ({@link bootTimingData}: the phases it was given
 *   plus its own; `bootstrap` split into `install` and the kit `bootstrap` after it) and records
 *   the same phases as spans (`session.boot`, one child per phase) through the tracer, so `launch
 *   traces` shows a boot. Timing is a courtesy: a failure to write it is logged, never a failed boot.
 * - **The first turn's first token** is not known when the boot is done: it is the turn's own
 *   `turn.end` `firstTokenMs` (`turn.ts`), which the UI and `launch sessions show` pair with the
 *   boot before it.
 */
import type { BootTimingPhase, SessionBootTimingData } from '@launch/shared/launch-sessions'
import { databaseSpanStore } from '../../observability/span-store'
import { rootSpanIdForRun, traceIdForRun } from '../../observability/trace-ids'
import { tracerFor } from '../../observability/tracing'
import type { BootPhase, StepScope } from './steps'

/** One boot step's clock: epoch ms at its start and how long it ran. */
export interface BootStepTiming {
  phase: BootPhase
  startedAt: number
  ms: number
  /** The `bootstrap` step's dependency install (`sessionBootstrap`'s `installMs`), when it ran one. */
  installMs?: number
}

/**
 * What the boot's last step is told: which kind of boot this is, and the timings of the steps
 * before it. An entry may be missing — a step result cached by a Launch from before issue #8 and
 * replayed after its deploy carries none — and is then left out.
 */
export interface BootTimingFinish {
  kind: SessionBootTimingData['kind']
  before: readonly (BootStepTiming | undefined)[]
}

/** The checklist key → the `boot.timing` phase it is reported as. */
const PHASE_OF: Record<BootPhase, BootTimingPhase> = {
  db: 'db',
  prepare: 'prepare',
  branch: 'branch',
  sandbox: 'sandbox.start',
  restore: 'restore',
  repo: 'repo',
  bootstrap: 'bootstrap',
  dev: 'dev',
  transcript: 'transcript',
  prebuild: 'prebuild',
}

/**
 * A boot step's timing, from its clock readings; `installMs` when the result reports an install
 * that ran (a restored workspace's bootstrap, `reused`, ran none — nor did one on a prebuild whose
 * lockfile matched, `installed: false`, issue #16).
 */
export function stepTiming(
  phase: BootPhase,
  startedAt: number,
  endedAt: number,
  result: unknown
): BootStepTiming {
  const { installMs, reused, installed } = (result ?? {}) as {
    installMs?: unknown
    reused?: unknown
    installed?: unknown
  }
  return {
    phase,
    startedAt,
    ms: Math.max(0, endedAt - startedAt),
    ...(typeof installMs === 'number' && reused !== true && installed !== false
      ? { installMs }
      : {}),
  }
}

/** The `boot.timing` payload for the steps that ran, in the order they started. Pure. */
export function bootTimingData(
  kind: SessionBootTimingData['kind'],
  steps: readonly (BootStepTiming | undefined)[]
): SessionBootTimingData {
  const ran = steps
    .filter((s): s is BootStepTiming => s !== undefined)
    .sort((a, b) => a.startedAt - b.startedAt)
  const start = Math.min(...ran.map(s => s.startedAt))
  const end = Math.max(...ran.map(s => s.startedAt + s.ms))
  const phases: SessionBootTimingData['phases'] = []
  for (const s of ran) {
    const startMs = Math.round(s.startedAt - start)
    const ms = Math.round(s.ms)
    if (s.phase === 'bootstrap' && s.installMs !== undefined) {
      const install = Math.min(ms, Math.round(s.installMs))
      phases.push({ phase: 'install', startMs, ms: install })
      phases.push({ phase: 'bootstrap', startMs: startMs + install, ms: ms - install })
    } else {
      phases.push({ phase: PHASE_OF[s.phase], startMs, ms })
    }
  }
  return { kind, totalMs: ran.length ? Math.round(end - start) : 0, phases }
}

/**
 * Write the boot's `boot.timing` event and its spans (see the header). The trace id is derived
 * from the session and the boot's first start, so a retried last step joins the same trace.
 */
export async function recordBootTiming(
  scope: StepScope,
  finish: BootTimingFinish,
  own: BootStepTiming,
  emit: (data: SessionBootTimingData) => Promise<void>
): Promise<void> {
  const steps = [...finish.before, own]
  const data = bootTimingData(finish.kind, steps)
  const start = Math.min(...steps.map(s => s?.startedAt ?? own.startedAt))
  const { sessionId, tenantId } = scope.params
  const key = `${sessionId}:boot:${start}`
  const tracer = tracerFor(scope.cfg, { logger: scope.logger, store: databaseSpanStore(scope.db) })
  let traceId: string | undefined
  if (tracer.enabled) {
    traceId = traceIdForRun(key)
    const root = tracer.startTrace({
      name: 'session-boot',
      spanName: `session.boot ${finish.kind}`,
      kind: 'job',
      tenantId,
      sessionId,
      traceId,
      spanId: rootSpanIdForRun(key),
      startTime: new Date(start),
      tags: ['session', 'boot'],
      metadata: { sessionId, kind: finish.kind, totalMs: data.totalMs },
    })
    for (const p of data.phases) {
      root.span({
        name: `boot.${p.phase}`,
        startTime: new Date(start + p.startMs),
        endTime: new Date(start + p.startMs + p.ms),
        attributes: { 'launch.boot.phase': p.phase, 'launch.boot.ms': p.ms },
      })
    }
    root.end()
  }
  await emit({ ...data, ...(traceId ? { traceId } : {}) })
  await tracer.flush()
}
