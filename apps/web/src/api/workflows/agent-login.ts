/**
 * `AgentLoginWorkflow` (§18.22) — one instance per `agent_logins` row, bound as
 * `AGENT_LOGIN_WORKFLOW` (`launch-agent-login[-staging]`), shaped like `GrantPushWorkflow`.
 * `startLogin` (`services/sessions/logins/service.ts`) starts it with the login id as the instance
 * id; the params are `AgentLoginParams`, ids only.
 *
 *   start      → record the sandbox id, boot `login-<id>` (the `SessionSandbox` class, the
 *                driver's hosts on its allow-list), start the provider's CLI
 *   prompt#N   → wait for the URL (and Codex's device code) → `awaiting_user`
 *   code#N     → (a runtime that takes a code back) `step.waitForEvent(AGENT_LOGIN_CODE_EVENT)`;
 *   submit#N   →   hand the sealed code to the CLI → `finishing`
 *   finish#N   → wait for the CLI to exit
 *   capture    → seal the credential into `agent_credentials`; `succeeded`
 *   fail / expire → the row's terminal status, with a secret-free sentence
 *   cleanup    → ALWAYS: destroy the sandbox, null the URL / code
 *
 * Every step name is DISTINCT (`workflows/CLAUDE.md`); every step opens its own DB client
 * (`withStepDatabase`) and returns small JSON — never a row and never a secret. The bodies are
 * `services/sessions/logins/steps.ts`. `overrides` is for tests (ports, a driver, the clock).
 * Exported from `src/worker.ts`, never from `api/index.ts`.
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers'
import {
  AGENT_LOGIN_CODE_EVENT,
  AGENT_LOGIN_NEEDS_CODE,
  type AgentLoginParams,
  type AgentRuntimeId,
} from '@launch/shared/launch-agents'
import { and, eq } from 'drizzle-orm'
import { loadConfig } from '../../config'
import type { Database } from '../../db/client'
import { agentLogins } from '../../db/schema'
import {
  type LoginPoll,
  type LoginStepScope,
  loginCaptureStep,
  loginCleanupStep,
  loginFinishStep,
  loginPromptStep,
  loginSettleStep,
  loginStartStep,
  loginSubmitStep,
  MAX_LOGIN_ROUNDS,
} from '../services/sessions/logins/steps'
import { defaultSessionPorts, type SessionPorts } from '../services/sessions/ports'
import type { LoginDriver } from '../services/sessions/runtimes/types'
import type { AppBindings } from '../types'
import { loggerFor } from '../utils/core/logger'
import { withStepDatabase } from './agent-run'

/** What the tests hand the class instead of the real adapters. */
export interface AgentLoginWorkflowOverrides {
  ports?: Pick<SessionPorts, 'sandbox' | 'egress'>
  driverFor?: (runtime: AgentRuntimeId) => LoginDriver | undefined
  now?: () => Date
  sleep?: (ms: number) => Promise<void>
}

export interface AgentLoginOutcome {
  loginId: string
  /** How the run ended — the row holds the truth. */
  status: 'succeeded' | 'failed' | 'expired' | 'stopped'
}

/** Polling steps: a retry re-reads the row and the CLI, so they are idempotent. */
const LOGIN_STEP = {
  retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' },
  timeout: '5 minutes',
} as const
/** `capture` writes the credential once: a retry re-captures from the same file (idempotent). */
const CAPTURE_STEP = {
  retries: { limit: 1, delay: '5 seconds', backoff: 'constant' },
  timeout: '5 minutes',
} as const
/** Cleanup must happen: more retries, patient. */
const CLEANUP_STEP = {
  retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' },
  timeout: '5 minutes',
} as const

type StepConfig = typeof LOGIN_STEP | typeof CAPTURE_STEP | typeof CLEANUP_STEP

/** `step.do` without the platform's `Serializable<T>` bound (every body returns plain JSON). */
interface LooseLoginStep {
  do(name: string, config: StepConfig, fn: () => Promise<unknown>): Promise<unknown>
}

/** Raised inside the run when a polling loop runs past the login's TTL. */
class LoginExpired extends Error {}
/** Raised inside the run when the row was cancelled (or otherwise ended) under it. */
class LoginStopped extends Error {}

export class AgentLoginWorkflow extends WorkflowEntrypoint<AppBindings, AgentLoginParams> {
  /** Tests only — see the header. */
  overrides: AgentLoginWorkflowOverrides = {}

