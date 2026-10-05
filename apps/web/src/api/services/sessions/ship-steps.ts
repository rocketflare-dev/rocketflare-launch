/**
 * The ship's Workflow steps (issue #1, docs/CONCEPTS.md §18.13) — the bodies `workflows/session.ts`
 * runs for a `ship` round `N`, each a plain function over a `StepScope` like `steps.ts`'s:
 *
 *   ship.claim#N        `ready → shipping` (the request consumed); the attempt numbering, the policy
 *   ship.save#N         checkpoint what the person's turns left unsaved — the gate can take half an
 *                       hour, and a container that dies meanwhile must not take their work with it
 *   ship.kit#N          which commands the checkout's kit takes (`GATE_KIT_PROBE`): its own
 *                       `pnpm gate` steps (0.16.0+, from `pnpm gate --list --json`), the legacy
 *                       `test:ephemeral` three (0.15.7+), or neither — a red row, no fix turn
 *   per attempt A (numbered across the session's ships, so a gate branch name is never reused):
 *     ship.tree#N.A       the tree the attempt starts on (issue #21): the last step compares it
 *     ship.gate#N.A.lint, ship.gate#N.A.typecheck      the kit's commands, run by Launch
 *     ship.db#N.A         the throwaway gate branch `gate-<short>-<A>` (a child of the session's)
 *     ship.gate#N.A.test  `pnpm gate test` on it, with the kit's three variables
 *     ship.db-clean#N.A   ALWAYS after `ship.db` (a `finally`): the session's gate branches deleted
 *     ship.fix#N.A        red, and attempts left: ONE focused turn with the failing command and
 *                         the tail of its output (`session-ship-fix`)
 *   green: ship.commit#N (refused unless the workspace is still the tree the gate's last step
 *     read — issue #9) → ship.attest#N (the `launch/gate` check run on the pushed head,
 *     `gate-attest.ts`; never fails the ship) → ship.summary#N (one cheap model call: the PR's
 *     title and body, and the diff stat) → ship.pr#N (`shipped` in `pr` mode; issue #5's `staging` mode stays `shipping`
 *     with its landing in `ci`, and the loop's `land` rounds — `land.ts` — take it from there)
 *   otherwise: ship.settle#N (`shipping → ready`, with a sentence saying why no PR)
 *
 * Rules on top of `steps.ts`'s:
 *
 * - **The exit codes decide.** No model call decides whether the gate passed; a green gate makes
 *   exactly one model call, the summary, and a failed summary falls back rather than blocks.
 * - **One `ship.gate` event per step** (`{ step, passed, attempt, command, durationMs, output }`,
 *   and the test step's `target` line), the output a redacted tail (`gateOutputTail`): the gate
 *   branch's URL never reaches an event, a step result, a log line or a prompt. Before it, ONE
 *   `status: 'running'` row when the step starts (`ship.db`'s with `phase: 'database'`), so the
 *   panel says what is running now; a retried step finds its own and writes none
 *   (`gateStepStarted`).
 * - **A lost container suspends, never `ready`.** Every step that touches the container first
 *   reads the boot marker (`boot-marker.ts`); one that came back empty (or died under a gate
 *   command or a fix turn) is `shipping → suspended` with a resume requested, an `error` event,
 *   and the container destroyed — the loop then resumes from the last checkpoint, and the person
 *   ships again. `ship.save` means that checkpoint includes everything up to the ship.
 * - **An end stops the gate.** `POST /:id/end` is accepted while `shipping`: a gate command sees it
 *   within `endPollMs` (its process group killed), a fix turn is cancelled
 *   (`cancel_requested_at`), and the round settles so the loop's next `inspect` ends the session.
 * - **Idempotent.** A retried gate step re-attaches to the command still running
 *   (`runInBackground`) and mints no new password for it; `ship.db` finds its branch by name;
 *   `ship.pr` answers the PR already opened.
 */
import { resolveAppShipSettings } from '@launch/shared/launch-apps'
import {
  resolveSessionPolicy,
  type SessionShipGateRunningData,
  SHIP_GATE_STEP_LABELS,
  type ShipGateStep,
} from '@launch/shared/launch-sessions'
import { and, eq, sql } from 'drizzle-orm'
import { apps, type SessionRow, sessionEvents, sessions, users } from '../../../db/schema'
import { scanShipConfig } from '../grants/detect'
import { reviewPolicyFor } from '../launch/ship-settings'
import { upgradeNeedsAttention } from '../launch/upgrades'
import { resolvePrompt } from '../prompts'
import {
  BackgroundCommandAbortedError,
  BackgroundCommandLostError,
  BackgroundCommandTimeoutError,
  backgroundRunLive,
  runInBackground,
} from './background-command'
import { checkContainer } from './boot-marker'
import { readHeadTree, readWorktreeTree, workspaceChanged } from './checkpoint'
import { safeErrorMessage } from './events'
import {
  GATE_KIT_PROBE,
  GATE_KIT_TOO_OLD_MESSAGE,
  GATE_LIST_COMMAND,
  GATE_LIST_UNREADABLE_MESSAGE,
  gateBaseEnv,
  gateEgressHosts,
  gateOutputTail,
  gateTestEnv,
  gateTestTarget,
  parseGateList,
  planGateFromList,
  runGateCommand,
  SHIP_GATE_COMMANDS,
  type ShipGateCommand,
  type ShipGateKit,
  shipGateCommands,
  uriSecrets,
} from './gate'
import { gateBranchName } from './gate-branch'
import {
  GATE_DB_PROBE_COMMAND,
  GATE_DB_PROBE_CWD,
  GATE_DB_PROBE_PATH,
  GATE_DB_PROBE_SCRIPT,
  GATE_DB_PROBE_TIMEOUT_MS,
  gateDbProbeMessage,
  gateDbProbeVerdict,
  gateSetupRetryNote,
  isSetupConnectionFailure,
} from './gate-db-probe'
import {
  type GateBranch,
  SandboxInterruptedError,
  type SandboxPort,
  sessionAllowedHosts,
} from './ports'
import { SESSION_HOME, SESSION_LAUNCH_DIR, SESSION_WORKSPACE } from './rocketflare-dev'
import {
  clipDiffStat,
  DEFAULT_SHIP_ATTEMPTS,
  openShipPullRequest,
  type ShipLandingInput,
  type ShipSummaryResult,
  type ShipSummaryStepResult,
  sessionRepo,
  shipRequests,
} from './ship'
import {
  dbEgressHostsOf,
  devEnvFor,
  emitterFor,
  endRequested,
  hookContext,
  limitsOf,
  loadAppRef,
  loadSession,
  type StepScope,
  sandboxFor,
  transition,
  vendorCall,
} from './steps'
import { containerGone } from './turn'

