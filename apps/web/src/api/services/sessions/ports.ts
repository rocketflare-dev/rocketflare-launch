/**
 * The coding sessions' PORTS (Launch P3, `docs/plans/p3-sessions.md` §3a): everything a session
 * needs from the outside world, as four interfaces, so the Workflow, the routes and the egress
 * handlers are written — and tested — against fakes (`tests/helpers/fake-sandbox.ts`,
 * `tests/helpers/fake-anthropic.ts`, the FakeCloud) and never against Cloudflare, Neon, GitHub or
 * Anthropic.
 *
 * | Port             | What it is                                             | Adapters (`SESSION_BACKEND`)             |
 * |------------------|--------------------------------------------------------|------------------------------------------|
 * | `SandboxPort`    | one session's container: commands, processes, files, ports | `sandbox/cloudflare-sandbox.ts` (both) |
 * | `SessionDbPort`  | the app's prepared `dev` database and a branch of it per session | `db/neon-session-db.ts` (both: always a real Neon branch) |
 * | `RepoHostPort`   | where the repo lives: git auth for the egress handler, PRs, CI checks | `repo/github-repo-host.ts` (cloud) · `repo/local-repo-host.ts` (local) |
 * | `ModelUpstream`  | where the model proxy sends a keyed request            | the global `fetch` (Anthropic)           |
 *
 * **`defaultSessionPorts(env, cfg)` is the ONE place the ports are bound to adapters.** The
 * adapter modules exist from slice 3a on as stubs that throw `NotWiredError`, each owned by the
 * slice that fills it in (3b: sandbox and db, 3d: repo) — so a slice replaces the body of its own
 * file and this one never changes. Tests never reach `defaultSessionPorts`: the Workflow takes
 * `overrides.ports` and the route suites mock this module.
 *
 * Two rules every adapter keeps:
 *
 * - **No secret crosses a port into a step result or an event.** `SessionBranch.uri` and
 *   `GitAuth.token` are secrets: the caller seals them onto the row (`encryptToken`) or uses them
 *   and drops them.
 * - **The Sandbox SDK is imported in exactly two files**: the Durable Object class
 *   (`durable-objects/session-sandbox.ts`) and `sandbox/cloudflare-sandbox.ts`. Everything else
 *   sees `SandboxPort`.
 */
import type {
  AppSessionDb,
  PrChecks,
  SessionDb,
  SessionPolicy,
} from '@launch/shared/launch-sessions'
import type { AppConfig } from '../../../config'
import type { Database } from '../../../db/client'
import type { SessionRow } from '../../../db/schema'
import type { AppBindings } from '../../types'
import { NeonSessionDb } from './db/neon-session-db'
import { HostEgress } from './egress/host'
import { GitHubRepoHost } from './repo/github-repo-host'
import { LocalRepoHost } from './repo/local-repo-host'
import { CloudflareSandbox } from './sandbox/cloudflare-sandbox'
import { RemoteSandbox } from './sandbox/remote-sandbox'
import type { SandboxHostBinding } from './sandbox-host/protocol'
import type { SandboxPort } from './sandbox-port'

// ---- errors ------------------------------------------------------------------------------------

/**
 * A port method whose adapter a later slice builds. Thrown by the 3a stubs so a call that arrives
 * too early fails by NAME rather than by `undefined is not a function`.
 */
export class NotWiredError extends Error {
  constructor(what: string, slice: '3b' | '3c' | '3d') {
    super(`${what} is not wired yet (P3 slice ${slice}, docs/plans/p3-sessions.md)`)
    this.name = 'NotWiredError'
  }
}

// ---- SandboxPort (the leaf `sandbox-port.ts`, re-exported) ----------------------------------------

export * from './sandbox-port'

// ---- SessionDbPort -----------------------------------------------------------------------------

/** The app as the database and repo ports need it — resolved by the caller, tenant-first. */
export interface SessionAppRef {
  id: string
  tenantId: string
  slug: string
  repoOwner: string
  repoName: string
  defaultBranch: string
  /** The app's Neon project (`app_environments.neon.projectId`); null when it has none. */
  neonProjectId: string | null
  /** `apps.session_db` as it stands. */
  sessionDb: AppSessionDb | null
}

/** A session's database: the non-secret description and its connection string (a SECRET). */
export interface SessionBranch {
  db: SessionDb
  /** Seal it onto `sessions.db_uri_sealed`; never return it from a step or put it in an event. */
  uri: string
}

