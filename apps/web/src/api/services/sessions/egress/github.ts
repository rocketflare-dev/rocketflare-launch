/**
 * The git proxy (Launch P3, plan §1.5) — `SessionSandbox.outboundByHost['github.com']`, running
 * IN LAUNCH'S WORKER. The sandbox holds no GitHub token; this handler:
 *
 * 1. finds the session from `ctx.containerId` → `sessions.sandbox_id` (unique). Unknown → 403;
 * 2. allows only git smart-HTTP on the session's ONE repo — `GET /<o>/<r>[.git]/info/refs?service=
 *    git-upload-pack|git-receive-pack`, `POST …/git-upload-pack`, `POST …/git-receive-pack` —
 *    anything else (another repo, the web UI, an API path, a raw download) is 403;
 * 3. on a push, reads the ref-update commands at the head of the body and refuses (403) any that is
 *    not `refs/heads/<the session's branch>` or that deletes it — so even a model that got past
 *    `--disallowedTools "Bash(git push:*)"` can only ever move `session/<short>`;
 * 4. injects `Authorization: Basic base64(x-access-token:<token>)` with the session's sealed
 *    installation token (`github_token_sealed`), re-minted through `RepoHostPort.gitAuth` when
 *    under `TOKEN_REMINT_BEFORE_MS` (10 minutes) remain — an expired one included, which is the
 *    usual case after a session sat idle past the token's hour — and sealed back onto the row in a
 *    compare-and-set: when two requests re-mint at once (a fetch's `info/refs` and its POST, two
 *    git processes), the one whose write lands wins and the other adopts the stored token, so
 *    every request converges on ONE token and a fresh one is never overwritten by an older one;
 * 5. forwards to `RepoHostPort.gitUpstream(repo)` — `https://github.com`, or the local git server
 *    (`SESSION_LOCAL_GIT_URL`), which is how `LocalRepoHost` rewrites the clone URL;
 * 6. **retries a fresh token's 401/404**: an installation token GitHub has only just issued is not
 *    always accepted for a second or so (eventual consistency — observed: a push one second after
 *    a re-mint failed "Repository not found", the same proxy served both services minutes later),
 *    and GitHub answers an unauthenticated request for a private repo with a 404. So when the
 *    token is fresh (minted by this request, or sealed within the last `FRESH_TOKEN_WINDOW_MS`)
 *    and the answer is 401 or 404, the SAME request is sent again after each of
 *    `FRESH_TOKEN_RETRY_DELAYS_MS` (0.5, 1, 2 and 4 s). Replaying is safe: the body is already
 *    buffered, and a 401/404 means GitHub did nothing with it. A token that has been valid for a
 *    while gets no retry — its 404 is real.
 *
 * Steps 2, 3, 5 and 6 are `forwardGit` (`forward-git.ts`, no database), which the sandbox host's
 * `HostedSessionSandbox` runs too, over the egress grant local Launch stores on it instead of
 * this lookup (`SESSION_SANDBOX_HOST=remote`, `egress/host.ts`).
 *
 * **Pre-tenant by design**, like the model proxy: the container id is all the request carries, so
 * the lookup names no tenant and the tenant comes from the row (`unscoped-allowlist.test.ts`).
 * Refusals are plain text, which is what git prints to the person.
 */
import { ACTIVE_SESSION_STATUSES, sessionBranchName } from '@launch/shared/launch-sessions'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { type AppConfig, loadConfig } from '../../../../config'
import { type Database, type DatabaseHandle, openDatabase } from '../../../../db/client'
import { apps, type SessionRow, sessions } from '../../../../db/schema'
import { decryptToken, encryptToken } from '../../../auth/oauth-encryption'
import type { AppBindings } from '../../../types'
import { defaultSessionPorts, type RepoHostPort, type RepoRef } from '../ports'
import {
  type EgressContext,
  forwardGit,
  type GitToken,
  isFreshToken,
  refuseGit,
} from './forward-git'

export {
  FRESH_TOKEN_RETRY_DELAYS_MS,
  FRESH_TOKEN_WINDOW_MS,
  type GitRequest,
  type GitService,
  type GitToken,
  INSTALLATION_TOKEN_TTL_MS,
  MAX_PUSH_BYTES,
  parseGitRequest,
  receivePackCommands,
} from './forward-git'

/** A sealed token with less than this left is re-minted before use. */
export const TOKEN_REMINT_BEFORE_MS = 10 * 60 * 1000

export interface GitHubEgressDeps {
  openDb: (env: AppBindings, cfg: AppConfig) => DatabaseHandle
  /** The repo host for this backend (over the handler's own DB client). */
  repoHost: (db: Database, cfg: AppConfig) => RepoHostPort
  /** Where the rewritten request goes; the global `fetch` by default. */
  fetch: typeof fetch
  now: () => Date
  /** The backoff between a fresh token's retries (tests pass a recorder). */
  sleep: (ms: number) => Promise<void>
}