/** Why a gate stopped short of a verdict (or of any use trying again). */
/**
 * Why a gate stopped without a verdict worth a fix turn: the container went away, the person ended
 * the session, the gate cannot run on this app at all, or (`db_unreachable`) the container could
 * not reach its test database — the database probe (`gate-db-probe.ts`) gave up before the tests.
 */
export type ShipStop = 'container_lost' | 'ended' | 'unfixable' | 'db_unreachable'

/** The session's container went away mid-ship: said once, as an `error` event. */
export const SHIP_CONTAINER_LOST_MESSAGE =
  "The session's container stopped while shipping — most likely it ran out of memory (the tests" +
  ' can do that) — so no pull request was opened. The session restarts from its last save; ship' +
  ' again once it is ready.'

// ---- ship.claim --------------------------------------------------------------------------------

export interface ShipClaimResult {
  status: 'claimed' | 'shipped' | 'skipped'
  /** The first attempt's number: one past the highest `ship.gate` attempt the session has. */
  firstAttempt: number
  maxAttempts: number
  /** The policy's turn limit — the fix turn's step timeout (`turnStepConfig`). */
  maxTurnMinutes: number
}

/**
 * `ready → shipping`, the request consumed (a retried claim finds `shipping` and re-takes it). A
 * session already `shipped` answers so; anything else is `skipped` and a `ship` request it could
 * not take up is dropped, so the loop never spins on it — the person asks again.
 */
export async function shipClaimStep(scope: StepScope): Promise<ShipClaimResult> {
  const current = await loadSession(scope)
  const base = {
    firstAttempt: 1,
    maxAttempts: DEFAULT_SHIP_ATTEMPTS,
    maxTurnMinutes: resolveSessionPolicy(current.policy).maxTurnMinutes,
  }
  if (current.status === 'shipped' && current.prNumber) return { ...base, status: 'shipped' }
  const claimed = await transition(scope, ['ready', 'shipping'], 'shipping', {
    requestedAction: null,
    lastActivityAt: scope.now(),
  })
  if (!claimed) {
    await scope.db
      .update(sessions)
      .set({ requestedAction: null })
      .where(
        and(
          eq(sessions.tenantId, scope.params.tenantId),
          eq(sessions.id, scope.params.sessionId),
          eq(sessions.requestedAction, 'ship')
        )
      )
    return { ...base, status: 'skipped' }
  }
  const [prior] = await scope.db
    .select({
      max: sql<number>`coalesce(max((${sessionEvents.data}->>'attempt')::int), 0)::int`,
    })
    .from(sessionEvents)
    .where(
      and(
        eq(sessionEvents.tenantId, scope.params.tenantId),
        eq(sessionEvents.sessionId, scope.params.sessionId),
        eq(sessionEvents.type, 'ship.gate')
      )
    )
  return { ...base, status: 'claimed', firstAttempt: Number(prior?.max ?? 0) + 1 }
}

// ---- the container -----------------------------------------------------------------------------

/**
 * The container went away mid-ship: `shipping → suspended` with a resume requested (an end the
 * person asked for stays asked), the sentence, and whatever is left of it destroyed.
 */
async function shipContainerLost(scope: StepScope, sandbox: SandboxPort): Promise<void> {
  const session = await loadSession(scope)
  const row = await transition(scope, ['shipping'], 'suspended', {
    suspendedAt: scope.now(),
    requestedAction: session.requestedAction ?? 'resume',
    containerKeptAt: null,
    cancelRequestedAt: null,
  })
  if (row) {
    await emitterFor(scope)({
      type: 'error',
      turn: row.turnCount,
      data: { message: SHIP_CONTAINER_LOST_MESSAGE },
    })
  }
  await sandbox.destroy().catch(err => {
    scope.logger.warn({ err }, 'session ship: could not destroy the lost container')
  })
}

/**
 * True (and the session suspended) when the container is not the one the boot prepared. Only a
 * read that ANSWERED counts; one that did not is no evidence (`unknown`) and the step carries on.
 */
async function lostContainer(
  scope: StepScope,
  sandbox: SandboxPort,
  bootId: string | undefined
): Promise<boolean> {
  if (!bootId) return false
  const verdict = await checkContainer(sandbox, bootId, limitsOf(scope).controlMs)
  if (verdict !== 'replaced' && verdict !== 'interrupted') return false
  scope.logger.warn({ verdict }, 'session ship: the container is not the one the boot prepared')
  await shipContainerLost(scope, sandbox)
  return true
}

// ---- ship.save / ship.commit -------------------------------------------------------------------

export interface ShipCheckpointResult {
  ok: boolean
  lost?: boolean
  /**
   * Issue #9, `ship.commit` only: the workspace (before the commit) or the commit (after it) is
   * not the tree the green gate ran on — nothing reaches a PR (`tree_changed`).
   */
  changed?: boolean
  /** Issue #9, `ship.commit` with a gate tree: the committed `HEAD^{tree}` (= the gate's). */
  tree?: string
}