export interface SessionDbPort {
  /**
   * Make sure the app has a `dev` database to branch from — Neon: a `dev` branch created
   * `init_source: 'schema-only'` from `main` with role `session_owner` (made in SQL) and an empty
   * `session_app`. Returns what `apps.session_db` should now say (status `none`
   * until a prepare run has migrated and seeded it). Idempotent.
   */
  ensureDev(app: SessionAppRef): Promise<AppSessionDb>
  /** A branch of `dev` for one session, with `session_owner`'s password reset on it. */
  createBranch(app: SessionAppRef, session: { id: string; shortId: string }): Promise<SessionBranch>
  /** Delete a session's branch. Idempotent: an already-gone branch is success. */
  deleteBranch(app: SessionAppRef, db: SessionDb): Promise<void>
  /** The `dev` database's connection string, for the prepare run (a SECRET). */
  devUriFor(app: SessionAppRef): Promise<string>
  /**
   * The ship gate's throwaway database (issue #1): a CHILD branch of the session's own branch,
   * named `name` (`gate-<shortId>-<attempt>`, `gate-branch.ts`), with its own compute. Waits for
   * `create_branch` only. Idempotent: a branch of that name is found and reused. Non-secret.
   */
  createGateBranch(app: SessionAppRef, parent: SessionDb, name: string): Promise<GateBranch>
  /**
   * `session_owner`'s connection string on a gate branch (direct, `sslmode=require`), its password
   * reset first so it opens that branch and nothing else. A SECRET: into the test command's
   * environment and nowhere else.
   */
  gateBranchUri(app: SessionAppRef, branch: GateBranch): Promise<string>
  /**
   * Delete a session's gate branches (`gate-<shortId>-*`), all but `keep`. Idempotent (a branch
   * already gone is success). Runs BEFORE the session's own branch is deleted: Neon refuses to
   * delete a branch that has children. Returns the names deleted.
   */
  deleteGateBranches(
    app: SessionAppRef,
    shortId: string,
    opts?: { keep?: string }
  ): Promise<string[]>
  /** The sweep: delete every gate branch of the app's project created before `olderThan`. */
  sweepGateBranches(app: SessionAppRef, olderThan: Date): Promise<string[]>
}

/** A ship gate's branch — ids and hosts, nothing secret (`createGateBranch`). */
export interface GateBranch {
  name: string
  branchId: string
  /** The compute's id (`ep-…`): the kit's `TEST_DATABASE_ENDPOINT`. */
  endpointId: string
  /** The compute's DIRECT host (`ep-….<region>.aws.neon.tech`); the pooler adds `-pooler`. */
  host: string
}

// ---- RepoHostPort ------------------------------------------------------------------------------

export interface RepoRef {
  owner: string
  repo: string
}

/** What the GitHub egress handler injects: an installation token scoped to ONE repo. A SECRET. */
export interface GitAuth {
  token: string
  expiresAt: Date
}

export interface OpenPullRequestInput {
  /** `session/<shortId>`. */
  head: string
  /** The branch it merges into — the app's default branch. */
  base: string
  title: string
  body: string
}

export interface RepoHostPort {
  /** Where an intercepted git smart-HTTP request really goes: `https://github.com` or `SESSION_LOCAL_GIT_URL`. */
  gitUpstream(repo: RepoRef): string
  /**
   * A token for the one repo (`contents: write`, `pull_requests: write`, 1 hour) — or null when the
   * host needs none (local). The caller seals it onto `github_token_sealed` and re-mints it when
   * under 10 minutes remain.
   */
  gitAuth(repo: RepoRef): Promise<GitAuth | null>
  /** Open (or find the open) PR for `head`. Local: records `local://…` and a synthetic number. */
  openPullRequest(
    repo: RepoRef,
    input: OpenPullRequestInput
  ): Promise<{ number: number; url: string }>
  /** The PR head's CI, check runs plus the combined status, folded (`prChecksSchema`). */
  getChecks(repo: RepoRef, input: { prNumber: number; headSha: string }): Promise<PrChecks>
}

// ---- ModelUpstream -----------------------------------------------------------------------------

/**
 * Where the model proxy sends a request after swapping in the real key. A port only so a test can
 * hand in `fake-anthropic.ts` and assert the placeholder never reaches upstream.
 */
export interface ModelUpstream {
  fetch(req: Request): Promise<Response>
}

// ---- SessionEgressPort -------------------------------------------------------------------------

/**
 * How a session's container reaches Anthropic and GitHub — the one thing that differs between a
 * container in Launch's own Worker and one on the sandbox host (`SESSION_SANDBOX_HOST=remote`). In
 * BOTH the container holds no credential and an outbound handler injects it on the way out:
 *
 * | mode      | model calls | git | metering and budget |
 * |-----------|-------------|-----|---------------------|
 * | `proxied` | the placeholder key; `egress/anthropic.ts` swaps the real one in, in Launch's Worker | `egress/github.ts` injects the session's token, only for its repo and branch | per request, in the model proxy; over budget → 403 before the call |
 * | `host`    | the placeholder key; the host's handler swaps in the key Launch granted it (`egress/host.ts`) | the host's handler injects the token Launch granted it — same repo and branch rules | per turn, from Claude Code's own usage (`turn-meter.ts`): checked before the turn, and the turn is killed when its running cost reaches the budget |
 *
 * `proxied` is every deployed Launch and `wrangler dev` on local Docker; `host` is development
 * only (the host cannot reach Launch's database, so Launch pushes the handlers an egress grant).
 * The turn runner and the checkpoint are the same code in both: they ask this port to grant git
 * and the model before they are used, and `proxied` answers "nothing to do".
 */
