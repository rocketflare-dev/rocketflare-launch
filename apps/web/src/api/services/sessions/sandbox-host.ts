/**
 * Where a NEW session's (or sign-in's) container runs — the platform setting
 * `launch_settings.session_sandbox_host` (`SESSION_SANDBOX_HOSTS`, Settings → Coding agents
 * tab's Session sandbox section), and whether each choice can run one on THIS Worker right now:
 *
 * - `local` — this Worker's own `SESSION_SANDBOX`. Deployed: always (Cloudflare's containers).
 *   Under `pnpm dev`: unless Docker was not running when it started — `dev-server.mjs` then starts
 *   wrangler without local containers and says so in `DEV_LOCAL_CONTAINERS=off`.
 * - `remote` — the sandbox host Worker (`launch-sandbox-dev`) through the `SANDBOX_HOST` remote
 *   binding. Development only, never with `SESSION_BACKEND=local`, and only when `pnpm dev`
 *   could declare the binding (logged in to wrangler, the host deployed) — why it could not is
 *   `DEV_SANDBOX_HOST_STATUS`.
 *
 * Nothing stored → `local`, except that a development Worker whose `.dev.vars` still says the old
 * `SESSION_SANDBOX_HOST=remote` starts from `remote` (honoured as the initial value until an admin
 * saves the setting; the var is otherwise gone). Outside development a stored `remote` is ignored.
 *
 * The choice is FROZEN where it is used: on the session row at create (`sessions.sandbox_host`,
 * read back by `sandboxHostOf`) and in a sign-in's Workflow params — so changing the setting
 * applies to new sessions only, and a running session never moves host.
 */
import {
  SESSION_SANDBOX_HOST_LABELS,
  SESSION_SANDBOX_HOSTS,
  SESSION_SANDBOX_UNAVAILABLE,
  type SessionSandboxHost,
  type SessionSandboxOption,
  type SessionSandboxStatus,
  sessionSandboxHostSchema,
} from '@launch/shared/launch-setup'
import { and, eq } from 'drizzle-orm'
import type { AppConfig } from '../../../config'
import type { Database } from '../../../db/client'
import { sessions } from '../../../db/schema'
import type { AppBindings } from '../../types'
import { ConflictError } from '../../utils/core/errors'
import { getSetting, putSetting } from '../launch/credentials'

/** The bindings and dev-only vars availability is read from (all optional: a test passes none). */
export type SandboxHostBindings = Partial<
  Pick<
    AppBindings,
    'SANDBOX_HOST' | 'DEV_LOCAL_CONTAINERS' | 'DEV_SANDBOX_HOST_STATUS' | 'SESSION_SANDBOX_HOST'
  >
>

const DEV_ONLY =
  "Development only: a deployed Launch runs every session in its own Worker's containers."
const NEEDS_CLOUD_BACKEND =
  "Needs SESSION_BACKEND=cloud: a Cloudflare container cannot reach this laptop's git server."
const NO_DOCKER =
  'Docker was not running when pnpm dev started, so this Worker has no local containers. Start Docker and restart pnpm dev.'

/** Why `pnpm dev` started without the `SANDBOX_HOST` binding (`DEV_SANDBOX_HOST_STATUS`). */
const NO_BINDING: Record<string, string> = {
  not_logged_in:
    'pnpm dev could not use your Cloudflare account. Run wrangler login, then restart pnpm dev.',
  not_deployed:
    'The sandbox host Worker (launch-sandbox-dev) is not deployed in your Cloudflare account. Deploy it (docs/DEPLOY.md, The sandbox host), then restart pnpm dev.',
  off: 'Turned off for this pnpm dev (DEV_REMOTE_SANDBOX=0).',
}
const NO_BINDING_DEFAULT =
  'This Worker has no sandbox host binding. Start Launch with pnpm dev, logged in to wrangler.'

const isDevelopment = (cfg: AppConfig) => cfg.APP_ENV === 'development'

/** Why `host` cannot run a session on this Worker right now, or null when it can. */
export function sandboxHostUnavailable(
  host: SessionSandboxHost,
  env: SandboxHostBindings | undefined,
  cfg: AppConfig
): string | null {
  if (host === 'local') {
    return isDevelopment(cfg) && env?.DEV_LOCAL_CONTAINERS?.trim() === 'off' ? NO_DOCKER : null
  }
  if (!isDevelopment(cfg)) return DEV_ONLY
  if (cfg.SESSION_BACKEND === 'local') return NEEDS_CLOUD_BACKEND
  if (!env?.SANDBOX_HOST) {
    return NO_BINDING[env?.DEV_SANDBOX_HOST_STATUS?.trim() ?? ''] ?? NO_BINDING_DEFAULT
  }
  return null
}