  async run(
    event: WorkflowEvent<AgentLoginParams>,
    step: WorkflowStep
  ): Promise<AgentLoginOutcome> {
    const params = event.payload
    const env = this.env
    const cfg = loadConfig(env)
    const logger = loggerFor(cfg, { handler: 'workflow', workflow: 'agent-login', ...params })
    // Where the login sandbox runs: frozen in the params when the sign-in started.
    const ports =
      this.overrides.ports ?? defaultSessionPorts(env, cfg, params.sandboxHost ?? 'local')
    const scopeOf = (db: Database): LoginStepScope => ({
      db,
      cfg,
      params,
      sandbox: name => ports.sandbox(name),
      prepareLogin: async (sandbox, runtime) => {
        await ports.egress?.(db).prepareLogin?.(sandbox, runtime)
      },
      logger,
      now: this.overrides.now ?? (() => new Date()),
      sleep: this.overrides.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))),
      ...(this.overrides.driverFor ? { driverFor: this.overrides.driverFor } : {}),
    })
    const run = <T>(
      name: string,
      body: (scope: LoginStepScope) => Promise<T>,
      config: StepConfig = LOGIN_STEP
    ): Promise<T> =>
      (step as unknown as LooseLoginStep).do(name, config, () =>
        withStepDatabase(env, cfg, db => body(scopeOf(db)))
      ) as Promise<T>

    /** Run `name#N` until it answers `ready`; `stopped` / `expired` end the login. */
    const poll = async (name: string, body: (s: LoginStepScope) => Promise<LoginPoll>) => {
      for (let n = 0; n < MAX_LOGIN_ROUNDS; n++) {
        const result = await run(`${name}#${n}`, body)
        if (result.state === 'ready') return
        if (result.state === 'stopped') throw new LoginStopped()
        if (result.state === 'expired') throw new LoginExpired()
      }
      throw new LoginExpired()
    }

    let outcome: AgentLoginOutcome['status'] = 'failed'
    try {
      const started = await run('start', loginStartStep)
      if (!started.go) {
        outcome = 'stopped'
        return { loginId: params.loginId, status: outcome }
      }
      await poll('prompt', loginPromptStep)

      const runtime = await run('runtime', async scope => {
        const [row] = await scope.db
          .select({ runtime: agentLogins.runtime })
          .from(agentLogins)
          .where(and(eq(agentLogins.tenantId, params.tenantId), eq(agentLogins.id, params.loginId)))
          .limit(1)
        return row?.runtime ?? null
      })
      if (!runtime) throw new LoginStopped()

      if (AGENT_LOGIN_NEEDS_CODE[runtime]) {
        let submitted = false
        for (let n = 0; n < MAX_LOGIN_ROUNDS && !submitted; n++) {
          try {
            await step.waitForEvent(`code#${n}`, {
              type: AGENT_LOGIN_CODE_EVENT,
              timeout: '15 minutes',
            })
          } catch {
            // The wait timed out: the submit step reads the row and says `expired` (or a code
            // that arrived as the wait gave up is still there to submit).
          }
          const result = await run(`submit#${n}`, loginSubmitStep)
          if (result.state === 'ready') submitted = true
          else if (result.state === 'stopped') throw new LoginStopped()
          else if (result.state === 'expired') throw new LoginExpired()
        }
        if (!submitted) throw new LoginExpired()
      }

      let exited = false
      for (let n = 0; n < MAX_LOGIN_ROUNDS && !exited; n++) {
        const result = await run(`finish#${n}`, loginFinishStep)
        if (result.state === 'exited') exited = true
        else if (result.state === 'stopped') throw new LoginStopped()
        else if (result.state === 'expired') throw new LoginExpired()
      }
      if (!exited) throw new LoginExpired()

      const captured = await run('capture', loginCaptureStep, CAPTURE_STEP)
      outcome = captured.ok ? 'succeeded' : 'stopped'
      return { loginId: params.loginId, status: outcome }
    } catch (err) {
      if (err instanceof LoginStopped) {
        outcome = 'stopped'
      } else if (err instanceof LoginExpired) {
        outcome = 'expired'
        await run('expire', scope => loginSettleStep(scope, 'expired', null))
      } else {
        outcome = 'failed'
        logger.warn({ err }, 'agent-login: a step failed past its retries')
        await run('fail', scope => loginSettleStep(scope, 'failed', err))
      }
      return { loginId: params.loginId, status: outcome }
    } finally {
      await run('cleanup', loginCleanupStep, CLEANUP_STEP).catch(err =>
        logger.error({ err }, 'agent-login: cleanup failed past its retries')
      )
    }
  }
}
