/**
 * How a Rocketflare checkout (kit 0.15) is brought up inside a session's sandbox — the
 * `devBootstrap` of spec/02, as Launch drives it (plan §3b, S7). Everything here goes through the
 * `SandboxPort`, so it runs the same against a real container and a `FakeSandbox`.
 *
 * `sessionBootstrap(ctx)` — the `bootstrap` step (and a `prepare` run's migrate + seed):
 *
 * 0. The allow-list gains EXACTLY the database's Neon endpoint (`sessionDbEgressHosts`): the
 *    container has no TCP out, so the app reaches its branch over the neon driver — the `Pool`'s
 *    WebSocket to the endpoint, the Worker's HTTP queries to the region's `api.` host.
 * 1. `pnpm install --frozen-lockfile --prefer-offline` — from the image's warm store (S7: ~5 s,
 *    against ~17 s cold).
 * 2. `node scripts/bootstrap.mjs --db-url "$LAUNCH_DB_URL" --driver neon --offline --no-dev
 *    --no-open --no-plugins --yes` (with `NOT_ROOT_PRELOAD`: the kit refuses root, and a sandbox
 *    runs as root) — the kit's own first run against a database it does not own:
 *    `.dev.vars` from the example with the URL and a fresh encryption key, `[ai]` off (no
 *    Cloudflare login in a sandbox), migrate, seed (idempotent; `SEED_ALLOW_REMOTE=1` under
 *    `--db-url`). **`--no-plugins`**: a session never changes the app's plugin set — the repo's
 *    committed plugins are what it runs. The ports go in the ENVIRONMENT (`DEV_UI_PORT=5173`,
 *    `DEV_API_PORT=8787`, `DEV_ALLOWED_HOSTS=.<preview suffix>`), which `scripts/lib/dev-ports.mjs`
 *    reads before `.dev.vars`, with `DATABASE_DRIVER=neon` (the scripts read the driver from the
 *    environment) — and on a laptop `GOGC=off` (see `SessionDevEnv.emulated`).
 * 3. The dev-server keys go INTO `apps/web/.dev.vars` afterwards — `APP_URL=<preview origin>` (the
 *    Worker builds its CORS / CSRF allow-list and redirects from it and cannot read the process
 *    environment), the ports, `DATABASE_DRIVER=neon` and an empty `NEON_LOCAL_PROXY` (never a
 *    proxy: the branch's endpoint is reached directly, on a laptop too).
 *
 * `startDevServer(sandbox, dev)` — the `dev` step: `pnpm dev` in the background (its pid and output
 * in `DEV_PID_FILE` / `DEV_LOG_FILE`), then `:5173` answering and `:8787/api/health` 2xx — waited
 * for in short chunks, failing at once if the dev server exits.
 *
 * The install and the kit bootstrap each run as a BACKGROUND command, polled
 * (`background-command.ts`) — never one blocking `exec`: the Sandbox SDK queues every other call
 * behind a running exec and the sandbox host's binding drops a long one. A step retry attaches to
 * the run an earlier attempt left going; the running step's detail follows the kit's `✔ n/10`
 * lines (`onProgress`); past `BOOTSTRAP_TIMEOUTS` the process group is killed.
 *
 * A failed command's error carries the last `ERROR_TAIL_LINES` of its output, the database URI
 * scrubbed (`tailOf`), and the install and bootstrap run under one `flock` (`serialised`), so a
 * re-run step attempt never races an earlier one's `pnpm install`.
 *
 * **Never port 3000**: it is the Sandbox SDK's own control server inside every sandbox (S7
 * finding 3); `tests/config/session-bootstrap.test.ts` pins that nothing here names it.
 *
 * The database URI is the ONE credential a session's container holds — for its own throwaway
 * branch (spec/07) — and it travels only as the `LAUNCH_DB_URL` environment variable of the
 * bootstrap command and in the checkout's git-ignored `.dev.vars`; never in an argument, a step
 * result or an event.
 */
