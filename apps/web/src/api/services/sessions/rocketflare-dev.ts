/**
 * How a Rocketflare checkout (kit 0.15) is brought up inside a session's sandbox — the
 * `devBootstrap` of spec/02, as Launch drives it (plan §3b, S7). Everything here goes through the
 * `SandboxPort`, so it runs the same against a real container and a `FakeSandbox`.
 *
 * `sessionBootstrap(ctx)` — the `bootstrap` step (and a `prepare` run's migrate + seed):
 *
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
 *    reads before `.dev.vars`; locally `NEON_LOCAL_PROXY` too (the scripts read the driver from
 *    the environment).
 * 3. The dev-server keys go INTO `apps/web/.dev.vars` afterwards — `APP_URL=<preview origin>` (the
 *    Worker builds its CORS / CSRF allow-list and redirects from it and cannot read the process
 *    environment), the ports, and `NEON_LOCAL_PROXY` when local (the bootstrap clears it under
 *    `--db-url`, which is right for Neon and wrong for the laptop's proxy).
 *
 * `startDevServer(sandbox, dev)` — the `dev` step: `pnpm dev` in the background, then
 * `:5173` answering and `:8787/api/health` 2xx.
 *
 * **Never port 3000**: it is the Sandbox SDK's own control server inside every sandbox (S7
 * finding 3); `tests/config/session-bootstrap.test.ts` pins that nothing here names it.
 *
 * The database URI is the ONE credential a session's container holds — for its own throwaway
 * branch (spec/07) — and it travels only as the `LAUNCH_DB_URL` environment variable of the
 * bootstrap command and in the checkout's git-ignored `.dev.vars`; never in an argument, a step
 * result or an event.
 */
import type { SandboxPort } from './ports'

/** Bump with `LABEL dev.rocketflare.launch.session-image` in `containers/session/Dockerfile`. */
export const SESSION_IMAGE_VERSION = 'session-1'
/** The kit tag whose pnpm store the image carries (`ARG KIT_TAG`). */
export const SESSION_KIT_TAG = '0.15.0'

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

/** How long each phase may take before the step fails (then cleanup runs). */
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
  /** `SESSION_LOCAL_NEON_PROXY` when local (`http://host.docker.internal:<port>`), else null. */
  localNeonProxy: string | null
  /**
   * `SESSION_BACKEND=local`: the laptop runs the amd64-only sandbox image under emulation (QEMU on
   * an ARM Mac), where Go binaries — esbuild, under `tsx`, Vite and wrangler — crash in their
   * garbage collector ("The service was stopped", a nil-pointer panic mid-transform). Measured in
   * slice 3b: `GOGC=off` keeps them alive; `GOMAXPROCS=1` and `GODEBUG=asyncpreemptoff=1` do
   * not. `GOMEMLIMIT` bounds the cost — the collector only runs near it. Deployed containers are
   * native amd64 and get neither.
   */
  local?: boolean
}

/** Command-level variables every step shares: no credential, no telemetry, the ports. */
export function sessionProcessEnv(dev: SessionDevEnv): Record<string, string> {
  return {
    CI: '1',
    WRANGLER_SEND_METRICS: 'false',
    DEV_UI_PORT: String(SESSION_UI_PORT),
    DEV_API_PORT: String(SESSION_API_PORT),
    ...(dev.previewHostSuffix ? { DEV_ALLOWED_HOSTS: dev.previewHostSuffix } : {}),
    ...(dev.localNeonProxy ? { NEON_LOCAL_PROXY: dev.localNeonProxy } : {}),
    ...(dev.local ? { GOGC: 'off', GOMEMLIMIT: '1536MiB' } : {}),
  }
}