/**
 * `ship.save#N` (before the gate) and `ship.commit#N` (after a green one): the checkpoint hook,
 * on the container the boot prepared. A failed checkpoint is an `error` event and `ok: false` —
 * the save's is not fatal (the gate still runs on the workspace), the commit's stops the ship.
 *
 * Issue #9: `ship.commit` takes `gateTree`, the tree the green gate's last step read, and FAILS
 * CLOSED on it twice: the workspace is read again before the hook (anything that moved since the
 * gate — a background process, a file the tests left — and nothing is committed), and the commit's
 * `HEAD^{tree}` after it (what the checkpoint left out, e.g. a file over its size cap). Either is
 * `changed: true`; a tree that cannot be read throws (the step retries, then the round settles
 * `error`). A retried `ship.commit` re-reads a workspace that is now clean at the commit — the same
 * tree. No `gateTree` (a gate recorded before issue #9) commits as before and attests nothing.
 */
export async function shipCheckpointStep(
  scope: StepScope,
  bootId: string | undefined,
  when: 'before the gate' | 'to open the pull request',
  gateTree?: string
): Promise<ShipCheckpointResult> {
  const session = await loadSession(scope)
  if (session.status !== 'shipping') return { ok: false }
  const sandbox = sandboxFor(scope, session)
  if (await lostContainer(scope, sandbox, bootId)) return { ok: false, lost: true }
  if (gateTree) {
    const now = await readWorktreeTree(sandbox)
    if (now !== gateTree) {
      scope.logger.warn({ gateTree, now }, 'session ship: the workspace moved after the gate')
      return { ok: false, changed: true }
    }
  }
  try {
    await scope.hooks.checkpoint(hookContext(scope, session, session.turnCount, bootId), 'ship')
  } catch (err) {
    scope.logger.warn({ err, when }, 'session ship: checkpoint failed')
    await emitterFor(scope)({
      type: 'error',
      turn: session.turnCount,
      data: { message: `Could not save the session's work ${when}: ${safeErrorMessage(err)}` },
    })
    return { ok: false }
  }
  if (!gateTree) return { ok: true }
  const committed = await readHeadTree(sandbox)
  if (committed !== gateTree) {
    scope.logger.warn({ gateTree, committed }, 'session ship: the commit is not the gated tree')
    return { ok: false, changed: true }
  }
  return { ok: true, tree: committed }
}

// ---- ship.kit ----------------------------------------------------------------------------------

export type ShipKitResult =
  | { ok: true; kit: ShipGateKit; commands: ShipGateCommand[] }
  | { ok: false; stop: ShipStop }

/**
 * `ship.kit#N`: which gate the checkout's kit takes — once a round, before its first attempt
 * (`GATE_KIT_PROBE`, see `gate.ts`). A `gate` kit is asked for its steps and they are planned from
 * its own list (`planGateFromList`); a `legacy` kit gets the three 0.15.7 commands. Neither, a
 * list that will not parse, or a list Launch refuses is `unfixable`: a red `test` row saying why
 * (on the round's first attempt), and no fix turn. A probe that does not answer at all throws, so
 * the step retries and then the round settles `error`.
 */
export async function shipKitStep(
  scope: StepScope,
  attempt: number,
  bootId?: string
): Promise<ShipKitResult> {
  const session = await loadSession(scope)
  if (session.status !== 'shipping' || endRequested(session)) return { ok: false, stop: 'ended' }
  const sandbox = sandboxFor({ ...scope, phase: 'Ship gate (kit)' }, session)
  if (await lostContainer(scope, sandbox, bootId)) return { ok: false, stop: 'container_lost' }

  const probe = await sandbox.exec(GATE_KIT_PROBE, { cwd: SESSION_WORKSPACE, timeoutMs: 30_000 })
  const answer = probe.exitCode === 0 ? probe.stdout.trim() : ''
  if (answer === 'legacy') return { ok: true, kit: 'legacy', commands: shipGateCommands('legacy') }
  if (answer === 'none') {
    await unfixable(scope, session, attempt, GATE_KIT_TOO_OLD_MESSAGE)
    return { ok: false, stop: 'unfixable' }
  }
  if (answer !== 'gate') {
    throw new Error(`Could not read the checkout's package.json (exit ${probe.exitCode})`)
  }
  const listed = await sandbox.exec(GATE_LIST_COMMAND, {
    cwd: SESSION_WORKSPACE,
    timeoutMs: 60_000,
  })
  const list = listed.exitCode === 0 ? parseGateList(listed.stdout) : null
  if (!list) {
    await unfixable(scope, session, attempt, GATE_LIST_UNREADABLE_MESSAGE, GATE_LIST_COMMAND)
    return { ok: false, stop: 'unfixable' }
  }
  const plan = planGateFromList(list)
  if (!plan.ok) {
    await unfixable(scope, session, attempt, plan.message, GATE_LIST_COMMAND)
    return { ok: false, stop: 'unfixable' }
  }
  return { ok: true, kit: 'gate', commands: plan.commands }
}

// ---- ship.gate ---------------------------------------------------------------------------------

/**
 * The step's `status: 'running'` row, written once per `(attempt, step, phase)`: a retried step
 * (the command re-attached, or `ship.db` asked again) finds the row its first try wrote and adds
 * none, so the panel's elapsed time still counts from when the step first began.
 */