import {
  BackgroundCommandTimeoutError,
  formatDuration,
  runInBackground,
} from './background-command'
import { sessionDbEgressHosts } from './db/neon-session-db'
import { type SandboxPort, SandboxProcessExitedError, sessionAllowedHosts } from './ports'

/** Bump with `LABEL dev.rocketflare.launch.session-image` in `containers/session/Dockerfile`. */
export const SESSION_IMAGE_VERSION = 'session-3'
/** The kit tag whose pnpm store the image carries (`ARG KIT_TAG`). */
export const SESSION_KIT_TAG = '0.15.7'

/** The app's Vite UI — the preview port. */
export const SESSION_UI_PORT = 5173
/** The app's `wrangler dev` API, behind Vite's `/api` proxy. */
export const SESSION_API_PORT = 8787

/**
 * Where the checkout lives in the container — THE one definition: the repo step clones here, the
 * turn runs Claude Code here (`SESSION_WORKDIR`, `claude-stream.ts`), and the checkpoint and the
 * ship gate run git and the gate here (`SESSION_REPO_DIR`, `checkpoint.ts`).
 */
export const SESSION_WORKSPACE = '/workspace/app'
/** `$HOME` in the container: the image runs everything as root, so Claude Code's state is here. */
export const SESSION_HOME = '/root'
/** Launch's own helper files, outside the checkout. */
export const SESSION_LAUNCH_DIR = '/workspace/.launch'
/**
 * Claude Code's transcripts for a session run in `SESSION_WORKSPACE` (`~/.claude/projects/<cwd with
 * / as ->/<session id>.jsonl`) — what a checkpoint copies to R2 and a resume puts back.
 */
export const CLAUDE_PROJECT_DIR = `${SESSION_HOME}/.claude/projects/${SESSION_WORKSPACE.replace(/[^A-Za-z0-9]/g, '-')}`

export const claudeTranscriptPath = (claudeSessionId: string): string =>
  `${CLAUDE_PROJECT_DIR}/${claudeSessionId}.jsonl`

/**
 * How long each phase may take before the step fails (then cleanup runs). The install and the
 * bootstrap are killed at theirs (`runInBackground`).
 */
export const BOOTSTRAP_TIMEOUTS = {
  installMs: 10 * 60_000,
  bootstrapMs: 15 * 60_000,
  uiMs: 3 * 60_000,
  apiMs: 3 * 60_000,
} as const

/** What the dev stack needs to know about where it is served from. */
export interface SessionDevEnv {
  /** `https://5173-<short>-<token>.clewro.com` — the preview origin, or null when previews are off. */
  previewOrigin: string | null
  /** `.clewro.com` — the suffix every preview host shares (Vite's `allowedHosts`), or null. */
  previewHostSuffix: string | null
  /**
   * The container runs on a laptop (`APP_ENV=development`: `wrangler dev`'s Docker, whichever
   * `SESSION_BACKEND`), where the amd64-only sandbox image runs under emulation (QEMU on an ARM
   * Mac) and Go binaries — esbuild, under `tsx`, Vite and wrangler — crash in their garbage
   * collector ("The service was stopped", "found pointer to free object", a garbled
   * `Invalid version` mid-transform). Measured: `GOGC=off` keeps them alive; `GOMAXPROCS=1` and
   * `GODEBUG=asyncpreemptoff=1` do not. `GOMEMLIMIT` bounds the cost — the collector only runs
   * near it. Deployed containers are native amd64 and get neither.
   */
  emulated?: boolean
}

/**
 * Command-level variables every step shares: no credential, no telemetry, the ports, and the neon
 * driver — the container has no TCP out, so the kit's scripts (which read `DATABASE_DRIVER` from
 * the environment before `.dev.vars`) must speak HTTPS/WebSocket to the branch.
 */
export function sessionProcessEnv(dev: SessionDevEnv): Record<string, string> {
  return {
    CI: '1',
    WRANGLER_SEND_METRICS: 'false',
    DATABASE_DRIVER: 'neon',
    DEV_UI_PORT: String(SESSION_UI_PORT),
    DEV_API_PORT: String(SESSION_API_PORT),
    ...(dev.previewHostSuffix ? { DEV_ALLOWED_HOSTS: dev.previewHostSuffix } : {}),
    ...(dev.emulated ? { GOGC: 'off', GOMEMLIMIT: '1536MiB' } : {}),
  }
}

