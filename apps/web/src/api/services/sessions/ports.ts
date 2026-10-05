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
import type { AgentRuntimeId } from '@launch/shared/launch-agents'
import type {
  AppSessionDb,
  PrChecks,
  SessionDb,
  SessionPolicy,
} from '@launch/shared/launch-sessions'
import type { SessionSandboxHost } from '@launch/shared/launch-setup'
import type { AppConfig } from '../../../config'
import type { Database } from '../../../db/client'
import type { SessionRow } from '../../../db/schema'
import type { AppBindings } from '../../types'
import { createSessionCredentialPort, PLATFORM_CREDENTIALS } from './credentials/lease'
import { NeonSessionDb } from './db/neon-session-db'
import { HostEgress } from './egress/host'
import { GitHubRepoHost } from './repo/github-repo-host'
import { LocalRepoHost } from './repo/local-repo-host'
import type { SessionCredentialPort } from './runtimes/types'
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
  /**
   * `slice`: a P3 slice, or one of §18.22's streams — `A` (Claude subscriptions) or `B` (Codex),
   * which fill in the runtime seam's stubs (`runtimes/`, `docs/CONCEPTS.md` §18.22).
   */
  constructor(what: string, slice: '3b' | '3c' | '3d' | 'A' | 'B') {
    super(
      slice === 'A' || slice === 'B'
        ? `${what} is not wired yet (§18.22 stream ${slice}, docs/CONCEPTS.md)`
        : `${what} is not wired yet (P3 slice ${slice}, docs/plans/p3-sessions.md)`
    )
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
  /**
   * The app's staging branch in that project (`app_environments` `staging` → `neon.branchId`) —
   * what `dev` is cut from (`parent-data`, then scrubbed); null when it has none.
   */
  neonStagingBranchId: string | null
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
   * Make sure the app has a `dev` database to branch from — Neon: a `dev` branch cut
   * `parent-data` from the app's STAGING branch and scrubbed (the app's databases dropped, every
   * inherited password reset) before anything else sees it — or, with no staging branch,
   * `schema-only` from `main` — with role `session_owner` (made in SQL) and an empty
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
  /**
   * Issue #5: the pull request as it stands now, read fresh (`land.ci`, `land.merge`), or null when
   * it does not exist. Token: `pull_requests: read`.
   */
  getPullRequest(repo: RepoRef, prNumber: number): Promise<RepoPullRequest | null>
  /**
   * Issue #5: squash-merge the PR ON `input.sha` (the landing's gate SHA). Never throws for the
   * answers a landing acts on: GitHub's 409 (the head moved) → `head_moved`; 405/422 (a required
   * check or review missing, a conflict) → `refused` with GitHub's message. Anything else throws.
   * Token: `contents: write`, `pull_requests: write`.
   */
  mergePullRequest(repo: RepoRef, input: MergeShipPullRequestInput): Promise<MergePullRequestResult>
  /**
   * Issue #5: the first failing check on `headSha` — its name, URL and the last 80 lines of its
   * log (`FAILED_CHECK_LOG_LINES`: an Actions job's log; else its annotations), or
   * null when nothing failed. **`logTail` is NOT redacted**: the caller redacts it (the gate's
   * redaction) before it reaches an event. Tokens: `checks`/`statuses: read`, `actions: read`.
   */
  failedCheckLog(repo: RepoRef, input: { headSha: string }): Promise<FailedCheckLog | null>
  /**
   * Issue #9: post a COMPLETED check run on `input.headSha` from Launch's own GitHub App — the
   * `launch/gate` attestation a green ship leaves on its pushed head. **Idempotent per
   * `(name, headSha, externalId)`**: a run already there from an earlier try (a retried Workflow
   * step) is answered (`created: false`) and nothing new is posted. Throws on any GitHub failure —
   * the caller decides that an attestation never fails a ship. `local`: nothing to post on
   * (`created: false`, `id: null`). Token: `checks: write`.
   */
  createCheckRun(repo: RepoRef, input: CreateCheckRunInput): Promise<CreateCheckRunResult>
}