const defaultDeps = (env: AppBindings): GitHubEgressDeps => ({
  openDb: (e, cfg) => openDatabase({ ...cfg, HYPERDRIVE: e.HYPERDRIVE }),
  repoHost: (db, cfg) => defaultSessionPorts(env, cfg).repoHost(db),
  fetch: (input, init) => fetch(input, init),
  now: () => new Date(),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
})

/**
 * The live session a container belongs to, or null. PRE-TENANT: `sandbox_id` is unique and
 * supplied by the platform; the tenant is taken from the row.
 */
export async function sessionForGitSandbox(
  db: Database,
  sandboxId: string
): Promise<SessionRow | null> {
  const [row] = await db
    .select()
    .from(sessions)
    .where(
      and(eq(sessions.sandboxId, sandboxId), inArray(sessions.status, [...ACTIVE_SESSION_STATUSES]))
    )
    .limit(1)
  return row ?? null
}

/** The token {@link sessionGitToken} settled on, and when it expires (a remote grant carries it). */
export interface SessionGitToken extends GitToken {
  expiresAt: Date
}

/** A sealed token worth using: it has more than {@link TOKEN_REMINT_BEFORE_MS} left. */
async function usableSealed(
  cfg: AppConfig,
  row: Pick<SessionRow, 'githubTokenSealed' | 'githubTokenExpiresAt'>,
  now: Date
): Promise<SessionGitToken | null> {
  const expiresAt = row.githubTokenExpiresAt?.getTime() ?? 0
  if (!row.githubTokenSealed || expiresAt - now.getTime() <= TOKEN_REMINT_BEFORE_MS) return null
  const token = await decryptToken(cfg, row.githubTokenSealed)
  if (!token) return null
  return { token, fresh: isFreshToken(expiresAt, now.getTime()), expiresAt: new Date(expiresAt) }
}

/**
 * The token to inject: the sealed one while it has 10 minutes left, else a fresh one, sealed back
 * in a compare-and-set on the expiry this request read — a request that loses the race adopts the
 * token the winner stored (see the header). Null when the host takes no credential. Also what the
 * `host` egress mode puts in a remote sandbox's egress grant (`egress/host.ts`): one token per
 * session, whichever path asks.
 */
export async function sessionGitToken(
  db: Database,
  cfg: AppConfig,
  host: RepoHostPort,
  session: SessionRow,
  repo: RepoRef,
  now: Date
): Promise<SessionGitToken | null> {
  const sealed = await usableSealed(cfg, session, now)
  if (sealed) return sealed
  const auth = await host.gitAuth(repo)
  if (!auth) return null
  const readExpiry = session.githubTokenExpiresAt
  const landed = await db
    .update(sessions)
    .set({
      githubTokenSealed: await encryptToken(cfg, auth.token),
      githubTokenExpiresAt: auth.expiresAt,
    })
    .where(
      and(
        eq(sessions.tenantId, session.tenantId),
        eq(sessions.id, session.id),
        readExpiry === null
          ? isNull(sessions.githubTokenExpiresAt)
          : eq(sessions.githubTokenExpiresAt, readExpiry)
      )
    )
    .returning({ id: sessions.id })
  if (landed.length === 0) {
    // Another request re-minted first: use the token it stored, if it is a good one.
    const [current] = await db
      .select({
        githubTokenSealed: sessions.githubTokenSealed,
        githubTokenExpiresAt: sessions.githubTokenExpiresAt,
      })
      .from(sessions)
      .where(and(eq(sessions.tenantId, session.tenantId), eq(sessions.id, session.id)))
      .limit(1)
    const winner = current ? await usableSealed(cfg, current, now) : null
    if (winner) return winner
  }
  return { token: auth.token, fresh: true, expiresAt: auth.expiresAt }
}

export async function handleGitHub(
  req: Request,
  env: AppBindings,
  ctx: EgressContext,
  overrides: Partial<GitHubEgressDeps> = {}
): Promise<Response> {
  const deps = { ...defaultDeps(env), ...overrides }
  const cfg = loadConfig(env)
  const handle = deps.openDb(env, cfg)
  try {
    const session = await sessionForGitSandbox(handle.db, ctx.containerId)
    if (!session) return refuseGit(403, 'This sandbox is not a live Launch session')

    const [app] = await handle.db
      .select({ repoOwner: apps.repoOwner, repoName: apps.repoName })
      .from(apps)
      .where(and(eq(apps.tenantId, session.tenantId), eq(apps.id, session.appId)))
      .limit(1)
    const repo: RepoRef | null =
      app?.repoOwner && app.repoName ? { owner: app.repoOwner, repo: app.repoName } : null

    const host = deps.repoHost(handle.db, cfg)
    return await forwardGit(req, {
      repo,
      branch: session.branch ?? sessionBranchName(session.shortId),
      // Minted (or read back) only once the request has passed every check.
      token: async () =>
        repo ? sessionGitToken(handle.db, cfg, host, session, repo, deps.now()) : null,
      upstream: repo ? host.gitUpstream(repo) : '',
      fetch: deps.fetch,
      sleep: deps.sleep,
    })
  } finally {
    await handle.close()
  }
}