/**
 * The keys `apps/web/.dev.vars` must carry for `pnpm dev` to serve the preview — and the neon
 * driver, straight to the branch: `NEON_LOCAL_PROXY` is emptied, so nothing routes it anywhere else.
 */
export function sessionDevVars(dev: SessionDevEnv): Record<string, string> {
  return {
    DATABASE_DRIVER: 'neon',
    NEON_LOCAL_PROXY: '',
    DEV_UI_PORT: String(SESSION_UI_PORT),
    DEV_API_PORT: String(SESSION_API_PORT),
    APP_URL: dev.previewOrigin ?? `http://localhost:${SESSION_UI_PORT}`,
    ...(dev.previewHostSuffix ? { DEV_ALLOWED_HOSTS: dev.previewHostSuffix } : {}),
  }
}

/** The preview origin's host suffix: `https://{label}.clewro.com` → `.clewro.com`. */
export function previewHostSuffix(template: string | undefined): string | null {
  if (!template) return null
  const host = template.replace(/^[a-z]+:\/\//i, '').split('/')[0] ?? ''
  const suffix = host.slice('{label}'.length).replace(/:\d+$/, '')
  return host.startsWith('{label}') && suffix.startsWith('.') ? suffix : null
}

export const INSTALL_COMMAND = 'pnpm install --frozen-lockfile --prefer-offline --reporter=silent'

/**
 * The kit's bootstrap refuses to run as root (kit 0.15: `os.userInfo().uid === 0` → exit 3), and a
 * sandbox's commands run as root — the container is the isolation boundary, not the user. This
 * preload tells the bootstrap's ONE check otherwise; everything it runs (pnpm, migrate, seed)
 * still runs as root. A kit gap to report upstream: an explicit opt-out for sandboxes.
 *
 * **It also makes the bootstrap's database work lighter.** The kit's bootstrap has no flag to skip
 * its migrate, seed or database check, and reaches each ONLY as a `pnpm <script>` child
 * (`spawn('pnpm', ['db:migrate'])`, `['seed', …]`, `['web', 'db:check']`), which the preload
 * rewrites — the `spawn` binding the bootstrap imported is swapped through
 * `syncBuiltinESMExports`, before the bootstrap loads:
 * - For each part named in `LAUNCH_BOOTSTRAP_SKIP` (`BOOTSTRAP_SKIP_ENV`) it answers that child
 *   with a one-line `node -e` that prints what the kit's step checks for ("Migrations applied")
 *   and exits 0. `sessionBootstrap` always skips `db-check`: the branch was just made through
 *   Neon's API, and the migrator fails loudly if it cannot connect.
 * - `pnpm db:migrate` that is NOT skipped runs the kit's migrator ALONE
 *   (`pnpm web exec dotenv -e .dev.vars -- tsx scripts/migrate.ts`), without the kit's `db-roles`
 *   before and after it: the RLS role those make is on `dev` already (`NeonSessionDb`'s
 *   `ensureAppRole`), and its grants matter only under `TENANT_SCOPE_MODE=enforce`, which a
 *   session never runs. Each of those scripts opens its OWN database WebSocket through the
 *   container's egress interception, and on real Cloudflare containers one of the later ones
 *   hung (docs/plans/sandbox-session-issues.md): a prepare now opens two (migrate, seed), a
 *   session whose migrations changed one, and a resume none.
 * Everything else (`.dev.vars`, the `[ai]` toggle, the install) runs as the kit wrote it.
 */
export const NOT_ROOT_PRELOAD = `${SESSION_LAUNCH_DIR}/bootstrap-in-sandbox.mjs`
export const NOT_ROOT_PRELOAD_SCRIPT = `import cp from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
const userInfo = os.userInfo
os.userInfo = options => ({ ...userInfo(options), uid: 1000 })
const skip = new Set((process.env.LAUNCH_BOOTSTRAP_SKIP || '').split(',').filter(Boolean))
const stand = {
  seed: ['seed', 'seed skipped by Launch: a resume never re-seeds'],
  'db:migrate': ['migrate', 'Migrations applied (skipped by Launch: unchanged since the last bootstrap)'],
  'db:check': ['db-check', 'db:check skipped by Launch: the branch was made through the Neon API'],
}
const instead = {
  'db:migrate': ['web', 'exec', 'dotenv', '-e', '.dev.vars', '--', 'tsx', 'scripts/migrate.ts'],
}
const spawn = cp.spawn
cp.spawn = function (cmd, args, opts) {
  const list = Array.isArray(args) ? args : []
  const script = cmd === 'pnpm' ? (list[0] === 'web' ? list[1] : list[0]) : undefined
  const hit = script && Object.hasOwn(stand, script) ? stand[script] : undefined
  if (hit && skip.has(hit[0])) {
    return spawn.call(this, process.execPath, ['-e', 'console.log(' + JSON.stringify(hit[1]) + ')'], opts)
  }
  if (script && list[0] === script && Object.hasOwn(instead, script)) {
    return spawn.call(this, cmd, [...instead[script], ...list.slice(1)], opts)
  }
  return spawn.apply(this, arguments)
}
syncBuiltinESMExports()
`

/** What a resume's bootstrap may leave out (`BOOTSTRAP_SKIP_ENV`, see {@link NOT_ROOT_PRELOAD}). */
export type BootstrapSkip = 'seed' | 'migrate' | 'db-check'
/** The environment variable the preload reads: comma-separated {@link BootstrapSkip}s. */
export const BOOTSTRAP_SKIP_ENV = 'LAUNCH_BOOTSTRAP_SKIP'

/** Where the kit keeps its SQL migrations — what a resume's migrate decision hashes. */
export const MIGRATIONS_DIR = 'apps/web/migrations'

/**
 * One sha256 over every file under {@link MIGRATIONS_DIR} (path and content, sorted), printed as
 * `migrations=<hex>`: equal hashes mean the session's database already has these migrations.
 */
export const MIGRATIONS_HASH_COMMAND = `cd ${SESSION_WORKSPACE} && h=$( (find ${MIGRATIONS_DIR} -type f -print0 2>/dev/null | sort -z | xargs -0 -r sha256sum) | sha256sum | cut -c1-64) && echo "migrations=$h"`

/** The migrations hash of the checkout in `sandbox`, or null when it could not be computed. */
export async function migrationsHash(sandbox: SandboxPort): Promise<string | null> {
  const result = await sandbox.exec(MIGRATIONS_HASH_COMMAND, { timeoutMs: 60_000 })
  if (result.exitCode !== 0) return null
  return /migrations=([0-9a-f]{64})/.exec(result.stdout)?.[1] ?? null
}

export const BOOTSTRAP_COMMAND = `node --import ${NOT_ROOT_PRELOAD} scripts/bootstrap.mjs --db-url "$LAUNCH_DB_URL" --driver neon --offline --no-dev --no-open --no-plugins --yes`

export const DEV_COMMAND = 'pnpm dev'

/** The dev server's pid (`startDevServer`) — what the port wait checks is still alive. */
export const DEV_PID_FILE = `${SESSION_LAUNCH_DIR}/dev.pid`
/** The dev server's output, for the error when it dies before its ports answer. */
export const DEV_LOG_FILE = `${SESSION_LAUNCH_DIR}/dev.log`
/**
 * `pnpm dev` as the dev step starts it: its pid recorded (the shell `exec`s into pnpm, so `$$`
 * IS pnpm) and its output kept in a file.
 */
export const DEV_START_COMMAND = `mkdir -p ${SESSION_LAUNCH_DIR} && echo $$ > ${DEV_PID_FILE} && exec ${DEV_COMMAND} > ${DEV_LOG_FILE} 2>&1`

/**
 * The install and the bootstrap run one at a time per container (`flock`): a step attempt the
 * platform re-runs while an earlier one is still going (a `wrangler dev` reload resumes a killed
 * attempt later — docs/SESSIONS-LOCAL.md) must not run a second `pnpm install` into the same
 * `node_modules` at once, which fails in seconds with nothing useful said.
 */
export const BOOTSTRAP_LOCK = `${SESSION_LAUNCH_DIR}/bootstrap.lock`
export function serialised(command: string, waitMs: number): string {
  return `mkdir -p ${SESSION_LAUNCH_DIR} && flock -w ${Math.ceil(waitMs / 1000)} ${BOOTSTRAP_LOCK} ${command}`
}

/**
 * Upserts `KEY=value` lines into a dotenv file from `LAUNCH_DEV_VARS` (JSON) — Node, not `sed`,
 * because a value may carry `&` or `/`, which a sed replacement would mangle.
 */
export const DEV_VARS_SCRIPT = `import { existsSync, readFileSync, writeFileSync } from 'node:fs'
const file = process.argv[2]
const vars = JSON.parse(process.env.LAUNCH_DEV_VARS || '{}')
let text = existsSync(file) ? readFileSync(file, 'utf8') : ''
for (const [key, value] of Object.entries(vars)) {
  const line = key + '=' + value
  const re = new RegExp('^' + key + '=.*$', 'm')
  if (re.test(text)) text = text.replace(re, () => line)
  else text += (text === '' || text.endsWith('\\n') ? '' : '\\n') + line + '\\n'
}
writeFileSync(file, text)
`

/**
 * `.claude/settings.local.json` in the checkout (plan §1.3): a hard `deny` on pushing and on
 * touching the remote or git config. Launch owns pushes and PRs — `checkpoint.ts` pushes
 * `session/<short>`, `ship.ts` opens the PR through the GitHub App — never the agent. Turns run
 * with `--permission-mode bypassPermissions` (`claude-stream.ts`), where deny rules are still
 * honoured and allow rules have no effect, so there is no allow list. Excluded from git through
 * `.git/info/exclude`, so it never lands in a commit.
 */
export function claudeSettingsLocal(): string {
  return `${JSON.stringify(
    {
      permissions: {
        deny: ['Bash(git push:*)', 'Bash(git remote:*)', 'Bash(git config:*)'],
      },
    },
    null,
    2
  )}\n`
}

export interface SessionBootstrapContext {
  sandbox: SandboxPort
  /** The database the checkout runs on — a SECRET (see the header). */
  dbUri: string
  dev: SessionDevEnv
  /** A resume against an already-prepared database: the parts of the kit bootstrap to leave out. */
  skip?: readonly BootstrapSkip[]
  /**
   * The running step's detail, called only when it changes: `pnpm install`, then the kit
   * bootstrap's latest `✔ n/10 name` ({@link bootstrapProgressOf}). Never carries a secret.
   */
  onProgress?: (detail: string) => void | Promise<void>
  /** How often the long commands are polled (`SESSION_CALL_LIMITS.commandPollMs`). */
  pollMs?: number
  /** Caps each command's own deadline (`BOOTSTRAP_TIMEOUTS`) — the steps pass `execMaxMs`. */
  maxCommandMs?: number
  /** Test hook: the poll's sleep. */
  sleep?: (ms: number) => Promise<void>
}

export interface BootstrapTimings {
  installMs: number
  bootstrapMs: number
}

/** A failed phase: the exit code and the TAIL of its output (never an env dump). */
export class SessionBootstrapError extends Error {
  constructor(
    readonly phase: 'install' | 'bootstrap' | 'dev-vars' | 'dev',
    message: string
  ) {
    super(message)
    this.name = 'SessionBootstrapError'
  }
}

/** How many lines of a failed command's output travel in its error (the page and the log). */
export const ERROR_TAIL_LINES = 40

/**
 * What a failed command said, for the person: its own error lines first (the kit's bootstrap
 * prints `bootstrap: …` for a usage error and `✖ n/10 …` for a failed step, before any usage text
 * or child output), then the last {@link ERROR_TAIL_LINES} lines — stdout AND stderr, because the
 * kit's bootstrap prints a failed child's output (pnpm's own error) under its `✖` line. `secrets`
 * (the database URI) are replaced wherever they appear, and so is anything shaped like a
 * connection string with a password.
 */
export function tailOf(text: string, secrets: readonly string[] = [], lines = ERROR_TAIL_LINES) {
  let clean = text
  for (const secret of secrets) if (secret) clean = clean.split(secret).join('<database url>')
  clean = clean
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s'"@/]*:[^\s'"@/]*@[^\s'"]*/gi, '<connection string>')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI colour codes from the kit's output
    .replace(/\u001b\[[0-9;]*m/g, '')
  const all = clean.split('\n').filter(line => line.trim() !== '')
  const headline = all.filter(line => /^(bootstrap:|\S*✖|error\b|Error\b|ERR_)/.test(line.trim()))
  const tail = all.slice(-lines).filter(line => !headline.includes(line))
  return [...headline.slice(0, 4), ...tail].join('\n')
}