/** Issue #9: what `RepoHostPort.createCheckRun` posts (always `status: completed`). */
export interface CreateCheckRunInput {
  name: string
  headSha: string
  /** The reporter's id for the run — `launch/gate`'s is `tree:<HEAD^{tree}>`. */
  externalId: string
  conclusion: 'success'
  output: { title: string; summary: string; text: string }
}

export interface CreateCheckRunResult {
  /** GitHub's id for the run; null where there is no GitHub (`local`). */
  id: number | null
  /** False when an earlier try's run was found instead (or there is nowhere to post). */
  created: boolean
}

/** Issue #5: a pull request as the landing reads it (`RepoHostPort.getPullRequest`). */
export interface RepoPullRequest {
  number: number
  url: string
  title: string
  state: 'open' | 'closed'
  merged: boolean
  /** The PR's head commit now — the landing refuses anything but its gate SHA. */
  headSha: string
  /** The merge commit on the base branch, once merged. */
  mergeSha: string | null
  /** ISO, once merged. */
  mergedAt: string | null
}

/** Issue #5: what `RepoHostPort.mergePullRequest` sends (always a squash). */
export interface MergeShipPullRequestInput {
  prNumber: number
  /** The landing's gate SHA: the merge happens on this head or not at all. */
  sha: string
  /** `"<PR title> (#n)"`. */
  commitTitle: string
  /** The ship summary's body plus "Merged by Launch from session <short>[, approved by <name>]". */
  commitMessage: string
}

export type MergePullRequestResult =
  | { merged: true; sha: string }
  | { merged: false; code: 'head_moved' | 'refused'; message: string }

