/**
 * The git proxy's FORWARDING CORE — everything `egress/github.ts` does to a request once it knows
 * whose it is, with nothing of Launch's database or config, so the sandbox host Worker
 * (`src/sandbox-host/`) bundles it too. Two callers, one behaviour:
 *
 * - `handleGitHub` (Launch's own `SessionSandbox`): looks the session up by `ctx.containerId`,
 *   reads its app's repo and branch, and hands over a token getter over the sealed row token.
 * - `hostedGitHub` (`HostedSessionSandbox`, `SESSION_SANDBOX_HOST=remote`): reads the same three
 *   things from the EGRESS GRANT local Launch stored on the sandbox's Durable Object
 *   (`sandbox-host/protocol.ts`), because the host cannot reach Launch's database.
 *
 * {@link forwardGit}, in order: git smart-HTTP only (`parseGitRequest`); the session's ONE repo; a
 * push's body buffered (to {@link MAX_PUSH_BYTES}) and its ref commands read — only
 * `refs/heads/<branch>`, never a delete; the token asked for only THEN (a refused request mints
 * nothing); the allow-listed headers copied and `Authorization: Basic x-access-token:<token>`
 * injected; the fresh-token 401/404 retry ({@link FRESH_TOKEN_RETRY_DELAYS_MS}, `github.ts` §6);
 * `Set-Cookie` stripped from the answer. Refusals are plain text, which is what git prints.
 */

/** A GitHub installation token's lifetime (fixed by GitHub). */
export const INSTALLATION_TOKEN_TTL_MS = 60 * 60 * 1000
/** A token minted this recently may still be settling at GitHub. */
export const FRESH_TOKEN_WINDOW_MS = 60 * 1000
/**
 * The backoff before each retry of a fresh token's 401/404: about 7.5 s in all. A session's first
 * clone was seen still refused 3.5 s after the mint (2026-09-28); Octokit's auth-app retries a
 * fresh installation token's 401 for 5 s after its creation for the same reason.
 */
export const FRESH_TOKEN_RETRY_DELAYS_MS: readonly number[] = [500, 1000, 2000, 4000]
/** The largest push the proxy buffers (it must read the ref commands before forwarding). */
export const MAX_PUSH_BYTES = 100 * 1024 * 1024

/** What the platform hands an outbound handler (`OutboundHandlerContext` in `@cloudflare/containers`). */
export interface EgressContext {
  /** The Durable Object id of the sandbox — `sessions.sandbox_id` for Launch's own sandboxes. */
  containerId: string
  className?: string
}

/** The one repository a session may reach. */
export interface GitRepo {
  owner: string
  repo: string
}

/** The token to inject, and whether GitHub may not accept it yet. */
export interface GitToken {
  token: string
  /** Minted by this request, or within {@link FRESH_TOKEN_WINDOW_MS}. */
  fresh: boolean
}

/**
 * Is a token that expires at `expiresAtMs` still settling at GitHub? Its tokens live exactly an
 * hour, so the expiry says when it was minted.
 */
export function isFreshToken(expiresAtMs: number, nowMs: number): boolean {
  return expiresAtMs - nowMs > INSTALLATION_TOKEN_TTL_MS - FRESH_TOKEN_WINDOW_MS
}

/** A plain-text refusal, which is what git prints to the person. */
export function refuseGit(status: number, message: string): Response {
  return new Response(`${message}\n`, { status, headers: { 'Content-Type': 'text/plain' } })
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

/** The request headers git needs upstream; nothing else of the sandbox's is forwarded. */
const FORWARDED_GIT_HEADERS = [
  'Accept',
  'Accept-Encoding',
  'Content-Type',
  'Content-Encoding',
  'Git-Protocol',
  'User-Agent',
]

export interface ForwardGitOptions {
  /** The session's repository, or null when its app has none (then every request is refused). */
  repo: GitRepo | null
  /** The one branch a push may move (`session/<short>`). */
  branch: string
  /**
   * The token to inject — asked for only once the request has passed every check. Null: the host
   * takes no credential (the local git server). A throw is a 502.
   */
  token: () => Promise<GitToken | null>
  /** Where the request really goes: `https://github.com`, or the local git server. */
  upstream: string
  fetch: typeof fetch
  /** The backoff between a fresh token's retries (tests pass a recorder). */
  sleep: (ms: number) => Promise<void>
}

/** Check, key and forward one git request (see the header). */
export async function forwardGit(req: Request, opts: ForwardGitOptions): Promise<Response> {
  const git = parseGitRequest(req)
  if (!git)
    return refuseGit(403, 'Launch sessions may only use git over HTTPS on their own repository')

  const { repo } = opts
  if (
    !repo?.owner ||
    !repo.repo ||
    repo.owner.toLowerCase() !== git.owner.toLowerCase() ||
    repo.repo.toLowerCase() !== git.repo.toLowerCase()
  ) {
    return refuseGit(403, "Launch sessions may only reach their own app's repository")
  }

  let body: ArrayBuffer | null = null
  if (git.kind === 'rpc') {
    const declared = Number(req.headers.get('Content-Length') ?? 0)
    if (declared > MAX_PUSH_BYTES) return refuseGit(413, 'This push is too large for Launch')
    body = await req.arrayBuffer()
    if (body.byteLength > MAX_PUSH_BYTES) return refuseGit(413, 'This push is too large for Launch')
  }
  if (git.service === 'git-receive-pack' && git.kind === 'rpc' && body) {
    if (req.headers.get('Content-Encoding')) {
      return refuseGit(403, 'Launch cannot read a compressed push')
    }
    const allowed = `refs/heads/${opts.branch}`
    const commands = receivePackCommands(new Uint8Array(body))
    if (!commands) return refuseGit(403, 'Launch could not read this push')
    const bad = commands.find(c => c.ref !== allowed || ZERO_SHA.test(c.newSha))
    if (bad) return refuseGit(403, `Launch sessions may only push ${allowed} (refused ${bad.ref})`)
  }

  let token: GitToken | null
  try {
    token = await opts.token()
  } catch {
    return refuseGit(502, 'Launch could not get a token for this repository')
  }

  const incoming = new URL(req.url)
  const upstream = new URL(`${opts.upstream}${incoming.pathname}${incoming.search}`)
  const headers = new Headers()
  for (const name of FORWARDED_GIT_HEADERS) {
    const value = req.headers.get(name)
    if (value) headers.set(name, value)
  }
  if (token) headers.set('Authorization', `Basic ${btoa(`x-access-token:${token.token}`)}`)

  const send = () =>
    opts.fetch(upstream.toString(), {
      method: req.method,
      headers,
      body: body ?? undefined,
      redirect: 'manual',
    })
  let res: Response
  try {
    res = await send()
    // A fresh token GitHub has not settled yet: the same request again, after a backoff.
    if (token?.fresh) {
      for (const delay of FRESH_TOKEN_RETRY_DELAYS_MS) {
        if (res.status !== 401 && res.status !== 404) break
        await res.body?.cancel()
        await opts.sleep(delay)
        res = await send()
      }
    }
  } catch {
    // An upstream that cannot be reached (the local git server not running, a network failure):
    // a thrown handler reaches git as "Empty reply from server", which names nothing.
    return refuseGit(502, `Launch could not reach the git server at ${upstream.origin}`)
  }
  const out = new Headers(res.headers)
  out.delete('Set-Cookie')
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out })
}
