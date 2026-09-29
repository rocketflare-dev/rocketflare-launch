/**
 * The ship gate (issue #1, docs/CONCEPTS.md §18.13): the kit's own checks, which LAUNCH runs in
 * the session's sandbox — never Claude — and whose exit codes alone decide whether a session
 * ships. This file is the gate's CONTRACT with the kit, fixed in Launch (there is no per-app gate
 * config): the commands, their order and deadlines, and the environment the test step hands the
 * kit's `pnpm test:ephemeral`. `tests/config/ship-gate-contract.test.ts` pins every value here to
 * the kit release that defines it ({@link SHIP_GATE_KIT_VERSION}), so a change is deliberate.
 *
 * **The steps** ({@link SHIP_GATE_COMMANDS}, in `SHIP_GATE_STEPS` order, stopping at the first
 * red): `pnpm lint`, `pnpm typecheck`, `pnpm test:ephemeral`. NOT `pnpm build`, though the kit's
 * own gate ends with it: its `build` re-runs `typecheck` and then builds the UI and the Worker —
 * the step most likely to run a container out of memory (it is what killed session d9124cbb) —
 * and it proves nothing lint + typecheck + the tests have not, beyond what the PR's own CI (which
 * runs the kit's full gate, build included) proves minutes later on a machine sized for it.
 *
 * **The test step's database** is a throwaway Neon branch per attempt (`gate-<short>-<attempt>`,
 * `gate-branch.ts`, a child of the session's branch), and the kit's contract for it (0.15.7,
 * `apps/web/tests/helpers/db-safety.ts`) is exactly three variables on top of the script's own:
 *
 * - `DATABASE_URL` — `session_owner` on the gate branch (it owns `session_app`'s tables and holds
 *   ADMIN OPTION on `rocketflare_app`, which the kit's test setup alters), direct host;
 * - `TEST_DATABASE_BRANCH` — the branch's name, which must match the kit's `GATE_BRANCH_RE`;
 * - `TEST_DATABASE_ENDPOINT` — the `ep-…` id IN that URL (the name is only a claim; the endpoint
 *   binds it to this URL).
 *
 * The script sets `TEST_DATABASE_EPHEMERAL=1`, `DATABASE_DRIVER=neon` and an empty
 * `APP_DATABASE_URL` itself. `NEON_LOCAL_PROXY` is NOT set, on a laptop too: a session's database
 * is always a real Neon branch reached directly (there is no local Neon proxy for sessions — see
 * `db/neon-session-db.ts`), so the gate's is as well, and the kit's driver test then insists the
 * run is the ephemeral profile on the named endpoint. `dotenv` never overrides a variable already
 * set, so these win over the checkout's `.env.test`.
 *
 * **The URL is a credential.** It exists only in the test command's environment (minted lazily by
 * `runInBackground`, so a retried step that re-attaches to the running suite never resets the
 * password under it), never in a command line, a step result, an event or a log: every output tail
 * goes through {@link gateOutputTail}, which removes the URL, its password and anything shaped
 * like a connection string or a key. The allow-list gains exactly the branch's hosts for the step
 * ({@link gateEgressHosts}: the direct and `-pooler` endpoint and the region's HTTP SQL host) — a
 * no-op under `SESSION_EGRESS=open`, correct under `allowlist`.
 *
 * **Deadlines.** Each command runs as a polled background command (`background-command.ts`) with a
 * hard deadline, past which its process group is killed: under `allowlist` a vitest run can hang
 * on exit behind the egress interceptor's WebSocket bug (docs/plans/sandbox-websocket-close.md),
 * and the kit's scripts `process.exit` for that reason, but vitest's own exit is not theirs.
 */
import { SHIP_GATE_STEPS, type ShipGateStep } from '@launch/shared/launch-sessions'
import { neonSqlEndpoint } from '../launch/neon'
import {
  BackgroundCommandTimeoutError,
  formatDuration,
  runInBackground,
} from './background-command'
import { redactModelKeyText } from './model-key'
import type { GateBranch, SandboxPort } from './ports'
import {
  SESSION_LAUNCH_DIR,
  SESSION_WORKSPACE,
  type SessionDevEnv,
  tailOf,
} from './rocketflare-dev'

/** The kit release whose `test:ephemeral` and `safetyCheck()` this contract is written against. */
export const SHIP_GATE_KIT_VERSION = '0.15.7'

