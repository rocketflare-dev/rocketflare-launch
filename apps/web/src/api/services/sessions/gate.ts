/**
 * The ship gate (issue #1, rocketflare-launch#2, docs/CONCEPTS.md §18.13): the kit's own checks,
 * which LAUNCH runs in the session's sandbox — never Claude — and whose exit codes alone decide
 * whether a session ships. This file is the gate's CONTRACT with the kit, fixed in Launch (there is
 * no per-app gate config): the commands, their order and deadlines, how the checkout's kit is
 * probed for them, and the environment the test step hands the kit's `pnpm test`.
 * `tests/config/ship-gate-contract.test.ts` pins every value here to the kit release that defines
 * it ({@link SHIP_GATE_KIT_VERSION}), so a change is deliberate.
 *
 * **The steps** ({@link SHIP_GATE_COMMANDS}, stopping at the first red) are the kit's `pnpm gate`
 * steps — the one definition of an app's checks, and the one job in the copy's own CI (kit 0.16.0)
 * — run one at a time: `pnpm gate lint`, `pnpm gate typecheck`, `pnpm gate test`. So a green ship
 * gate is the same checks the PR's CI runs, minus ONE declared exception ({@link SHIP_GATE_SKIPPED}):
 * `build`, which re-bundles the UI and the Worker — the step most likely to run a container out of
 * memory (it is what killed session d9124cbb) — and proves nothing lint + typecheck + the tests have
 * not, beyond what the PR's CI (which runs it) proves minutes later on a machine sized for it.
 *
 * **Which kit** ({@link GATE_KIT_PROBE}, `ship.kit#N`, before the first step): a root `gate` script
 * means the steps come from the kit's own list — `pnpm gate --list --json`, parsed with the kit's
 * schema shape ({@link kitGateListSchema}) and planned by {@link planGateFromList}: Launch's steps
 * in the LISTED order, refusing a list that lacks one of them or names a step Launch neither runs
 * nor skips (a refusal, with a sentence, never a silent skip). Only `test:ephemeral` (kit 0.15.7 up
 * to 0.16.0, which kept the script in the copy's own `package.json`) means the legacy commands
 * ({@link SHIP_GATE_LEGACY_COMMANDS}). Neither means the kit is too old
 * ({@link GATE_KIT_TOO_OLD_MESSAGE}).
 *
 * **The driver differs from the copy's CI by design.** The copy's CI runs the suite under
 * `postgres` plus a `neon` conformance pass (the driver seam); Launch's `pnpm gate test` runs the
 * whole suite under `neon` on a real Neon branch, because a sandbox has 443 and no Docker. Same
 * steps, different driver: a failure on one and not the other is a seam bug for the kit, not
 * something to patch in the app.
 *
 * **The test step's database** is a throwaway Neon branch per attempt (`gate-<short>-<attempt>`,
 * `gate-branch.ts`, a child of the session's branch), and the kit's contract for it (0.15.7 and
 * unchanged in 0.16.0, `apps/web/tests/helpers/db-safety.ts`) is exactly three variables on top of
 * the script's own — `TEST_DATABASE_BRANCH` is also what tells 0.16.0's `pnpm test` it is on a
 * remote target (`scripts/lib/test-plan.mjs`), which it prints on its first line
 * ({@link gateTestTarget}, shown on the ship panel):
 *
 * - `DATABASE_URL` — `session_owner` on the gate branch (it owns `session_app`'s tables and holds
 *   ADMIN OPTION on `rocketflare_app`, which the kit's test setup alters), direct host;
 * - `TEST_DATABASE_BRANCH` — the branch's name, which must match the kit's `GATE_BRANCH_RE`;
 * - `TEST_DATABASE_ENDPOINT` — the `ep-…` id IN that URL (the name is only a claim; the endpoint
 *   binds it to this URL).
 *
 * The kit's script sets `TEST_DATABASE_EPHEMERAL=1`, `DATABASE_DRIVER=neon` and an empty
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
import { z } from 'zod'
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

/** The kit release whose `pnpm gate` (and `--list --json`) this contract is written against. */
export const SHIP_GATE_KIT_VERSION = '0.16.0'
/** The oldest kit a ship gate runs on at all: `test:ephemeral` (the legacy path). */
export const SHIP_GATE_LEGACY_KIT_VERSION = '0.15.7'

