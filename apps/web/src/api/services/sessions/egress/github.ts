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
 *    under `TOKEN_REMINT_BEFORE_MS` (10 minutes) remain, and sealed back onto the row;
 * 5. forwards to `RepoHostPort.gitUpstream(repo)` — `https://github.com`, or the local git server
 *    (`SESSION_LOCAL_GIT_URL`), which is how `LocalRepoHost` rewrites the clone URL.
 *
 * **Pre-tenant by design**, like the model proxy: the container id is all the request carries, so
 * the lookup names no tenant and the tenant comes from the row (`unscoped-allowlist.test.ts`).
 * Refusals are plain text, which is what git prints to the person.
 */
import { ACTIVE_SESSION_STATUSES, sessionBranchName } from '@launch/shared/launch-sessions'
import { and, eq, inArray } from 'drizzle-orm'
import { type AppConfig, loadConfig } from '../../../../config'
import { type Database, type DatabaseHandle, openDatabase } from '../../../../db/client'
import { apps, type SessionRow, sessions } from '../../../../db/schema'
import { decryptToken, encryptToken } from '../../../auth/oauth-encryption'
import type { AppBindings } from '../../../types'
import { defaultSessionPorts, type RepoHostPort, type RepoRef } from '../ports'
import type { EgressContext } from './anthropic'

/** A sealed token with less than this left is re-minted before use. */
export const TOKEN_REMINT_BEFORE_MS = 10 * 60 * 1000
/** The largest push the proxy buffers (it must read the ref commands before forwarding). */
export const MAX_PUSH_BYTES = 100 * 1024 * 1024

export interface GitHubEgressDeps {
  openDb: (env: AppBindings, cfg: AppConfig) => DatabaseHandle
  /** The repo host for this backend (over the handler's own DB client). */
  repoHost: (db: Database, cfg: AppConfig) => RepoHostPort
  /** Where the rewritten request goes; the global `fetch` by default. */
  fetch: typeof fetch
  now: () => Date
}

const defaultDeps = (env: AppBindings): GitHubEgressDeps => ({
  openDb: (e, cfg) => openDatabase({ ...cfg, HYPERDRIVE: e.HYPERDRIVE }),
  repoHost: (db, cfg) => defaultSessionPorts(env, cfg).repoHost(db),
  fetch: (input, init) => fetch(input, init),
  now: () => new Date(),
})

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

export type GitService = 'git-upload-pack' | 'git-receive-pack'

/** What a git smart-HTTP request is, or null when it is anything else. */
export interface GitRequest {
  owner: string
  repo: string
  service: GitService
  /** `info/refs` (the advertisement) or the service's POST. */
  kind: 'advertise' | 'rpc'
}

const GIT_PATH_RE =
  /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/

/** Parse a smart-HTTP request; everything else git (or anything) might send is null. */
export function parseGitRequest(req: Request): GitRequest | null {
  const url = new URL(req.url)
  const match = GIT_PATH_RE.exec(url.pathname)
  if (!match) return null
  const [, owner, repo, tail] = match as unknown as [string, string, string, string]
  if (tail === 'info/refs') {
    const service = url.searchParams.get('service')
    if (req.method !== 'GET') return null
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') return null
    return { owner, repo, service, kind: 'advertise' }
  }
  if (req.method !== 'POST') return null
  return { owner, repo, service: tail as GitService, kind: 'rpc' }
}

/**
 * The refs a `git-receive-pack` body updates: its leading pkt-lines, `<old> <new> <ref>[\0caps]`,
 * up to the flush packet. Null when the body is not a well-formed command list.
 */
export function receivePackCommands(
  body: Uint8Array
): { oldSha: string; newSha: string; ref: string }[] | null {
  const decoder = new TextDecoder()
  const commands: { oldSha: string; newSha: string; ref: string }[] = []
  let at = 0
  while (at + 4 <= body.length) {
    const length = Number.parseInt(decoder.decode(body.subarray(at, at + 4)), 16)
    if (Number.isNaN(length)) return null
    if (length === 0) return commands.length ? commands : null // the flush ends the commands
    if (length < 4 || at + length > body.length) return null
    let line = decoder.decode(body.subarray(at + 4, at + length))
    at += length
    const nul = line.indexOf('\0')
    if (nul >= 0) line = line.slice(0, nul)
    if (line.startsWith('shallow ')) continue
    const [oldSha, newSha, ref] = line.replace(/\n$/, '').split(' ')
    if (!oldSha || !newSha || !ref) return null
    commands.push({ oldSha, newSha, ref })
  }
  return null
}

