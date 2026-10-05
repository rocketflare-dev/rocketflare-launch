/**
 * Issue #9: the gate attestation — `ship.attest#N`, right after `ship.commit#N` pushed a GREEN
 * gate's commit. Launch's GitHub App posts ONE check run on the pushed head (`RepoHostPort
 * .createCheckRun`), so the kit's CI can see that the sandbox gate already passed on this content
 * and skip running it again (the kit's `verified` job reads it; Launch itself never counts it as
 * CI — `requiredCheckState`):
 *
 *   name         `launch/gate` (`LAUNCH_GATE_CHECK`)
 *   head_sha     the pushed commit (`sessions.head_sha` after `ship.commit`)
 *   status       `completed`, conclusion `success` — never posted for a red gate (the step only
 *                runs on the green path, after `ship.commit` asserted the commit's tree IS the
 *                tree the gate's last step read)
 *   external_id  `tree:<HEAD^{tree}>` — a result belongs to a TREE: a squash or a release bump
 *                gets a new commit sha over the same tree
 *   output       `title` a short line; `summary` a markdown table of the steps run (step, command,
 *                duration); `text` JSON `{ tree, sessionId, attempt, steps: [{ step, command,
 *                durationMs }] }`
 *
 * The steps are read back from the attempt's own `ship.gate` events (the green ones, last per
 * step), so the Workflow carries nothing new. **Idempotent**: `createCheckRun` reads the head's
 * runs first and answers one with the same name and `external_id` (a step retried after GitHub
 * took the POST posts nothing new); a replayed step is the platform's cached result.
 *
 * **Never fails the ship**: an attestation is an optimisation for CI. Any failure — no `checks:
 * write` on an installation that has not accepted it yet, GitHub down — is a log line and ONE
 * `error` event saying the PR's CI runs the whole gate itself, and the ship carries on.
 */
import {
  LAUNCH_GATE_CHECK,
  launchGateExternalId,
  SHIP_GATE_STEP_LABELS,
  type ShipGateStep,
  sessionShipGateDataSchema,
} from '@launch/shared/launch-sessions'
import { and, asc, eq, sql } from 'drizzle-orm'
import { sessionEvents } from '../../../db/schema'
import { safeErrorMessage } from './events'
import type { CreateCheckRunInput } from './ports'
import { sessionRepo } from './ship'
import { emitterFor, loadSession, type StepScope, vendorCall } from './steps'

/** One gate step as the attestation names it. */
export interface AttestedGateStep {
  step: ShipGateStep
  command: string
  durationMs: number
}

export interface LaunchGateAttestation {
  tree: string
  headSha: string
  sessionId: string
  /** The session's short id, for the summary's sentence (not in `text`). */
  shortId: string
  /** The green attempt's number (numbered across the session's ships, as on `ship.gate`). */
  attempt: number
  steps: AttestedGateStep[]
}

/** `12.3 s`, `4 min 05 s`. */
export function formatGateDuration(ms: number): string {
  const seconds = Math.max(0, ms) / 1000
  if (seconds < 60) return `${seconds.toFixed(1)} s`
  const whole = Math.round(seconds)
  return `${Math.floor(whole / 60)} min ${String(whole % 60).padStart(2, '0')} s`
}