export async function gateStepStarted(
  scope: StepScope,
  session: SessionRow,
  data: Pick<SessionShipGateRunningData, 'attempt' | 'step' | 'command' | 'phase' | 'plan'>
): Promise<void> {
  const [existing] = await scope.db
    .select({ id: sessionEvents.id })
    .from(sessionEvents)
    .where(
      and(
        eq(sessionEvents.tenantId, scope.params.tenantId),
        eq(sessionEvents.sessionId, scope.params.sessionId),
        eq(sessionEvents.type, 'ship.gate'),
        sql`${sessionEvents.data}->>'status' = 'running'`,
        sql`(${sessionEvents.data}->>'attempt')::int = ${data.attempt}`,
        sql`${sessionEvents.data}->>'step' = ${data.step}`,
        data.phase
          ? sql`${sessionEvents.data}->>'phase' = ${data.phase}`
          : sql`${sessionEvents.data}->>'phase' is null`
      )
    )
    .limit(1)
  if (existing) return
  await emitterFor(scope)({
    type: 'ship.gate',
    turn: session.turnCount,
    data: {
      status: 'running',
      attempt: data.attempt,
      step: data.step,
      command: data.command,
      ...(data.phase ? { phase: data.phase } : {}),
      ...(data.plan?.length ? { plan: [...data.plan] } : {}),
    },
  })
}

export interface GateStepResult {
  passed: boolean
  step: ShipGateStep
  /** No verdict worth a fix turn: see {@link ShipStop}. */
  stop?: ShipStop
  /** On red: what the fix turn is given — the command and its REDACTED output tail. */
  command?: string
  output?: string
  /** Issue #9: green, on the attempt's last step — the working tree's tree when it ended. */
  tree?: string
  /**
   * Issue #21: green, but the working tree is not the one the attempt STARTED on (`ship.tree`) — a
   * step rewrote these files (e.g. typecheck regenerating `worker-configuration.d.ts`), so the
   * earlier steps did not run on {@link tree}. `ship.attest` then posts nothing.
   */
  rewrote?: string[]
}

/**
 * Run `work` while polling the row every `endPollMs`: an end request aborts its signal. The poll
 * never fails the work.
 */
async function whileNotEnded<T>(
  scope: StepScope,
  work: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController()
  const every = limitsOf(scope).endPollMs
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const tick = async () => {
    if (stopped) return
    try {
      const [row] = await scope.db
        .select({ status: sessions.status, requestedAction: sessions.requestedAction })
        .from(sessions)
        .where(
          and(eq(sessions.tenantId, scope.params.tenantId), eq(sessions.id, scope.params.sessionId))
        )
      if (!row || endRequested(row)) {
        controller.abort()
        return
      }
    } catch {
      // A failed poll is not a failed gate.
    }
    if (!stopped) timer = setTimeout(tick, every)
  }
  timer = setTimeout(tick, every)
  try {
    return await work(controller.signal)
  } finally {
    stopped = true
    clearTimeout(timer)
  }
}

/** The second run's file name suffix: `gate-test-retry` (a finished name is never reused anyway). */
const GATE_RETRY_SUFFIX = '-retry'

interface GateProbeResult {
  /** The probe's exit code (0 = ready, or nothing to probe); null when Launch stopped it. */
  exitCode: number | null
  log: string
}

/**
 * The database probe (`gate-db-probe.ts`): its script written to the container, then run in the
 * app's `apps/web` with the test step's own environment — the same `DATABASE_URL` the suite gets.
 * A probe past its deadline is answered as a failure; a lost container or an end throws.
 */
async function probeGateDatabase(
  scope: StepScope,
  sandbox: SandboxPort,
  env: () => Promise<Record<string, string>>
): Promise<GateProbeResult> {
  await sandbox.writeFile(GATE_DB_PROBE_PATH, GATE_DB_PROBE_SCRIPT)
  try {
    const probed = await whileNotEnded(scope, signal =>
      runInBackground(sandbox, {
        name: 'test-db-probe',
        dir: SESSION_LAUNCH_DIR,
        command: GATE_DB_PROBE_COMMAND,
        cwd: GATE_DB_PROBE_CWD,
        env,
        timeoutMs: GATE_DB_PROBE_TIMEOUT_MS,
        signal,
        pollMs: limitsOf(scope).commandPollMs,
      })
    )
    return { exitCode: probed.exitCode, log: probed.stdout }
  } catch (err) {
    if (!(err instanceof BackgroundCommandTimeoutError)) throw err
    return { exitCode: null, log: err.log }
  }
}

/** The first run's connection error, one redacted line, for the retry's sentence. */
function connectionErrorLine(log: string, secrets: readonly string[]): string {
  const line = log
    .split('\n')
    .map(l => l.trim())
    .find(l =>
      /ErrorEvent|WebSocket|ECONN|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|Connection terminated|fetch failed/.test(
        l
      )
    )
  return line ? gateOutputTail(line, secrets).slice(0, 200) : 'a database connection error'
}

/**
 * `ship.gate#N.A.<step>`: one of the kit's gate commands, run by Launch in the checkout (see the
 * header and `gate.ts`), its verdict an event. The test step takes `branch` (from `ship.db`): the
 * allow-list gains exactly its hosts for the step, and its URL — minted only when the command
 * STARTS — is the command's `DATABASE_URL` and nothing else's. `command` is what `ship.kit` chose
 * for the checkout's kit (absent: the `pnpm gate` one).
 */