/** Issue #5: a red CI's failing check (`RepoHostPort.failedCheckLog`). */
export interface FailedCheckLog {
  name: string
  url: string | null
  /** The log's last lines, UNREDACTED; null when GitHub has none (expired, or a bare status). */
  logTail: string | null
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
 * How a session's container reaches its model provider and GitHub — the one thing that differs
 * between a container in Launch's own Worker and one on the sandbox host (`sessions.sandbox_host`
 * `remote`). In BOTH the container holds no Launch credential and an outbound handler injects it
 * on the way out:
 *
 * | mode      | model calls | git | metering and budget |
 * |-----------|-------------|-----|---------------------|
 * | `proxied` | the placeholder; Launch's egress handlers (`egress/registry.ts`) swap the real credential in, in Launch's Worker | `egress/github.ts` injects the session's token, only for its repo and branch | per request, in the proxies; over budget → 403 before the call — except a Codex turn on a ChatGPT plan, metered per turn from Codex's own usage (`chatgpt.com` is reached directly, `egress/registry.ts`) with no money budget |
 * | `host`    | the placeholder; the host's handlers swap in the credential Launch granted the sandbox for the turn (`egress/host.ts`) | the host's handler injects the token Launch granted it — same repo and branch rules | per turn, from the CLI's own usage (`turn-meter.ts`): checked before the turn, and a turn on Launch's account is killed when its running cost reaches the budget |
 *
 * `proxied` is every deployed Launch and `wrangler dev` on local Docker; `host` is development
 * only (the host cannot reach Launch's database, so Launch pushes the handlers an egress grant).
 * The turn runner, the checkpoint and the login Workflow are the same code in both: they ask this
 * port to grant what is about to be used, and `proxied` answers "nothing to do".
 */
export interface SessionEgressPort {
  readonly mode: 'proxied' | 'host'
  /**
   * Before a turn: variables the turn's process gets on top of the runtime's own `turnEnv` —
   * never a secret. `host` grants the sandbox the turn's model credential (on the host, not in
   * the container) and adds nothing; throws `ModelKeyMissingError` when Launch's key is not
   * configured, `CredentialNeedsLoginError` when the creator's subscription cannot be spent.
   */
  turnEnv(sandbox: SandboxPort, session: SessionRow): Promise<Record<string, string>>
  /**
   * After a turn, whatever happened (absent = nothing): `host` revokes what was granted for the
   * length of the turn only (a ChatGPT plan's token refresh).
   */
  endTurn?(sandbox: SandboxPort, session: SessionRow): Promise<void>
  /**
   * Before git talks to the remote (the clone, a turn, a checkpoint's push): `host` grants the
   * sandbox a fresh-enough installation token for its repo and branch. `proxied`: nothing.
   */
  prepareGit(sandbox: SandboxPort, session: SessionRow): Promise<void>
  /**
   * Before a LOGIN sandbox's CLI starts (§18.22, absent = nothing): `host` grants it `runtime`'s
   * sign-in passthrough. `proxied`: nothing (Launch's handlers find the login row).
   */
  prepareLogin?(sandbox: SandboxPort, runtime: AgentRuntimeId): Promise<void>
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

/**
 * §18.22: how a turn gets its credential — `PLATFORM_CREDENTIALS` (lease nothing; a `user` row
 * fails its turn by name) for any ports that do not say otherwise (the fakes).
 */
export function credentialsFor(
  ports: Pick<SessionPorts, 'credentials'>,
  db: Database
): SessionCredentialPort {
  return ports.credentials?.(db) ?? PLATFORM_CREDENTIALS
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
  /** §18.22: each turn's credential lease; absent = platform only (see `credentialsFor`). */
  credentials?(db: Database): SessionCredentialPort
}

/** What a caller needs besides the ports to act on a session: the policy it runs under. */
export interface SessionRuntimeContext {
  cfg: AppConfig
  policy: SessionPolicy
}

/**
 * The real adapters for this Worker, per `SESSION_BACKEND` (`local` only under
 * `APP_ENV=development` — `loadConfig` refuses it elsewhere) and the sandbox HOST the caller
 * resolved — a session's frozen `sessions.sandbox_host` (`sandboxHostOf(row)`), a login's
 * Workflow params, or the platform setting for something new (`sandbox-host.ts`). A session's
 * database is ALWAYS a real Neon branch of the app's project, reached directly from the
 * container. `SESSION_BACKEND=local` swaps only the repo host (the local git server). `remote`
 * (development only, never with `local`) swaps the sandbox for `RemoteSandbox` over the
 * `SANDBOX_HOST` binding and the egress mode for `host`; `local` (the default) is this Worker's
 * `SESSION_SANDBOX` (`wrangler dev`'s Docker locally) behind the proxies.
 */
export function defaultSessionPorts(
  env: AppBindings,
  cfg: AppConfig,
  host: SessionSandboxHost = 'local'
): SessionPorts {
  const local = cfg.SESSION_BACKEND === 'local'
  const remote = host === 'remote'
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
    credentials: db => createSessionCredentialPort(db, cfg),
  }
}

/** `SANDBOX_HOST`, declared only in the dev config `pnpm dev` generates (`wrangler.dev-remote.toml`). */
function sandboxHostBinding(env: AppBindings): SandboxHostBinding {
  if (!env.SANDBOX_HOST) {
    throw new Error(
      'This session runs on the remote sandbox host, but this Worker has no SANDBOX_HOST binding: ' +
        'start Launch with `pnpm dev` while logged in to wrangler, with the host deployed ' +
        '(docs/SESSIONS-LOCAL.md § Real containers from a laptop)'
    )
  }
  return env.SANDBOX_HOST as unknown as SandboxHostBinding
}

/** The host a session's container runs on — frozen on the row at create. */
export function sandboxHostOf(row: Pick<SessionRow, 'sandboxHost'>): SessionSandboxHost {
  return row.sandboxHost === 'remote' ? 'remote' : 'local'
}