export interface ShipGateCommand {
  step: ShipGateStep
  /** What runs, from the checkout's root, as a shell command line. */
  command: string
  /** The hard deadline; past it the command's process group is killed and the step is red. */
  timeoutMs: number
  /** The step runs on a throwaway gate branch (`ship.db` makes it, `ship.db-clean` deletes it). */
  database: boolean
}

const DEADLINES: Record<ShipGateStep, number> = {
  lint: 5 * 60_000,
  typecheck: 10 * 60_000,
  test: 25 * 60_000,
}

const commandsOf = (command: (step: ShipGateStep) => string) =>
  Object.fromEntries(
    SHIP_GATE_STEPS.map(step => [
      step,
      { step, command: command(step), timeoutMs: DEADLINES[step], database: step === 'test' },
    ])
  ) as Record<ShipGateStep, ShipGateCommand>

/** The root `package.json` script that means a kit's `pnpm gate` (0.16.0+). */
export const GATE_SCRIPT = 'gate'
/** The root `package.json` script the legacy test step runs (0.15.7 up to 0.16.0). */
export const GATE_LEGACY_TEST_SCRIPT = 'test:ephemeral'

/** The steps on a kit with `pnpm gate` (0.16.0+): each of the kit's own gate steps, by id. */
export const SHIP_GATE_COMMANDS: Record<ShipGateStep, ShipGateCommand> = commandsOf(
  step => `pnpm ${GATE_SCRIPT} ${step}`
)

/**
 * The kit's gate steps Launch deliberately does NOT run: `build`, the one exception — the
 * container's memory (see the header), and the PR's own CI runs it.
 */
export const SHIP_GATE_SKIPPED = ['build'] as const

/** The steps on a kit from 0.15.7 up to 0.16.0: `test:ephemeral`, and no `pnpm gate`. */
export const SHIP_GATE_LEGACY_COMMANDS: Record<ShipGateStep, ShipGateCommand> = commandsOf(step =>
  step === 'test' ? `pnpm ${GATE_LEGACY_TEST_SCRIPT}` : `pnpm ${step}`
)

/** Which commands the checkout's kit takes: `gate` (0.16.0+) or `legacy` (0.15.7 up to 0.16.0). */
export type ShipGateKit = 'gate' | 'legacy'

/** A kit's gate in `SHIP_GATE_STEPS` order (a `gate` kit's own list decides: `planGateFromList`). */
export const shipGateCommands = (kit: ShipGateKit = 'gate'): ShipGateCommand[] =>
  SHIP_GATE_STEPS.map(
    step => (kit === 'gate' ? SHIP_GATE_COMMANDS : SHIP_GATE_LEGACY_COMMANDS)[step]
  )

/**
 * The capability probe, run in the checkout: prints `gate` when the root `package.json` has
 * {@link GATE_SCRIPT}, else `legacy` when it has {@link GATE_LEGACY_TEST_SCRIPT}, else `none`.
 */
export const GATE_KIT_PROBE = `node -e 'const s=require("./package.json").scripts||{};process.stdout.write(s[${JSON.stringify(GATE_SCRIPT)}]?"gate":s[${JSON.stringify(GATE_LEGACY_TEST_SCRIPT)}]?"legacy":"none")'`

/** What a `gate` kit is asked for its steps (the kit's `scripts/gate.mjs`, schema 1). */
export const GATE_LIST_COMMAND = `pnpm --silent ${GATE_SCRIPT} --list --json`

/**
 * The kit's `gateListSchema` (0.16.0, `packages/shared/src/gate.ts`), mirrored — Launch cannot
 * import the kit. `schema` rises only when an existing field changes meaning; a new step or a new
 * field is not a schema change, so this tolerates both (not `.strict()`: extra fields are dropped).
 */
export const kitGateListSchema = z.object({
  schema: z.literal(1),
  steps: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z][a-z-]*$/),
        command: z.string().min(1),
        database: z.boolean(),
      })
    )
    .min(1),
})
export type KitGateList = z.infer<typeof kitGateListSchema>

/**
 * `pnpm gate --list --json`'s output → the list, or null when it is not one. A line of noise
 * around the document (a package manager's banner) is tolerated: the JSON is the outermost `{…}`.
 */