export interface SessionEgressPort {
  readonly mode: 'proxied' | 'host'
  /**
   * Before a turn: variables the turn's process gets on top of `claudeTurnEnv` — never a secret.
   * `host` grants the sandbox the model key (on the host, not in the container) and returns only
   * the placeholder; throws `ModelKeyMissingError` when no key is configured.
   */
  turnEnv(sandbox: SandboxPort, session: SessionRow): Promise<Record<string, string>>
  /**
   * Before git talks to the remote (the clone, a turn, a checkpoint's push): `host` grants the
   * sandbox a fresh-enough installation token for its repo and branch. `proxied`: nothing.
   */
  prepareGit(sandbox: SandboxPort, session: SessionRow): Promise<void>
}

/** The egress handlers do the work; the container holds no credential. */
export const PROXIED_EGRESS: SessionEgressPort = {
  mode: 'proxied',
  turnEnv: async () => ({}),
  prepareGit: async () => {},
}

/** The session's egress mode — `proxied` for any ports that do not say otherwise (the fakes). */
export function egressFor(ports: Pick<SessionPorts, 'egress'>, db: Database): SessionEgressPort {
  return ports.egress?.(db) ?? PROXIED_EGRESS
}

// ---- the bundle --------------------------------------------------------------------------------

export interface SessionPorts {
  /** The sandbox named `name` (a session id; `prepare-<appId>` for a prepare run). */
  sandbox(name: string): SandboxPort
  /** The database port, over the step's own DB client (it reads the sealed Neon credential). */
  sessionDb(db: Database): SessionDbPort
  /** The repo host, over the step's own DB client (it reads the sealed GitHub App credential). */
  repoHost(db: Database): RepoHostPort
  model: ModelUpstream
  /** How the container reaches Anthropic and GitHub; absent = `proxied` (see `egressFor`). */
  egress?(db: Database): SessionEgressPort
}

/** What a caller needs besides the ports to act on a session: the policy it runs under. */
export interface SessionRuntimeContext {
  cfg: AppConfig
  policy: SessionPolicy
}

/**
 * The real adapters for this Worker, per `SESSION_BACKEND` (`local` only under
 * `APP_ENV=development` — `loadConfig` refuses it elsewhere) and `SESSION_SANDBOX_HOST`. A
 * session's database is ALWAYS a real Neon branch of the app's project, reached directly from the
 * container. `SESSION_BACKEND=local` swaps only the repo host (the local git server).
 * `SESSION_SANDBOX_HOST=remote` (development only, never with `local`) swaps the sandbox for
 * `RemoteSandbox` over the `SANDBOX_HOST` binding and the egress mode for `host`; otherwise the
 * container is this Worker's `SESSION_SANDBOX` (`wrangler dev`'s Docker locally) behind the proxies.
 */
export function defaultSessionPorts(env: AppBindings, cfg: AppConfig): SessionPorts {
  const local = cfg.SESSION_BACKEND === 'local'
  const remote = cfg.SESSION_SANDBOX_HOST === 'remote'
  const repoHost = (db: Database): RepoHostPort =>
    local ? new LocalRepoHost(cfg) : new GitHubRepoHost(db, cfg)
  return {
    sandbox: name =>
      remote
        ? new RemoteSandbox(sandboxHostBinding(env), name)
        : new CloudflareSandbox(env.SESSION_SANDBOX, name, {
            cfg,
            backupBucket: env.BACKUP_BUCKET,
          }),
    sessionDb: db => new NeonSessionDb(db, cfg),
    repoHost,
    model: { fetch: req => fetch(req) },
    egress: db =>
      remote
        ? new HostEgress(db, cfg, repoHost(db), {
            setEgressGrant: (name, grant) => sandboxHostBinding(env).setEgressGrant(name, grant),
          })
        : PROXIED_EGRESS,
  }
}

/** `SANDBOX_HOST`, declared only in the config `pnpm dev` generates for `SESSION_SANDBOX_HOST=remote`. */
function sandboxHostBinding(env: AppBindings): SandboxHostBinding {
  if (!env.SANDBOX_HOST) {
    throw new Error(
      'SESSION_SANDBOX_HOST=remote, but this Worker has no SANDBOX_HOST binding: start Launch with ' +
        '`pnpm dev`, which runs wrangler with wrangler.dev-remote.toml (docs/SESSIONS-LOCAL.md)'
    )
  }
  return env.SANDBOX_HOST as unknown as SandboxHostBinding
}