export async function shipGateStep(
  scope: StepScope,
  input: {
    step: ShipGateStep
    attempt: number
    branch?: GateBranch
    command?: ShipGateCommand
    /** Issue #9: the attempt's last command — a green one reads the tree it ran on. */
    last?: boolean
    /** Issue #21: the tree the attempt started on (`ship.tree`), which the last step compares. */
    startTree?: string
    /** The attempt's steps in order (`ship.kit`'s plan), carried on the running row. */
    plan?: readonly ShipGateStep[]
  },
  bootId?: string
): Promise<GateStepResult> {
  const gate = input.command ?? SHIP_GATE_COMMANDS[input.step]
  const step = input.step
  const session = await loadSession(scope)
  if (session.status !== 'shipping' || endRequested(session)) {
    return { passed: false, step, stop: 'ended' }
  }
  const phased: StepScope = { ...scope, phase: `Ship gate (${SHIP_GATE_STEP_LABELS[step]})` }
  const sandbox = sandboxFor(phased, session)
  if (await lostContainer(scope, sandbox, bootId)) {
    return { passed: false, step, stop: 'container_lost' }
  }
  const branch = input.branch
  if (gate.database && !branch) throw new Error(`The ${step} step has no gate branch to run on`)
  await gateStepStarted(scope, session, {
    attempt: input.attempt,
    step,
    command: gate.command,
    ...(input.plan ? { plan: [...input.plan] } : {}),
  })

  const dev = devEnvFor(scope.cfg, session)
  // The URL and its password, for the tail's redaction. A retry that re-attaches never mints them,
  // so its tail relies on `tailOf`'s connection-string rule (the kit's refusals print the host only).
  const secrets: string[] = []
  const sessionHosts = gate.database ? await dbEgressHostsOf(scope, session) : []
  // ONE credential per step invocation: the probe and the suite it clears share the password, so
  // the suite never starts on a password reset under the probe's (`gate-db-probe.ts`).
  let minted: Promise<Record<string, string>> | undefined
  const mint = async (): Promise<Record<string, string>> => {
    if (!gate.database || !branch) return gateBaseEnv(dev)
    const app = await loadAppRef(scope, session.appId)
    const uri = await vendorCall(phased, "Neon (the gate branch's password)", () =>
      scope.ports.sessionDb(scope.db).gateBranchUri(app, branch)
    )
    secrets.push(...uriSecrets(uri))
    return gateTestEnv(dev, branch, uri)
  }
  const env = (): Promise<Record<string, string>> => {
    minted ??= mint()
    return minted
  }

  const limits = limitsOf(scope)
  const started = Date.now()
  const run = (name?: string) =>
    whileNotEnded(scope, signal =>
      runGateCommand(sandbox, gate, {
        env,
        signal,
        pollMs: limits.commandPollMs,
        ...(limits.gateMaxMs !== undefined ? { maxMs: limits.gateMaxMs } : {}),
        ...(name ? { name } : {}),
      })
    )
  let result: Awaited<ReturnType<typeof runGateCommand>> | null = null
  let probe: GateProbeResult | null = null
  /** The first run's connection error, when the tests were run a second time. */
  let retriedAfter: string | null = null
  try {
    if (gate.database && branch) {
      await sandbox.setAllowedHosts(
        sessionAllowedHosts([...sessionHosts, ...gateEgressHosts(branch)])
      )
      const retryName = `gate-${step}${GATE_RETRY_SUFFIX}`
      if (await backgroundRunLive(sandbox, SESSION_LAUNCH_DIR, retryName)) {
        // A step retry that finds the second run going: attach to it (its first run is history).
        retriedAfter = 'a database connection error in the first run'
        result = await run(retryName)
      } else {
        // The probe runs only before a run STARTS — never under a suite an earlier try left going.
        if (!(await backgroundRunLive(sandbox, SESSION_LAUNCH_DIR, `gate-${step}`))) {
          probe = await probeGateDatabase(scope, sandbox, env)
        }
        if (!probe || probe.exitCode === 0) {
          result = await run()
          if (!result.passed && result.exitCode !== null && isSetupConnectionFailure(result.log)) {
            retriedAfter = connectionErrorLine(result.log, secrets)
            scope.logger.warn(
              { step, attempt: input.attempt },
              'session ship: the tests failed in their setup on a database connection error; running them once more'
            )
            result = await run(retryName)
          }
        }
      }
    } else {
      result = await run()
    }
  } catch (err) {
    if (err instanceof BackgroundCommandAbortedError) return { passed: false, step, stop: 'ended' }
    if (await lostContainer(scope, sandbox, bootId)) {
      return { passed: false, step, stop: 'container_lost' }
    }
    if (err instanceof SandboxInterruptedError || err instanceof BackgroundCommandLostError) {
      // Gone under the command with no marker to ask about (a caller without a boot id).
      await shipContainerLost(scope, sandbox)
      return { passed: false, step, stop: 'container_lost' }
    }
    throw err
  } finally {
    if (gate.database) {
      await sandbox.setAllowedHosts(sessionAllowedHosts(sessionHosts)).catch(err => {
        scope.logger.warn({ err }, 'session ship: could not put the allow-list back')
      })
    }
  }

  if (!result) {
    // The probe gave up: the tests never ran. Not the code's fault, so no fix turn either.
    const failed = probe as GateProbeResult
    const output = [
      gateDbProbeMessage(failed.exitCode, gateDbProbeVerdict(failed.log)),
      gateOutputTail(failed.log, secrets),
    ]
      .filter(Boolean)
      .join('\n')
    scope.logger.warn(
      { step, attempt: input.attempt, exitCode: failed.exitCode },
      'session ship: the gate database probe gave up; the tests did not run'
    )
    await emitterFor(scope)({
      type: 'ship.gate',
      turn: session.turnCount,
      data: {
        step,
        passed: false,
        attempt: input.attempt,
        command: gate.command,
        durationMs: Math.max(0, Date.now() - started),
        output,
      },
    })
    return { passed: false, step, stop: 'db_unreachable', command: gate.command, output }
  }

  // Issue #9: what a green gate ran on — read BEFORE the event, so a read that throws retries the
  // step (the command re-attached, finished) without writing its row twice.
  const tree = result.passed && input.last ? await gateTreeOf(scope, sandbox, bootId) : undefined
  if (tree === null) return { passed: false, step, stop: 'container_lost' }
  const rewrote =
    tree && input.startTree && tree !== input.startTree
      ? await changedBetween(sandbox, input.startTree, tree)
      : undefined
  const retryNote = retriedAfter ? gateSetupRetryNote(retriedAfter) : null
  const output = [retryNote, result.note, gateOutputTail(result.log, secrets)]
    .filter(Boolean)
    .join('\n')
  const target = gate.database ? gateTestTarget(result.log, secrets) : null
  await emitterFor(scope)({
    type: 'ship.gate',
    turn: session.turnCount,
    data: {
      step,
      passed: result.passed,
      attempt: input.attempt,
      command: gate.command,
      durationMs: Math.max(0, Date.now() - started),
      ...(target ? { target } : {}),
      ...(tree ? { tree } : {}),
      ...(output ? { output } : {}),
    },
  })
  return result.passed
    ? { passed: true, step, ...(tree ? { tree } : {}), ...(rewrote ? { rewrote } : {}) }
    : { passed: false, step, command: gate.command, output }
}