export function parseGateList(stdout: string): KitGateList | null {
  const from = stdout.indexOf('{')
  const to = stdout.lastIndexOf('}')
  if (from < 0 || to < from) return null
  try {
    const parsed = kitGateListSchema.safeParse(JSON.parse(stdout.slice(from, to + 1)))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export type GatePlan = { ok: true; commands: ShipGateCommand[] } | { ok: false; message: string }

const isShipGateStep = (id: string): id is ShipGateStep =>
  (SHIP_GATE_STEPS as readonly string[]).includes(id)
const isSkipped = (id: string) => (SHIP_GATE_SKIPPED as readonly string[]).includes(id)
const quoted = (ids: readonly string[]) => ids.map(id => `\`${id}\``).join(', ')

/**
 * A `gate` kit's list → the commands Launch runs: the steps Launch knows, in the LISTED order, as
 * {@link SHIP_GATE_COMMANDS}. Refused — a sentence for the ship panel, no fix turn — when the list
 * lacks one of `SHIP_GATE_STEPS`, or names a step that is neither one of them nor in
 * {@link SHIP_GATE_SKIPPED}: running less than the app's CI and calling it green is what this gate
 * exists to stop, so an unknown step is Launch's to learn, never one to skip quietly.
 */
export function planGateFromList(list: KitGateList): GatePlan {
  const ids = list.steps.map(s => s.id)
  const unknown = ids.filter(id => !isShipGateStep(id) && !isSkipped(id))
  if (unknown.length > 0) {
    return {
      ok: false,
      message:
        `This app's kit has gate step${unknown.length === 1 ? '' : 's'} Launch does not know ` +
        `(${quoted(unknown)}), so Launch cannot run the same checks as the app's CI. Launch runs ` +
        `${quoted(SHIP_GATE_STEPS)} and leaves ${quoted(SHIP_GATE_SKIPPED)} to the pull ` +
        "request's CI; Launch needs updating for this kit before the app can ship.",
    }
  }
  const missing = SHIP_GATE_STEPS.filter(step => !ids.includes(step))
  if (missing.length > 0) {
    return {
      ok: false,
      message:
        `This app's \`pnpm gate\` has no ${quoted(missing)} step, so Launch cannot run the ` +
        "checks it ships on. Restore the kit's gate steps, then ship again.",
    }
  }
  const commands: ShipGateCommand[] = []
  for (const id of ids) {
    if (isShipGateStep(id) && !commands.some(c => c.step === id)) {
      commands.push(SHIP_GATE_COMMANDS[id])
    }
  }
  return { ok: true, commands }
}

/** A `gate` kit whose `pnpm gate --list --json` did not print a step list. */
export const GATE_LIST_UNREADABLE_MESSAGE =
  "This app has a `pnpm gate`, but `pnpm gate --list --json` did not print the kit's step list, " +
  "so Launch cannot tell which checks to run. Compare the app's `scripts/gate.mjs` with the " +
  "kit's, then ship again."

/** Why the gate cannot run on this app at all — no fix turn can help. */
export const GATE_KIT_TOO_OLD_MESSAGE =
  `This app's kit has neither \`pnpm ${GATE_SCRIPT}\` nor \`pnpm ${GATE_LEGACY_TEST_SCRIPT}\` (it ` +
  `needs Rocketflare ${SHIP_GATE_LEGACY_KIT_VERSION} or later), so Launch cannot run its tests ` +
  'without Docker. Upgrade the kit, then ship again.'

/** The kit's variable names for the test step's database (kit 0.15.7 on, `db-safety.ts`). */
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

/** How long a target line the ship panel shows may be. */
export const GATE_TARGET_MAX_CHARS = 200

/**
 * The target the kit's `pnpm test` announces on its first line (0.16.0, `scripts/test.mjs`):
 * `test target: remote Neon branch gate-… (no Docker; the whole suite under neon)` — redacted like
 * a tail and clipped, or null when the log has none (a legacy kit, or a run that died first).
 */
export function gateTestTarget(log: string, secrets: readonly string[] = []): string | null {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI colour codes from the kit's output
  const match = log.replace(/\u001b\[[0-9;]*m/g, '').match(/^\s*(test target: .+)$/m)
  if (!match?.[1]) return null
  const line = redactModelKeyText(tailOf(match[1].trim(), secrets, 1))
  return line.length > GATE_TARGET_MAX_CHARS ? `${line.slice(0, GATE_TARGET_MAX_CHARS)}…` : line
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
