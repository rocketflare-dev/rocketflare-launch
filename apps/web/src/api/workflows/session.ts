/**
 * `SessionWorkflow` (Launch P3, plan §1.2) — one instance per coding session, bound as
 * `SESSION_WORKFLOW` (`launch-session[-staging]`). `createSession` starts it with the session id as
 * the instance id (`<id>-rN` after a restart); the params are `SessionWorkflowParams`
 * (`@launch/shared/launch-sessions`), ids only.
 *
 * The shape slice 3b builds (every step name DISTINCT — a name is its identity to the platform, and
 * a repeated one replays the first call's result, `workflows/CLAUDE.md`):
 *
 *   claim → db → sandbox.start → repo → bootstrap → dev (emits `preview.ready`)
 *   → loop: wait#N (`waitForEvent(SESSION_WAKE_EVENT, idle timeout)`) → one of
 *           turn#N (3c) · checkpoint#N · suspend#N · resume#N (boot again, `#K` suffixes) ·
 *           ship (3d) · end
 *   → cleanup (ALWAYS: destroy the sandbox, delete the branch)
 *
 * - One DB client per step (`withStepDatabase`, `agent-run.ts`) and nudges through
 *   `createStepRealtime().settle()` — no `waitUntil` in a step.
 * - The row is the truth: a wake carries nothing, and each step re-reads `pending_message`,
 *   `requested_action` and `cancel_requested_at`. Every transition is a compare-and-set on status.
 * - No secret in any step result or event: a step returns ids and flags.
 *
 * `overrides.ports` is for tests (`FakeSandbox`, the FakeCloud-backed db and repo ports, fake
 * Anthropic); production uses `defaultSessionPorts(env, cfg)`. Exported from `src/worker.ts`, never
 * from `api/index.ts`.
 *
 * **Slice 3b owns this file.** From 3a it is a stub whose `run` throws `NotWiredError`.
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers'
import type { SessionWorkflowParams } from '@launch/shared/launch-sessions'
import { NotWiredError, type SessionPorts } from '../services/sessions/ports'
import type { AppBindings } from '../types'

/** What the tests hand the class instead of the real adapters. */
export interface SessionWorkflowOverrides {
  ports?: SessionPorts
  /** A no-wait sleep for the polling helpers. */
  sleep?: (ms: number) => Promise<void>
}

export interface SessionOutcome {
  sessionId: string
  status: string
}

export class SessionWorkflow extends WorkflowEntrypoint<AppBindings, SessionWorkflowParams> {
  /** Tests only — see the header. */
  overrides: SessionWorkflowOverrides = {}

  async run(
    _event: WorkflowEvent<SessionWorkflowParams>,
    _step: WorkflowStep
  ): Promise<SessionOutcome> {
    throw new NotWiredError('SessionWorkflow.run', '3b')
  }
}