const ZERO_SHA = /^0+$/

/** The token to inject: the sealed one while it has 10 minutes left, else a fresh one (sealed back). */
async function gitToken(
  db: Database,
  cfg: AppConfig,
  host: RepoHostPort,
  session: SessionRow,
  repo: RepoRef,
  now: Date
): Promise<string | null> {
  const expiresAt = session.githubTokenExpiresAt?.getTime() ?? 0
  if (session.githubTokenSealed && expiresAt - now.getTime() > TOKEN_REMINT_BEFORE_MS) {
    return decryptToken(cfg, session.githubTokenSealed)
  }
  const auth = await host.gitAuth(repo)
  if (!auth) return null
  await db
    .update(sessions)
    .set({
      githubTokenSealed: await encryptToken(cfg, auth.token),
      githubTokenExpiresAt: auth.expiresAt,
    })
    .where(and(eq(sessions.tenantId, session.tenantId), eq(sessions.id, session.id)))
  return auth.token
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
    if (!session) return refuse(403, 'This sandbox is not a live Launch session')

    const git = parseGitRequest(req)
    if (!git)
      return refuse(403, 'Launch sessions may only use git over HTTPS on their own repository')

    const [app] = await handle.db
      .select({ repoOwner: apps.repoOwner, repoName: apps.repoName })
      .from(apps)
      .where(and(eq(apps.tenantId, session.tenantId), eq(apps.id, session.appId)))
      .limit(1)
    if (
      !app?.repoOwner ||
      !app.repoName ||
      app.repoOwner.toLowerCase() !== git.owner.toLowerCase() ||
      app.repoName.toLowerCase() !== git.repo.toLowerCase()
    ) {
      return refuse(403, "Launch sessions may only reach their own app's repository")
    }
    const repo: RepoRef = { owner: app.repoOwner, repo: app.repoName }

    let body: ArrayBuffer | null = null
    if (git.kind === 'rpc') {
      const declared = Number(req.headers.get('Content-Length') ?? 0)
      if (declared > MAX_PUSH_BYTES) return refuse(413, 'This push is too large for Launch')
      body = await req.arrayBuffer()
      if (body.byteLength > MAX_PUSH_BYTES) return refuse(413, 'This push is too large for Launch')
    }
    if (git.service === 'git-receive-pack' && git.kind === 'rpc' && body) {
      if (req.headers.get('Content-Encoding')) {
        return refuse(403, 'Launch cannot read a compressed push')
      }
      const allowed = `refs/heads/${session.branch ?? sessionBranchName(session.shortId)}`
      const commands = receivePackCommands(new Uint8Array(body))
      if (!commands) return refuse(403, 'Launch could not read this push')
      const bad = commands.find(c => c.ref !== allowed || ZERO_SHA.test(c.newSha))
      if (bad) return refuse(403, `Launch sessions may only push ${allowed} (refused ${bad.ref})`)
    }

    const host = deps.repoHost(handle.db, cfg)
    let token: string | null
    try {
      token = await gitToken(handle.db, cfg, host, session, repo, deps.now())
    } catch {
      return refuse(502, 'Launch could not get a token for this repository')
    }

    const incoming = new URL(req.url)
    const upstream = new URL(`${host.gitUpstream(repo)}${incoming.pathname}${incoming.search}`)
    const headers = new Headers()
    for (const name of [
      'Accept',
      'Accept-Encoding',
      'Content-Type',
      'Content-Encoding',
      'Git-Protocol',
      'User-Agent',
    ]) {
      const value = req.headers.get(name)
      if (value) headers.set(name, value)
    }
    if (token) headers.set('Authorization', `Basic ${btoa(`x-access-token:${token}`)}`)

    const res = await deps.fetch(upstream.toString(), {
      method: req.method,
      headers,
      body: body ?? undefined,
      redirect: 'manual',
    })
    const out = new Headers(res.headers)
    out.delete('Set-Cookie')
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out })
  } finally {
    await handle.close()
  }
}