/** Each choice as the section draws it. Deployed, only `local` is offered. */
export function sessionSandboxOptions(
  env: SandboxHostBindings | undefined,
  cfg: AppConfig
): SessionSandboxOption[] {
  const hosts = isDevelopment(cfg) ? SESSION_SANDBOX_HOSTS : (['local'] as const)
  return hosts.map(host => {
    const reason = sandboxHostUnavailable(host, env, cfg)
    return { host, label: SESSION_SANDBOX_HOST_LABELS[host], available: !reason, reason }
  })
}

/** The stored setting, or null (nothing stored, or a value that no longer parses). */
async function storedHost(db: Database): Promise<SessionSandboxHost | null> {
  const parsed = sessionSandboxHostSchema.safeParse(await getSetting(db, 'session_sandbox_host'))
  return parsed.success ? parsed.data : null
}

/** What a new session gets: the stored setting, else the default — see the header. */
export async function sessionSandboxHost(
  db: Database,
  env: SandboxHostBindings | undefined,
  cfg: AppConfig
): Promise<{ host: SessionSandboxHost; isDefault: boolean }> {
  if (!isDevelopment(cfg)) return { host: 'local', isDefault: (await storedHost(db)) === null }
  const stored = await storedHost(db)
  if (stored) return { host: stored, isDefault: false }
  const legacy = env?.SESSION_SANDBOX_HOST?.trim() === 'remote'
  return { host: legacy ? 'remote' : 'local', isDefault: true }
}

/** The overview's `sessionSandbox`. */
export async function sessionSandboxStatus(
  db: Database,
  env: SandboxHostBindings | undefined,
  cfg: AppConfig
): Promise<SessionSandboxStatus> {
  const { host, isDefault } = await sessionSandboxHost(db, env, cfg)
  return { host, isDefault, options: sessionSandboxOptions(env, cfg) }
}

/**
 * The host to freeze on a new session or sign-in — 409 `session_sandbox_unavailable` (with the
 * reason) when it cannot run one now, rather than starting a container that cannot boot.
 */
export async function resolveNewSandboxHost(
  db: Database,
  env: SandboxHostBindings | undefined,
  cfg: AppConfig
): Promise<SessionSandboxHost> {
  const { host } = await sessionSandboxHost(db, env, cfg)
  const reason = sandboxHostUnavailable(host, env, cfg)
  if (reason) {
    throw new ConflictError(
      `${SESSION_SANDBOX_HOST_LABELS[host]} cannot run a session right now. ${reason}`,
      SESSION_SANDBOX_UNAVAILABLE,
      { host }
    )
  }
  return host
}

/** A session's frozen host (`sessions.sandbox_host`); `local` for a row that is gone. */
export async function sessionSandboxHostOf(
  db: Database,
  tenantId: string,
  sessionId: string
): Promise<SessionSandboxHost> {
  const [row] = await db
    .select({ sandboxHost: sessions.sandboxHost })
    .from(sessions)
    .where(and(eq(sessions.tenantId, tenantId), eq(sessions.id, sessionId)))
    .limit(1)
  return row?.sandboxHost === 'remote' ? 'remote' : 'local'
}

export interface SessionSandboxChange {
  before: SessionSandboxHost
  after: SessionSandboxHost
}

/**
 * Store `host` — 409 `session_sandbox_unavailable` when it cannot run a session on this Worker
 * (deployed, `remote` always is). Null when it is already stored; saving the default over nothing
 * stores it (and is a change: the setting now exists).
 */
export async function updateSessionSandboxHost(
  db: Database,
  env: SandboxHostBindings | undefined,
  cfg: AppConfig,
  host: SessionSandboxHost,
  userId: string
): Promise<SessionSandboxChange | null> {
  const reason = sandboxHostUnavailable(host, env, cfg)
  if (reason) {
    throw new ConflictError(
      `${SESSION_SANDBOX_HOST_LABELS[host]} is not available: ${reason}`,
      SESSION_SANDBOX_UNAVAILABLE,
      { host }
    )
  }
  const current = await sessionSandboxHost(db, env, cfg)
  if (!current.isDefault && current.host === host) return null
  await putSetting(db, 'session_sandbox_host', host, userId)
  return { before: current.host, after: host }
}
