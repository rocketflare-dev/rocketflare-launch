/**
 * The wire between local Launch and the sandbox host Worker (a session whose `sandbox_host` is
 * `remote`, `docs/SESSIONS-LOCAL.md` § Real containers from a laptop). Imported by BOTH sides, so
 * it is a leaf: types and constants, nothing of Launch's database or config.
 *
 * ONE direction only: Launch → host, over a REMOTE service binding (`SANDBOX_HOST`) — the RPC
 * surface ({@link SandboxHostRpc}) and the preview's `fetch`. The host Worker has no public URL
 * (`workers_dev = false`, `preview_urls = false`), so only a binding in the same Cloudflare account
 * reaches it, and wrangler opens a remote binding only for someone logged in to that account. The
 * host trusts its callers the way any Worker trusts its service bindings.
 *
 * Nothing flows back. The host cannot reach Launch's database, so its outbound handlers (the same
 * forwarding cores as Launch's own: `egress/forward-git.ts`, `egress/forward-model.ts`,
 * `egress/forward-openai.ts`) work from an {@link EgressGrant} Launch PUSHES to the sandbox's
 * Durable Object before git, a turn or a sign-in needs it (`setEgressGrant`, the `host` egress
 * mode, `egress/host.ts`). The container holds no Launch credential in either mode (a person's
 * ChatGPT `auth.json` is in it for a turn, by design, in both).
 */
import type {
  SandboxBackup,
  SandboxBackupOptions,
  SandboxExecOptions,
  SandboxExecResult,
  SandboxProcess,
  SandboxStartOptions,
  SandboxWaitForPortOptions,
} from '../sandbox-port'

/**
 * `sessions.sandbox_id` of a session whose container is on the sandbox host. A Durable Object id
 * is derived from its NAMESPACE, which a laptop cannot compute for another Worker's class, so a
 * remote sandbox is recorded by its name. Nothing looks it up (the host's egress handlers find
 * their grant by the Durable Object's own id, on the host); it only has to be unique, and it never
 * collides with a real id (64 hex characters).
 */
export function remoteSandboxId(name: string): string {
  return `remote:${name}`
}

/** Is this recorded sandbox id one on the sandbox host ({@link remoteSandboxId})? */
export function isRemoteSandboxId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith('remote:')
}

// ---- the egress grant ---------------------------------------------------------------------------

/**
 * What the git handler on the host needs, as `handleGitHub` reads it from Launch's database: the
 * one repo, the one branch a push may move, where the request really goes, and the session's
 * installation token (a SECRET) with its expiry — which says when it was minted, so the host
 * retries a fresh token's 401/404 exactly as Launch's proxy does (`isFreshToken`).
 */
export interface GitEgressGrant {
  owner: string
  repo: string
  /** `refs/heads/<branch>` is the only ref a push may update. */
  branch: string
  /** `https://github.com` (`RepoHostPort.gitUpstream`). */
  upstream: string
  token: string
  /** ms since the epoch. */
  expiresAt: number
  /**
   * P6 6c: public repos a kit upgrade session may FETCH (upload-pack only, no credential) — the
   * pinned kit. Absent for every other session (`forwardGit`'s `readOnlyRepos`).
   */
  readOnlyRepos?: { owner: string; repo: string }[]
}

/**
 * Claude Code's model calls (`api.anthropic.com`): the credential (a SECRET) — Launch's API key
 * (`api_key`, sent as `x-api-key`) or the session creator's Claude subscription token (`oauth`,
 * sent as `Authorization: Bearer` with the OAuth beta flag) — and the policy's model.
 */
export interface AnthropicEgressGrant {
  auth: { kind: 'api_key' | 'oauth'; value: string }
  model: string
}

/** Codex on Launch's account (`api.openai.com`): Launch's OpenAI key (a SECRET) and the model. */
export interface OpenAiEgressGrant {
  key: string
  model: string
}

/**
 * Codex on the creator's ChatGPT plan: `true` lets the session's token refresh (`POST
 * auth.openai.com/oauth/token`, `grant_type: refresh_token`) through. Nothing more — the plan's
 * tokens are in the container's `auth.json` for the turn by design (§18.22-B), and its model calls
 * go to `chatgpt.com` DIRECTLY (ChatGPT blocks requests from the Workers runtime, so the host has
 * no handler for it). Granted for one turn and revoked after it, as Launch's handler allows the
 * refresh only while a turn holds the plan.
 */
export type ChatGptRefreshGrant = true

/**
 * A LOGIN sandbox (`login-<id>`, §18.22): the runtime whose sign-in it runs. Its handlers pass
 * exactly that driver's sign-in requests through untouched (Claude: `CLAUDE_LOGIN_PASSTHROUGH`;
 * Codex: `CODEX_LOGIN_AUTH_PATHS`) — no Launch credential is involved.
 */