/**
 * The detail a running boot step shows for the kit bootstrap's progress: its latest `✔ n/10 name`
 * (or `✖ n/10 name`) line, as `✔ 4/10 database` — the mark, the count and the step's own name,
 * nothing else of the line (its `verify` text could name the database host). Null when the log has
 * no such line yet.
 */
export function bootstrapProgressOf(log: string): string | null {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI colour codes from the kit's output
  const clean = log.replace(/\u001b\[[0-9;]*m/g, '')
  let found: string | null = null
  for (const m of clean.matchAll(/^\s*([✔✖])\s+(\d+\/\d+)\s+([a-z][a-z-]*)/gm)) {
    found = `${m[1]} ${m[2]} ${m[3]}`
  }
  return found
}

/** What a running boot step shows while the install runs (pnpm is silent: `--reporter=silent`). */
export const INSTALL_PROGRESS = 'pnpm install'
/** ...and when the kit bootstrap starts, before its first `✔ n/10` line. */
export const BOOTSTRAP_PROGRESS = "starting the app's bootstrap"

/**
 * One long phase as a polled background command (`background-command.ts`), under the bootstrap
 * lock (`serialised`): a non-zero exit and a deadline both become a {@link SessionBootstrapError}
 * with the redacted tail of what it printed.
 */
async function runPhase(
  ctx: SessionBootstrapContext,
  phase: 'install' | 'bootstrap',
  opts: {
    command: string
    timeoutMs: number
    env: Record<string, string>
    what: string
    progressOf?: (log: string) => string | null
  }
): Promise<void> {
  const timeoutMs = Math.min(opts.timeoutMs, ctx.maxCommandMs ?? opts.timeoutMs)
  const report = ctx.onProgress
  let result: { exitCode: number; stdout: string }
  try {
    result = await runInBackground(ctx.sandbox, {
      name: phase,
      dir: SESSION_LAUNCH_DIR,
      command: serialised(opts.command, timeoutMs),
      cwd: SESSION_WORKSPACE,
      env: opts.env,
      timeoutMs,
      ...(ctx.pollMs !== undefined ? { pollMs: ctx.pollMs } : {}),
      ...(ctx.sleep ? { sleep: ctx.sleep } : {}),
      ...(report && opts.progressOf ? { onProgress: report, progressOf: opts.progressOf } : {}),
    })
  } catch (err) {
    if (!(err instanceof BackgroundCommandTimeoutError)) throw err
    const tail = tailOf(err.log, [ctx.dbUri])
    throw new SessionBootstrapError(
      phase,
      `${opts.what} did not finish within ${formatDuration(err.timeoutMs)}; Launch stopped it${tail ? `:\n${tail}` : ''}`
    )
  }
  if (result.exitCode !== 0) {
    throw new SessionBootstrapError(
      phase,
      `${opts.what} failed (exit ${result.exitCode}):\n${tailOf(result.stdout, [ctx.dbUri])}`
    )
  }
}

/** The kit bootstrap against `ctx.dbUri`, then the dev-server keys. See the header. */
export async function sessionBootstrap(ctx: SessionBootstrapContext): Promise<BootstrapTimings> {
  const { sandbox, dev } = ctx
  const env = sessionProcessEnv(dev)
  let shown: string | null = null
  const show = async (detail: string) => {
    if (!ctx.onProgress || detail === shown) return
    shown = detail
    await Promise.resolve(ctx.onProgress(detail)).catch(() => {})
  }
  const progressCtx: SessionBootstrapContext = { ...ctx, onProgress: show }

  // The container reaches its database directly — so exactly that endpoint joins the allow-list,
  // REPLACING any earlier one (the `dev` a prepare run used is dropped when the session's own
  // branch takes over). A URI that is not a Neon endpoint throws here, before anything runs.
  await sandbox.setAllowedHosts(sessionAllowedHosts(sessionDbEgressHosts(ctx.dbUri)))

  const t0 = Date.now()
  await show(INSTALL_PROGRESS)
  await runPhase(progressCtx, 'install', {
    command: INSTALL_COMMAND,
    timeoutMs: BOOTSTRAP_TIMEOUTS.installMs,
    env,
    what: 'pnpm install',
  })

  const t1 = Date.now()
  await sandbox.writeFile(NOT_ROOT_PRELOAD, NOT_ROOT_PRELOAD_SCRIPT)
  // The database check never runs in a sandbox: see NOT_ROOT_PRELOAD.
  const skipped = new Set<BootstrapSkip>([...(ctx.skip ?? []), 'db-check'])
  const skip = { [BOOTSTRAP_SKIP_ENV]: [...skipped].join(',') }
  await show(BOOTSTRAP_PROGRESS)
  // The bootstrap prints its own `✖ n/10` line and the failing child's output under it.
  await runPhase(progressCtx, 'bootstrap', {
    command: BOOTSTRAP_COMMAND,
    timeoutMs: BOOTSTRAP_TIMEOUTS.bootstrapMs,
    env: { ...env, ...skip, LAUNCH_DB_URL: ctx.dbUri },
    what: "The app's bootstrap",
    progressOf: bootstrapProgressOf,
  })
  const t2 = Date.now()

  await writeDevVars(sandbox, `${SESSION_WORKSPACE}/apps/web/.dev.vars`, sessionDevVars(dev))
  return { installMs: t1 - t0, bootstrapMs: t2 - t1 }
}

/** Upsert `vars` into the dotenv file at `path` (inside the container). */
export async function writeDevVars(
  sandbox: SandboxPort,
  path: string,
  vars: Record<string, string>
): Promise<void> {
  const script = `${SESSION_LAUNCH_DIR}/dev-vars.mjs`
  await sandbox.writeFile(script, DEV_VARS_SCRIPT)
  const result = await sandbox.exec(`node ${script} ${path}`, {
    env: { LAUNCH_DEV_VARS: JSON.stringify(vars) },
  })
  if (result.exitCode !== 0) {
    throw new SessionBootstrapError('dev-vars', `Could not write ${path}: ${tailOf(result.stderr)}`)
  }
}

/** One port wait inside {@link startDevServer}: short, so an end request is seen between them. */
export const DEV_WAIT_CHUNK_MS = 20_000

export interface StartDevServerOptions {
  /** Called between wait chunks; throw from it to stop waiting (the person ended the session). */
  checkpoint?: () => Promise<void>
  /** Test hook: the wait chunk length. */
  chunkMs?: number
}

/**
 * `pnpm dev` in the background, then both ports answering. Returns the process id. The waits are
 * chunked ({@link DEV_WAIT_CHUNK_MS}) with `opts.checkpoint` between them, and each chunk fails at
 * once when the dev server's process is gone (`DEV_PID_FILE`) — with the tail of its output
 * (`DEV_LOG_FILE`) as the reason, rather than a curl loop against nothing for minutes.
 */
export async function startDevServer(
  sandbox: SandboxPort,
  dev: SessionDevEnv,
  opts: StartDevServerOptions = {}
): Promise<{ processId: string }> {
  const proc = await sandbox.startProcess(DEV_START_COMMAND, {
    cwd: SESSION_WORKSPACE,
    env: sessionProcessEnv(dev),
  })
  const chunkMs = opts.chunkMs ?? DEV_WAIT_CHUNK_MS
  const waitFor = async (port: number, path: string | undefined, totalMs: number) => {
    const deadline = Date.now() + totalMs
    for (;;) {
      await opts.checkpoint?.()
      const left = deadline - Date.now()
      try {
        await sandbox.waitForPort(port, {
          ...(path ? { path } : {}),
          timeoutMs: Math.max(1000, Math.min(chunkMs, left)),
          pidFile: DEV_PID_FILE,
        })
        return
      } catch (err) {
        // Only "not yet" is retried; a dead process or a broken sandbox fails the step now.
        if (!isChunkTimeout(err)) throw err
        if (Date.now() >= deadline) {
          throw new Error(`port ${port}${path ?? ''} did not answer within ${totalMs / 1000} s`)
        }
      }
    }
  }
  try {
    await waitFor(SESSION_UI_PORT, undefined, BOOTSTRAP_TIMEOUTS.uiMs)
    await waitFor(SESSION_API_PORT, '/api/health', BOOTSTRAP_TIMEOUTS.apiMs)
  } catch (err) {
    if (!(err instanceof SandboxProcessExitedError) && !isPortTimeout(err)) throw err
    const log = await sandbox.readFile(DEV_LOG_FILE).catch(() => null)
    const reason =
      err instanceof SandboxProcessExitedError
        ? 'the dev server exited before its ports answered'
        : err instanceof Error
          ? err.message
          : String(err)
    throw new SessionBootstrapError(
      'dev',
      `The app's dev server did not come up: ${reason}${log ? `\n${tailOf(log)}` : ''}`
    )
  }
  return { processId: proc.id }
}

/** The kit's own "stop this checkout's dev tree" (its supervisor owns the ports). */
export const DEV_STOP_COMMAND = 'pnpm dev:stop'

/** How long a warm resume gives each port to answer before it restarts the dev server. */
export const DEV_PROBE_MS = 3_000

/** Both dev ports answer now (`:5173`, and `:8787/api/health` with a 2xx) — no waiting. */
export async function devServerAnswers(sandbox: SandboxPort): Promise<boolean> {
  try {
    await sandbox.waitForPort(SESSION_UI_PORT, { timeoutMs: DEV_PROBE_MS })
    await sandbox.waitForPort(SESSION_API_PORT, { path: '/api/health', timeoutMs: DEV_PROBE_MS })
    return true
  } catch {
    return false
  }
}

/**
 * The dev step of a WARM resume (`warm.ts`): the kept container's dev server is reused when both
 * ports still answer; otherwise whatever is left of it is stopped (`pnpm dev:stop` — a half-dead
 * tree would hold the strict ports) and it is started again.
 */
export async function resumeDevServer(
  sandbox: SandboxPort,
  dev: SessionDevEnv,
  opts: StartDevServerOptions = {}
): Promise<{ reused: boolean }> {
  if (await devServerAnswers(sandbox)) return { reused: true }
  await sandbox.exec(DEV_STOP_COMMAND, {
    cwd: SESSION_WORKSPACE,
    env: sessionProcessEnv(dev),
    timeoutMs: 60_000,
  })
  await startDevServer(sandbox, dev, opts)
  return { reused: false }
}

const isPortTimeout = (err: unknown) =>
  err instanceof Error && /^port \d+.* did not answer within/.test(err.message)

/** One wait chunk ran out (the adapter's `Port N did not answer within`, the fake's `never opened`). */
const isChunkTimeout = (err: unknown) =>
  !(err instanceof SandboxProcessExitedError) &&
  err instanceof Error &&
  err.name !== 'SessionStepTimeoutError' &&
  /did not answer within|never opened/.test(err.message)