/**
 * The paths that differ between two trees (`git diff-tree`), for the sentence saying why a gate
 * was not attested. Best effort: an unreadable diff still means "changed" — `['(unknown)']`.
 */
async function changedBetween(sandbox: SandboxPort, from: string, to: string): Promise<string[]> {
  const result = await sandbox
    .exec(`git diff-tree -r --name-only ${from} ${to}`, {
      cwd: SESSION_WORKSPACE,
      env: { GIT_TERMINAL_PROMPT: '0', HOME: SESSION_HOME },
      timeoutMs: 30_000,
    })
    .catch(() => null)
  const files = result?.exitCode === 0 ? result.stdout.split('\n').filter(Boolean) : []
  return files.length > 0 ? files : ['(unknown)']
}

// ---- ship.tree ---------------------------------------------------------------------------------

export type ShipTreeResult = { ok: true; tree: string } | { ok: false; stop: ShipStop }

/**
 * `ship.tree#N.A` (issue #21): the working tree's tree BEFORE the attempt's first command, so the
 * last one can tell whether a step rewrote files (`GateStepResult.rewrote`). Its own step, so a
 * retried first gate step — which may re-attach to a command that already rewrote them — never
 * reads it late. A read that fails throws (the step retries).
 */
export async function shipGateTreeStep(scope: StepScope, bootId?: string): Promise<ShipTreeResult> {
  const session = await loadSession(scope)
  if (session.status !== 'shipping' || endRequested(session)) return { ok: false, stop: 'ended' }
  const sandbox = sandboxFor(scope, session)
  if (await lostContainer(scope, sandbox, bootId)) return { ok: false, stop: 'container_lost' }
  const tree = await gateTreeOf(scope, sandbox, bootId)
  return tree === null ? { ok: false, stop: 'container_lost' } : { ok: true, tree }
}

/**
 * The working tree's tree after a green last step; null (and the session suspended) when the
 * container went away under the read. Any other failure throws, so the step retries.
 */
async function gateTreeOf(
  scope: StepScope,
  sandbox: SandboxPort,
  bootId: string | undefined
): Promise<string | null> {
  try {
    return await readWorktreeTree(sandbox)
  } catch (err) {
    if (await lostContainer(scope, sandbox, bootId)) return null
    if (err instanceof SandboxInterruptedError) {
      await shipContainerLost(scope, sandbox)
      return null
    }
    throw err
  }
}

// ---- ship.db / ship.db-clean -------------------------------------------------------------------

export type ShipDbResult = { ok: true; branch: GateBranch } | { ok: false; stop: ShipStop }

/**
 * A red `test` row for a gate that cannot run on this app at all (no fix turn follows); `command`
 * is what could not run or answer (default: the `pnpm gate test` step).
 */
async function unfixable(
  scope: StepScope,
  session: SessionRow,
  attempt: number,
  output: string,
  command: string = SHIP_GATE_COMMANDS.test.command
) {
  await emitterFor(scope)({
    type: 'ship.gate',
    turn: session.turnCount,
    data: { step: 'test', passed: false, attempt, command, output },
  })
}

/**
 * `ship.db#N.A`: the test step's database — `gate-<short>-<A>`, a child of the session's branch
 * (`createGateBranch`, waiting for `create_branch` only). A session with no Neon branch cannot
 * have one (a red `test` row for `testCommand`, `unfixable`); otherwise any gate branch an earlier
 * attempt left is deleted first, so one session never holds more than one. (Whether the kit can
 * run its tests without Docker at all was `ship.kit`'s question.)
 */
export async function shipDbStep(
  scope: StepScope,
  attempt: number,
  bootId?: string,
  testCommand: string = SHIP_GATE_COMMANDS.test.command,
  plan?: readonly ShipGateStep[]
): Promise<ShipDbResult> {
  const session = await loadSession(scope)
  if (session.status !== 'shipping' || endRequested(session)) return { ok: false, stop: 'ended' }
  const phased: StepScope = { ...scope, phase: 'Ship gate (database)' }
  const sandbox = sandboxFor(phased, session)
  if (await lostContainer(scope, sandbox, bootId)) return { ok: false, stop: 'container_lost' }

  const parent = session.db
  if (!parent || parent.provider !== 'neon') {
    const message = 'The session has no database branch to test on.'
    await unfixable(scope, session, attempt, message, testCommand)
    return { ok: false, stop: 'unfixable' }
  }
  await gateStepStarted(scope, session, {
    attempt,
    step: 'test',
    command: testCommand,
    phase: 'database',
    ...(plan ? { plan: [...plan] } : {}),
  })
  const app = await loadAppRef(scope, session.appId)
  const port = scope.ports.sessionDb(scope.db)
  const name = gateBranchName(session.shortId, attempt)
  await vendorCall(phased, "Neon (an earlier attempt's gate branch)", () =>
    port.deleteGateBranches(app, session.shortId, { keep: name })
  )
  const branch = await vendorCall(phased, 'Neon (the gate branch)', () =>
    port.createGateBranch(app, parent, name)
  )
  return { ok: true, branch }
}