export interface LoginEgressGrant {
  runtime: 'claude_code' | 'codex'
}

/**
 * The credentials a remote sandbox's outbound handlers inject — stored in the sandbox's Durable
 * Object storage on the host, never in the container — one PART per kind of traffic. No part for
 * a host → its handler refuses with a 403. Cleared whole when the sandbox is destroyed or its
 * container stops.
 */
export interface EgressGrant {
  /** git (`github.com`): before the clone and each push. */
  git?: GitEgressGrant
  /** Claude Code's model calls: before each turn. */
  anthropic?: AnthropicEgressGrant
  /** Codex on Launch's key: before each turn. */
  openai?: OpenAiEgressGrant
  /** Codex on a ChatGPT plan, its token refresh: for the length of a turn. */
  chatgptRefresh?: ChatGptRefreshGrant
  /** A login sandbox's sign-in. */
  login?: LoginEgressGrant
}

/** Every part, in one list — what the host merges. */
export const EGRESS_GRANT_PARTS = ['git', 'anthropic', 'openai', 'chatgptRefresh', 'login'] as const

/**
 * What `setEgressGrant` takes: per part, a value REPLACES the stored one, `null` REMOVES it, and an
 * absent part is kept as it was.
 */
export type EgressGrantUpdate = { [K in keyof EgressGrant]?: EgressGrant[K] | null }

/** `current` with `update` applied (see {@link EgressGrantUpdate}). */
export function mergeEgressGrant(current: EgressGrant, update: EgressGrantUpdate): EgressGrant {
  const next: Record<string, unknown> = {}
  for (const part of EGRESS_GRANT_PARTS) {
    const value = part in update ? update[part] : current[part]
    if (value) next[part] = value
  }
  return next as EgressGrant
}

// ---- the RPC surface ---------------------------------------------------------------------------

/**
 * Every RPC answer. An error is returned, not thrown: an exception crossing a remote binding keeps
 * its message but not reliably its class or `name`, and the steps branch on the name
 * (`SandboxInterruptedError` → a rollout, `SandboxBackupUnavailableError` → clone instead).
 */
export type HostResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { name: string; message: string } }

/**
 * The sandbox host Worker's RPC surface: `SandboxPort`, with the sandbox name first. No
 * `AbortSignal` anywhere (workerd cannot serialise one — `DataCloneError`), and `streamLogs` is
 * `logStream`: the raw SSE `ReadableStream`, which crosses RPC, parsed on Launch's side.
 */
export interface SandboxHostRpc {
  start(name: string, opts: SandboxStartOptions): Promise<HostResult<null>>
  exec(
    name: string,
    command: string,
    opts?: SandboxExecOptions
  ): Promise<HostResult<SandboxExecResult>>
  startProcess(
    name: string,
    command: string,
    opts?: SandboxExecOptions
  ): Promise<HostResult<SandboxProcess>>
  logStream(name: string, processId: string): Promise<HostResult<ReadableStream<Uint8Array>>>
  kill(
    name: string,
    processId: string,
    signal: 'SIGTERM' | 'SIGKILL' | 'SIGINT'
  ): Promise<HostResult<null>>
  waitForPort(
    name: string,
    port: number,
    opts?: SandboxWaitForPortOptions
  ): Promise<HostResult<null>>
  writeFile(name: string, path: string, content: string): Promise<HostResult<null>>
  /** Raw bytes (an image); a host deployed before it answers "no such method" — redeploy it. */
  writeFileBytes(name: string, path: string, bytes: Uint8Array): Promise<HostResult<null>>
  readFile(name: string, path: string): Promise<HostResult<string | null>>
  setAllowedHosts(name: string, hosts: string[]): Promise<HostResult<null>>
  destroy(name: string): Promise<HostResult<null>>
  backup(name: string, opts: SandboxBackupOptions): Promise<HostResult<SandboxBackup>>
  restore(name: string, backup: SandboxBackup): Promise<HostResult<null>>
  deleteBackup(name: string, backup: SandboxBackup): Promise<HostResult<null>>
  /** Store (merge, {@link EgressGrantUpdate}) the sandbox's {@link EgressGrant}. Idempotent. */
  setEgressGrant(name: string, grant: EgressGrantUpdate): Promise<HostResult<null>>
  /** Forget the sandbox's grant: its handlers refuse everything until the next one. */
  clearEgressGrant(name: string): Promise<HostResult<null>>
}

/** The preview `fetch` names its sandbox and port in these headers (stripped before the container). */
export const PREVIEW_HEADERS = {
  sandbox: 'X-Launch-Sandbox',
  port: 'X-Launch-Sandbox-Port',
} as const

/** The binding as Launch holds it: the RPC methods plus the preview's `fetch`. */
export interface SandboxHostBinding extends SandboxHostRpc {
  fetch(req: Request): Promise<Response>
}
