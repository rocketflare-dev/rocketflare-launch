/**
 * The git proxy (Launch P3, plan §1.5) — `SessionSandbox.outboundByHost['github.com']`, running
 * IN LAUNCH'S WORKER. The sandbox holds no GitHub token either; this handler:
 *
 * 1. finds the session from `ctx.containerId` → `sessions.sandbox_id` (unique). Unknown → 403;
 * 2. allows only git smart-HTTP on the session's ONE repo (`/<o>/<r>.git/info/refs`,
 *    `git-upload-pack`, `git-receive-pack`) — anything else is 403;
 * 3. injects `Authorization: Basic base64(x-access-token:<token>)` with the session's sealed
 *    installation token (`github_token_sealed`), re-minted through `RepoHostPort.gitAuth` when
 *    under 10 minutes remain;
 * 4. forwards to `RepoHostPort.gitUpstream(repo)` — `https://github.com`, or the local git server
 *    (`SESSION_LOCAL_GIT_URL`), which is how `LocalRepoHost` rewrites the clone URL.
 *
 * **Pre-tenant by design**, like the model proxy: the container id is all the request carries, so
 * the lookup names no tenant and the tenant comes from the row (`unscoped-allowlist.test.ts`).
 *
 * **Slice 3d owns this file.** From 3a it is real up to step 1 and answers 503 after it.
 */
import { ACTIVE_SESSION_STATUSES } from '@launch/shared/launch-sessions'
import { and, eq, inArray } from 'drizzle-orm'
import { type AppConfig, loadConfig } from '../../../../config'
import { type Database, type DatabaseHandle, openDatabase } from '../../../../db/client'
import { type SessionRow, sessions } from '../../../../db/schema'
import type { AppBindings } from '../../../types'
import type { RepoHostPort } from '../ports'
import type { EgressContext } from './anthropic'

export interface GitHubEgressDeps {
  openDb: (env: AppBindings, cfg: AppConfig) => DatabaseHandle
  /** The repo host for this backend (over the handler's own DB client). */
  repoHost: (db: Database, cfg: AppConfig) => RepoHostPort
  /** Where the rewritten request goes; the global `fetch` by default. */
  fetch: typeof fetch
  now: () => Date
}

/** A plain-text refusal, which is what git prints to the person. */
function refuse(status: number, message: string): Response {
  return new Response(`${message}\n`, { status, headers: { 'Content-Type': 'text/plain' } })
}

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

export async function handleGitHub(
  _req: Request,
  env: AppBindings,
  ctx: EgressContext,
  overrides: Partial<GitHubEgressDeps> = {}
): Promise<Response> {
  const cfg = loadConfig(env)
  const openDb =
    overrides.openDb ??
    ((e: AppBindings, c: AppConfig) => openDatabase({ ...c, HYPERDRIVE: e.HYPERDRIVE }))
  const handle = openDb(env, cfg)
  try {
    const session = await sessionForGitSandbox(handle.db, ctx.containerId)
    if (!session) return refuse(403, 'This sandbox is not a live Launch session')
    return refuse(503, 'The Launch git proxy is not wired yet (P3 slice 3d)')
  } finally {
    await handle.close()
  }
}