export interface ShipGateCommand {
  step: ShipGateStep
  /** What runs, from the checkout's root, as a shell command line. */
  command: string
  /** The hard deadline; past it the command's process group is killed and the step is red. */
  timeoutMs: number
  /** The step runs on a throwaway gate branch (`ship.db` makes it, `ship.db-clean` deletes it). */
  database: boolean
}

export const SHIP_GATE_COMMANDS: Record<ShipGateStep, ShipGateCommand> = {
  lint: { step: 'lint', command: 'pnpm lint', timeoutMs: 5 * 60_000, database: false },
  typecheck: {
    step: 'typecheck',
    command: 'pnpm typecheck',
    timeoutMs: 10 * 60_000,
    database: false,
  },
  test: {
    step: 'test',
    command: 'pnpm test:ephemeral',
    timeoutMs: 25 * 60_000,
    database: true,
  },
}

/** The gate, in order. */
export const shipGateCommands = (): ShipGateCommand[] =>
  SHIP_GATE_STEPS.map(step => SHIP_GATE_COMMANDS[step])

/** The root `package.json` script the test step runs — absent in a kit before 0.15.7. */
export const GATE_TEST_SCRIPT = 'test:ephemeral'

/** Exit 0 when the checkout's root `package.json` has {@link GATE_TEST_SCRIPT}, else 3. */
export const GATE_TEST_SCRIPT_CHECK = `node -e 'const p=require("./package.json");process.exit(p.scripts&&p.scripts[${JSON.stringify(GATE_TEST_SCRIPT)}]?0:3)'`

/** Why the gate cannot run on this app at all — no fix turn can help. */
export const GATE_KIT_TOO_OLD_MESSAGE =
  `This app's kit has no \`pnpm ${GATE_TEST_SCRIPT}\` (it needs Rocketflare ${SHIP_GATE_KIT_VERSION}` +
  ' or later), so Launch cannot run its tests without Docker. Upgrade the kit, then ship again.'

/** The kit's variable names for the test step's database (kit 0.15.7, `db-safety.ts`). */
export const GATE_TEST_ENV_VARS = {
  url: 'DATABASE_URL',
  branch: 'TEST_DATABASE_BRANCH',
  endpoint: 'TEST_DATABASE_ENDPOINT',
} as const

/** Variables the gate must never set — the kit's local-only switches. */
export const GATE_FORBIDDEN_ENV = ['NEON_LOCAL_PROXY', 'APP_DATABASE_URL'] as const

const ENDPOINT_ID = /^ep-[a-z0-9-]+$/

/**
 * `ep-cool-darkness-123456[-pooler].us-east-2.aws.neon.tech` → `ep-cool-darkness-123456` — the
 * kit's `neonEndpointId`, for a HOST. Throws for anything that is not a Neon endpoint's.
 */
export function gateEndpointId(host: string): string {
  const lower = host.toLowerCase()
  if (!lower.endsWith('.neon.tech')) throw new Error(`${host} is not a Neon endpoint host`)
  const id = (lower.split('.')[0] ?? '').replace(/-pooler$/, '')
  if (!ENDPOINT_ID.test(id)) throw new Error(`${host} is not a Neon endpoint host`)
  return id
}

/**
 * The hosts the test step's container must reach, and no others: the endpoint's direct host (the
 * kit's `Pool` WebSocket), its `-pooler` twin (the kit accepts a pooled URL too — both are
 * allow-listed so either works) and the region's HTTP SQL host (`neon()` queries).
 */
export function gateEgressHosts(branch: Pick<GateBranch, 'host'>): string[] {
  const direct = branch.host.toLowerCase().replace(/^([^.]+?)-pooler\./, '$1.')
  gateEndpointId(direct)
  const pooler = direct.replace(/^([^.]+)\./, '$1-pooler.')
  const api = new URL(neonSqlEndpoint(`postgresql://x@${direct}/db`)).hostname
  return [direct, pooler, api]
}

/**
 * What every gate command runs with: no credential, no telemetry, and — on a laptop's emulated
 * amd64 — the Go garbage-collector switches esbuild (under vitest and tsx) needs to survive
 * (`SessionDevEnv.emulated`, `rocketflare-dev.ts`).
 */
export function gateBaseEnv(dev: Pick<SessionDevEnv, 'emulated'>): Record<string, string> {
  return {
    CI: '1',
    WRANGLER_SEND_METRICS: 'false',
    ...(dev.emulated ? { GOGC: 'off', GOMEMLIMIT: '1536MiB' } : {}),
  }
}