/** The keys `apps/web/.dev.vars` must carry for `pnpm dev` to serve the preview. */
export function sessionDevVars(dev: SessionDevEnv): Record<string, string> {
  return {
    DEV_UI_PORT: String(SESSION_UI_PORT),
    DEV_API_PORT: String(SESSION_API_PORT),
    APP_URL: dev.previewOrigin ?? `http://localhost:${SESSION_UI_PORT}`,
    ...(dev.previewHostSuffix ? { DEV_ALLOWED_HOSTS: dev.previewHostSuffix } : {}),
    ...(dev.localNeonProxy ? { NEON_LOCAL_PROXY: dev.localNeonProxy } : {}),
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
 */
export const NOT_ROOT_PRELOAD = `${SESSION_LAUNCH_DIR}/bootstrap-in-sandbox.mjs`
export const NOT_ROOT_PRELOAD_SCRIPT = `import os from 'node:os'
const userInfo = os.userInfo
os.userInfo = options => ({ ...userInfo(options), uid: 1000 })
`

export const BOOTSTRAP_COMMAND = `node --import ${NOT_ROOT_PRELOAD} scripts/bootstrap.mjs --db-url "$LAUNCH_DB_URL" --driver neon --offline --no-dev --no-open --no-plugins --yes`

export const DEV_COMMAND = 'pnpm dev'

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
 * `.claude/settings.local.json` in the checkout (plan §1.3): the Bash commands a turn may run
 * without asking, and a hard `deny` on pushing — Launch commits and pushes (checkpoint), never
 * the agent. Excluded from git through `.git/info/exclude`, so it never lands in a commit.
 */
export function claudeSettingsLocal(): string {
  return `${JSON.stringify(
    {
      permissions: {
        allow: [
          'Bash(pnpm:*)',
          'Bash(node:*)',
          'Bash(npx:*)',
          'Bash(git status:*)',
          'Bash(git diff:*)',
          'Bash(git log:*)',
          'Bash(git show:*)',
          'Bash(ls:*)',
          'Bash(cat:*)',
          'Bash(grep:*)',
          'Bash(rg:*)',
          'Bash(find:*)',
          'Bash(curl http://localhost:*)',
        ],
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

/**
 * What a failed command said, for the person: its own error lines first (the kit's bootstrap
 * prints `bootstrap: …` for a usage error and `✖ n/10 …` for a failed step, before any usage text
 * or child output), then the tail.
 */
function tailOf(text: string, lines = 12): string {
  const all = text.split('\n').filter(line => line.trim() !== '')
  const headline = all.filter(line => /^(bootstrap:|\S*✖|error\b|Error\b|ERR_)/.test(line.trim()))
  const tail = all.slice(-lines).filter(line => !headline.includes(line))
  return [...headline.slice(0, 4), ...tail].join('\n')
}

/** The kit bootstrap against `ctx.dbUri`, then the dev-server keys. See the header. */
export async function sessionBootstrap(ctx: SessionBootstrapContext): Promise<BootstrapTimings> {
  const { sandbox, dev } = ctx
  const env = sessionProcessEnv(dev)

  const t0 = Date.now()
  const install = await sandbox.exec(INSTALL_COMMAND, {
    cwd: SESSION_WORKSPACE,
    env,
    timeoutMs: BOOTSTRAP_TIMEOUTS.installMs,
  })
  if (install.exitCode !== 0) {
    throw new SessionBootstrapError(
      'install',
      `pnpm install failed (exit ${install.exitCode}): ${tailOf(install.stderr || install.stdout)}`
    )
  }

  const t1 = Date.now()
  await sandbox.writeFile(NOT_ROOT_PRELOAD, NOT_ROOT_PRELOAD_SCRIPT)
  const boot = await sandbox.exec(BOOTSTRAP_COMMAND, {
    cwd: SESSION_WORKSPACE,
    env: { ...env, LAUNCH_DB_URL: ctx.dbUri },
    timeoutMs: BOOTSTRAP_TIMEOUTS.bootstrapMs,
  })
  if (boot.exitCode !== 0) {
    // The bootstrap prints its own `✖ n/10` line and the failing child's tail: that is the message.
    throw new SessionBootstrapError(
      'bootstrap',
      `The app's bootstrap failed (exit ${boot.exitCode}): ${tailOf(`${boot.stdout}\n${boot.stderr}`)}`
    )
  }
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

/** `pnpm dev` in the background, then both ports answering. Returns the process id. */
export async function startDevServer(
  sandbox: SandboxPort,
  dev: SessionDevEnv
): Promise<{ processId: string }> {
  const proc = await sandbox.startProcess(DEV_COMMAND, {
    cwd: SESSION_WORKSPACE,
    env: sessionProcessEnv(dev),
  })
  try {
    await sandbox.waitForPort(SESSION_UI_PORT, { timeoutMs: BOOTSTRAP_TIMEOUTS.uiMs })
    await sandbox.waitForPort(SESSION_API_PORT, {
      path: '/api/health',
      timeoutMs: BOOTSTRAP_TIMEOUTS.apiMs,
    })
  } catch (err) {
    throw new SessionBootstrapError(
      'dev',
      `The app's dev server did not come up: ${err instanceof Error ? err.message : String(err)}`
    )
  }
  return { processId: proc.id }
}