/** `ship.db-clean#N.A`: every gate branch of the session deleted. Idempotent. */
export async function shipDbCleanStep(scope: StepScope): Promise<{ deleted: number }> {
  const session = await loadSession(scope)
  const app = await loadAppRef(scope, session.appId)
  const deleted = await vendorCall(
    { ...scope, phase: 'Ship gate (database)' },
    'Neon (deleting the gate branch)',
    () => scope.ports.sessionDb(scope.db).deleteGateBranches(app, session.shortId)
  )
  return { deleted: deleted.length }
}

// ---- ship.fix ----------------------------------------------------------------------------------

export interface ShipFixInput {
  /** This attempt's number within the ship (1-based) and how many there are — for the prompt. */
  attempt: number
  maxAttempts: number
  failed: Pick<GateStepResult, 'step' | 'command' | 'output'>
}

async function creatorName(scope: StepScope, session: SessionRow): Promise<string | null> {
  if (!session.createdByUserId) return null
  const [creator] = await scope.db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, session.createdByUserId))
    .limit(1)
  return creator?.name ?? null
}

/**
 * `ship.fix#N.A`: ONE focused turn — the failing step's command and output tail, and "fix this"
 * (`session-ship-fix`) — through the `shipFix` hook. `ok` when the turn ran (completed, or ended
 * with an error after doing work): the gate runs again either way, and its exit codes judge the
 * fix. A turn that never started (over budget) or was cancelled (an end) stops the ship.
 */
export async function shipFixStep(
  scope: StepScope,
  input: ShipFixInput,
  bootId?: string
): Promise<{ ok: boolean; lost?: boolean }> {
  const session = await loadSession(scope)
  if (session.status !== 'shipping' || endRequested(session)) return { ok: false }
  const sandbox = sandboxFor(scope, session)
  if (await lostContainer(scope, sandbox, bootId)) return { ok: false, lost: true }
  const repo = await sessionRepo(scope.db, session)
  const step = input.failed.step
  const message = await resolvePrompt(scope.db, session.tenantId, 'session-ship-fix', {
    appName: repo.displayName,
    userName: (await creatorName(scope, session)) ?? 'The person in this session',
    stepLabel: SHIP_GATE_STEP_LABELS[step].toLowerCase(),
    command: input.failed.command ?? SHIP_GATE_COMMANDS[step].command,
    output: input.failed.output?.trim() || '(it printed nothing)',
    attempt: String(input.attempt),
    maxAttempts: String(input.maxAttempts),
  })
  const result = await scope.hooks.shipFix(hookContext(scope, session, session.turnCount, bootId), {
    message,
  })
  if (
    result.outcome === 'interrupted' &&
    containerGone({ status: 'interrupted', reason: result.reason })
  ) {
    await shipContainerLost(scope, sandbox)
    return { ok: false, lost: true }
  }
  return {
    ok: result.turn > 0 && (result.outcome === 'completed' || result.outcome === 'failed'),
  }
}

// ---- ship.summary / ship.pr --------------------------------------------------------------------

/** The branch against its base, as `git diff --stat` prints it; '' when it cannot be read. */
async function diffStat(scope: StepScope, session: SessionRow): Promise<string> {
  const base = session.baseSha
  if (!base || !/^[0-9a-f]{7,64}$/.test(base)) return ''
  try {
    const result = await sandboxFor(scope, session).exec(
      `git -C ${SESSION_WORKSPACE} diff --stat --no-color ${base}..HEAD`,
      { timeoutMs: 60_000 }
    )
    return result.exitCode === 0 ? clipDiffStat(result.stdout) : ''
  } catch {
    return ''
  }
}

/**
 * `ship.summary#N`: the PR's title and body — the `shipSummary` hook over the person's messages
 * and the diff stat (one cheap model call, or the fallback). A step of its own so a retried
 * `ship.pr` never pays for it twice. The result is prose, no secret.
 */
export async function shipSummaryStep(scope: StepScope): Promise<ShipSummaryStepResult> {
  const session = await loadSession(scope)
  const repo = await sessionRepo(scope.db, session)
  const input = {
    appName: repo.displayName,
    userName: (await creatorName(scope, session)) ?? 'the person in this session',
    requests: await shipRequests(scope.db, session),
    diffStat: await diffStat(scope, session),
    sessionTitle: session.title,
    shortId: session.shortId,
  }
  const summary = await scope.hooks.shipSummary(
    hookContext(scope, session, session.turnCount),
    input
  )
  return {
    title: summary.title,
    body: summary.body,
    source: summary.source,
    diffStat: input.diffStat,
  }
}

/**
 * Issue #5: where this ship ends — the app's `sessionShip` (`apps.ship_settings`, defaults filled
 * in), `pr` always under `SESSION_BACKEND=local` — and, for `staging`, the review rule
 * (`reviewPolicyFor`: the app's mode, or `policy` when an admin row decides).
 */
async function shipLanding(scope: StepScope, session: SessionRow): Promise<ShipLandingInput> {
  if (scope.cfg.SESSION_BACKEND === 'local') return { mode: 'pr', reviewMode: 'none' }
  const [app] = await scope.db
    .select()
    .from(apps)
    .where(and(eq(apps.tenantId, session.tenantId), eq(apps.id, session.appId)))
  if (!app) throw new Error('The session’s app no longer exists')
  const settings = resolveAppShipSettings(app.shipSettings)
  if (settings.sessionShip === 'pr') return { mode: 'pr', reviewMode: 'none' }
  const review = await reviewPolicyFor(scope.db, session.tenantId, app)
  return { mode: 'staging', reviewMode: review.required ? review.mode : 'none' }
}