/**
 * The test step's environment — the kit's contract, exactly: the base, plus `DATABASE_URL`,
 * `TEST_DATABASE_BRANCH` and `TEST_DATABASE_ENDPOINT`. Throws when the URL's endpoint is not the
 * branch's (the kit would refuse it; better to say so here, without the URL).
 */
export function gateTestEnv(
  dev: Pick<SessionDevEnv, 'emulated'>,
  branch: GateBranch,
  uri: string
): Record<string, string> {
  let host: string
  try {
    host = new URL(uri).hostname
  } catch {
    throw new Error('The gate branch connection string does not parse')
  }
  if (gateEndpointId(host) !== branch.endpointId) {
    throw new Error(`The gate branch ${branch.name}'s connection string is for another endpoint`)
  }
  return {
    ...gateBaseEnv(dev),
    [GATE_TEST_ENV_VARS.url]: uri,
    [GATE_TEST_ENV_VARS.branch]: branch.name,
    [GATE_TEST_ENV_VARS.endpoint]: branch.endpointId,
  }
}

/** The pieces of a connection string that must never appear in an output tail. */
export function uriSecrets(uri: string): string[] {
  const out = [uri]
  try {
    const url = new URL(uri)
    if (url.password) out.push(url.password, decodeURIComponent(url.password))
  } catch {
    // Not a URL: the whole string is all there is to hide.
  }
  return out.filter(s => s.length >= 6)
}

/** Lines of a step's output the event (and the fix turn) carry. */
export const GATE_OUTPUT_TAIL_LINES = 60
/** …and at most this many characters of them. */
export const GATE_OUTPUT_MAX_CHARS = 6_000

/**
 * A step's output as the ship panel and the fix turn see it: the command's own error lines first,
 * then the last {@link GATE_OUTPUT_TAIL_LINES} lines (`tailOf`), with `secrets` (the gate URL and
 * its password), anything shaped like a connection string, and anything shaped like a model key
 * or a GitHub token removed, clipped from the front to {@link GATE_OUTPUT_MAX_CHARS}.
 */
export function gateOutputTail(log: string, secrets: readonly string[] = []): string {
  const text = redactModelKeyText(tailOf(log, secrets, GATE_OUTPUT_TAIL_LINES))
  return text.length > GATE_OUTPUT_MAX_CHARS ? `…${text.slice(-GATE_OUTPUT_MAX_CHARS)}` : text
}

export interface GateCommandResult {
  /** The command's exit code; null when Launch stopped it at its deadline. */
  exitCode: number | null
  passed: boolean
  /** The whole log, UNREDACTED — {@link gateOutputTail} before it goes anywhere. */
  log: string
  /** A sentence for a command stopped at its deadline. */
  note?: string
}

export interface RunGateCommandOptions {
  /** Called only when the run STARTS (`runInBackground`'s lazy `env`). */
  env: () => Promise<Record<string, string>>
  signal?: AbortSignal
  pollMs?: number
  sleep?: (ms: number) => Promise<void>
  /** Caps the command's own deadline (`SESSION_CALL_LIMITS.execMaxMs`-style; tests shrink it). */
  maxMs?: number
}

/**
 * Run one gate command in the checkout as a polled background command (`gate-<step>` files under
 * `SESSION_LAUNCH_DIR`). A run past its deadline is killed and answered as red with a note; a
 * lost container (`BackgroundCommandLostError`, `SandboxInterruptedError`) and an abort
 * (`BackgroundCommandAbortedError`) are thrown for the caller to judge.
 */
export async function runGateCommand(
  sandbox: SandboxPort,
  gate: ShipGateCommand,
  opts: RunGateCommandOptions
): Promise<GateCommandResult> {
  const timeoutMs = Math.min(gate.timeoutMs, opts.maxMs ?? gate.timeoutMs)
  try {
    const result = await runInBackground(sandbox, {
      name: `gate-${gate.step}`,
      dir: SESSION_LAUNCH_DIR,
      command: gate.command,
      cwd: SESSION_WORKSPACE,
      env: opts.env,
      timeoutMs,
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.pollMs !== undefined ? { pollMs: opts.pollMs } : {}),
      ...(opts.sleep ? { sleep: opts.sleep } : {}),
    })
    return { exitCode: result.exitCode, passed: result.exitCode === 0, log: result.stdout }
  } catch (err) {
    if (!(err instanceof BackgroundCommandTimeoutError)) throw err
    return {
      exitCode: null,
      passed: false,
      log: err.log,
      note: `\`${gate.command}\` did not finish within ${formatDuration(err.timeoutMs)}; Launch stopped it.`,
    }
  }
}