/** A markdown table cell: no pipe ends it early, no backtick escapes the code span. */
const cell = (text: string) => text.replace(/[`\r\n]/g, ' ').replace(/\|/g, '\\|')

/** The `launch/gate` check run for a green gate — the contract in the header, exactly. */
export function launchGateCheckRun(input: LaunchGateAttestation): CreateCheckRunInput {
  const names = input.steps.map(s => SHIP_GATE_STEP_LABELS[s.step].toLowerCase()).join(', ')
  const rows = input.steps.map(
    s => `| ${s.step} | \`${cell(s.command)}\` | ${formatGateDuration(s.durationMs)} |`
  )
  const summary = [
    `Launch ran the gate in coding session \`${input.shortId}\` (attempt ${input.attempt}) on tree \`${input.tree}\`, and it passed, before it pushed this commit.`,
    '',
    '| Step | Command | Duration |',
    '| --- | --- | --- |',
    ...rows,
  ].join('\n')
  const text = JSON.stringify({
    tree: input.tree,
    sessionId: input.sessionId,
    attempt: input.attempt,
    steps: input.steps.map(s => ({ step: s.step, command: s.command, durationMs: s.durationMs })),
  })
  return {
    name: LAUNCH_GATE_CHECK,
    headSha: input.headSha,
    externalId: launchGateExternalId(input.tree),
    conclusion: 'success',
    output: { title: `Launch gate passed${names ? `: ${names}` : ''}`, summary, text },
  }
}

/** The attempt's green `ship.gate` rows, in order, the last row per step (a retried step's). */
export async function greenGateSteps(
  scope: StepScope,
  attempt: number
): Promise<AttestedGateStep[]> {
  const rows = await scope.db
    .select({ data: sessionEvents.data })
    .from(sessionEvents)
    .where(
      and(
        eq(sessionEvents.tenantId, scope.params.tenantId),
        eq(sessionEvents.sessionId, scope.params.sessionId),
        eq(sessionEvents.type, 'ship.gate'),
        sql`(${sessionEvents.data}->>'attempt')::int = ${attempt}`
      )
    )
    .orderBy(asc(sessionEvents.seq))
  const steps = new Map<ShipGateStep, AttestedGateStep>()
  for (const row of rows) {
    const data = sessionShipGateDataSchema.safeParse(row.data)
    if (!data.success || !data.data.passed || !data.data.step || !data.data.command) continue
    steps.delete(data.data.step)
    steps.set(data.data.step, {
      step: data.data.step,
      command: data.data.command,
      durationMs: data.data.durationMs ?? 0,
    })
  }
  return [...steps.values()]
}

/** The `error` event's sentence when the attestation could not be posted. */
export function attestFailedMessage(detail: string): string {
  return `The gate passed, but Launch could not record it on GitHub as the \`${LAUNCH_GATE_CHECK}\` check (${detail}), so the pull request's CI runs the whole gate itself. The ship carries on. If GitHub says the App lacks a permission, an organisation owner must accept the Launch GitHub App's new "Checks: read and write" permission on its installation.`
}

export interface ShipAttestResult {
  posted: boolean
  /** False when an earlier try's run was found (or there is no GitHub: `local`). */
  created?: boolean
}

/**
 * `ship.attest#N`: the `launch/gate` check run on `head_sha` for the gate's `tree` (see the
 * header). Never throws.
 */
export async function shipAttestStep(
  scope: StepScope,
  input: { attempt: number; tree: string }
): Promise<ShipAttestResult> {
  let turn = 0
  try {
    const session = await loadSession(scope)
    turn = session.turnCount
    if (session.status !== 'shipping' || !session.headSha) return { posted: false }
    const steps = await greenGateSteps(scope, input.attempt)
    const repo = await sessionRepo(scope.db, session)
    const run = launchGateCheckRun({
      tree: input.tree,
      headSha: session.headSha,
      sessionId: session.id,
      shortId: session.shortId,
      attempt: input.attempt,
      steps,
    })
    const result = await vendorCall(scope, `GitHub (the ${LAUNCH_GATE_CHECK} check run)`, () =>
      scope.ports.repoHost(scope.db).createCheckRun(repo, run)
    )
    return { posted: result.id !== null, created: result.created }
  } catch (err) {
    scope.logger.warn({ err }, 'session ship: could not post the launch/gate check run')
    try {
      await emitterFor(scope)({
        type: 'error',
        turn,
        data: { message: attestFailedMessage(safeErrorMessage(err, 'GitHub did not answer', 300)) },
      })
    } catch (emitErr) {
      scope.logger.warn({ err: emitErr }, 'session ship: could not record the attestation failure')
    }
    return { posted: false }
  }
}