/**
 * `ship.pr#N`: open the PR (`openShipPullRequest`) — `shipped` in `pr` mode, or still `shipping`
 * with the landing in `ci` in `staging` mode (`landing: true`: the loop carries on into its `land`
 * rounds); `gate` is the commands the green attempt ran, which the PR body names. The ship summary
 * (with `ship.summary`'s source and diff stat) is stored in the same write.
 */
export async function shipPrStep(
  scope: StepScope,
  summary: Pick<ShipSummaryResult, 'title' | 'body'> &
    Partial<Pick<ShipSummaryStepResult, 'source' | 'diffStat'>>,
  fixTurns: number,
  gate?: readonly string[],
  /** Issue #9: `ship.commit`'s tree — recorded as the landing's and the summary's `gateTree`. */
  gateTree?: string
): Promise<{ shipped: boolean; landing?: boolean }> {
  const session = await loadSession(scope)
  const landing = session.status === 'shipping' ? await shipLanding(scope, session) : undefined
  const outcome = await openShipPullRequest(
    scope.db,
    {
      repoHost: scope.ports.repoHost(scope.db),
      emit: emitterFor(scope),
      now: scope.now,
      scanConfig: input => scanShipConfig(hookContext(scope, session, session.turnCount), input),
    },
    scope.params,
    {
      title: summary.title,
      body: summary.body,
      fixTurns,
      ...(gate?.length ? { gate } : {}),
      ...(gateTree ? { gateTree } : {}),
      ...(summary.source ? { source: summary.source } : {}),
      ...(summary.diffStat !== undefined ? { diffStat: summary.diffStat } : {}),
      ...(landing ? { landing } : {}),
    }
  )
  if (outcome.status === 'landing') return { shipped: false, landing: true }
  return { shipped: outcome.status === 'shipped' }
}

// ---- ship.settle -------------------------------------------------------------------------------

/**
 * Why a ship ended without a PR: the gate still red after every attempt · it cannot run on this
 * app · a fix turn did not run · the person ended the session · the final checkpoint failed · the
 * workspace or the commit is not the tree the gate ran on (issue #9) · the PR did not open · a step
 * threw.
 */
export type ShipSettleReason =
  | 'exhausted'
  | 'unfixable'
  | 'db_unreachable'
  | 'fix_failed'
  | 'ended'
  | 'not_committed'
  | 'tree_changed'
  | 'not_opened'
  | 'error'

export interface ShipSettleResult {
  /** The workspace differs from the last checkpoint (the fix turns' work) — the loop debounces it. */
  changed?: boolean
  endedAt?: string
}

function settleMessage(reason: ShipSettleReason, attempts: number, detail?: string): string | null {
  switch (reason) {
    case 'exhausted':
      return `The gate still fails after ${attempts} attempt${attempts === 1 ? '' : 's'}, so no pull request was opened. The failing step's output is on the ship panel; carry on in the chat, then ship again.`
    case 'unfixable':
      return 'The gate cannot run on this app, so no pull request was opened. The ship panel says why.'
    case 'db_unreachable':
      return "The session's container could not reach its test database, so the tests did not run and no pull request was opened. The ship panel says what failed; ship again once it is fixed."
    case 'fix_failed':
      return 'The fix turn did not run to its end, so Launch stopped the ship without a pull request. Carry on in the chat, then ship again.'
    case 'not_committed':
      return 'The gate passed, but the work could not be saved to the branch, so no pull request was opened. Ship again.'
    case 'tree_changed':
      return 'The work changed after the gate passed, so what Launch would ship is not what the gate checked, and no pull request was opened. Ship again to gate the work as it is now.'
    case 'not_opened':
      return 'The gate passed, but the pull request could not be opened. Ship again.'
    case 'error':
      return `Shipping failed: ${detail ?? 'a ship step failed'}`
    case 'ended':
      return null
  }
}

/**
 * `ship.settle#N`: a round that opened no PR says why (an `error` event; nothing for an end the
 * person asked for), and goes `shipping → ready` — its work kept, and what the fix turns changed
 * reported so the loop saves it on its usual debounce. After a step threw, the session's gate
 * branches are deleted here too (best effort: cleanup and the sweep are the backstops).
 */
export async function shipSettleStep(
  scope: StepScope,
  input: { reason: ShipSettleReason; attempts: number; detail?: string }
): Promise<ShipSettleResult> {
  const session = await loadSession(scope)
  if (input.reason === 'error') {
    try {
      const app = await loadAppRef(scope, session.appId)
      await vendorCall(scope, 'Neon (deleting the gate branch)', () =>
        scope.ports.sessionDb(scope.db).deleteGateBranches(app, session.shortId)
      )
    } catch (err) {
      scope.logger.warn({ err }, 'session ship: could not delete the gate branches')
    }
  }
  if (session.status !== 'shipping') return {}
  const message = settleMessage(input.reason, input.attempts, input.detail)
  if (message) {
    await emitterFor(scope)({ type: 'error', turn: session.turnCount, data: { message } })
    // P6 6c: an auto-shipped kit upgrade that opened no PR is its owner's to finish.
    await upgradeNeedsAttention(scope.db, session, message, scope.realtime)
  }
  const row = await transition(scope, ['shipping'], 'ready', {
    lastActivityAt: scope.now(),
    cancelRequestedAt: null,
  })
  if (!row) return {}
  const changed = await workspaceChanged(sandboxFor(scope, row), row.headSha).catch(() => true)
  return { changed, endedAt: scope.now().toISOString() }
}
