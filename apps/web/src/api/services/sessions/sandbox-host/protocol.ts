/**
 * The wire between local Launch and the sandbox host Worker (`SESSION_SANDBOX_HOST=remote`,
 * `docs/SESSIONS-LOCAL.md` § Real containers from a laptop). Imported by BOTH sides, so it is a
 * leaf: types and constants, nothing of Launch's database or config.
 *
 * ONE direction only: Launch → host, over a REMOTE service binding (`SANDBOX_HOST`) — the RPC
 * surface ({@link SandboxHostRpc}) and the preview's `fetch`. The host Worker has no public URL
 * (`workers_dev = false`, `preview_urls = false`), so only a binding in the same Cloudflare account
 * reaches it, and wrangler opens a remote binding only for someone logged in to that account. The
 * host trusts its callers the way any Worker trusts its service bindings.
 *
 * Nothing flows back. The host cannot reach Launch's database, so its outbound handlers (the same
 * forwarding cores as Launch's own: `egress/forward-git.ts`, `egress/forward-model.ts`) work from
 * an {@link EgressGrant} Launch PUSHES to the sandbox's Durable Object before git or a turn needs
 * it (`setEgressGrant`, the `host` egress mode, `egress/host.ts`). The container itself holds no
 * credential in either mode.
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
}

/** What the model handler on the host needs: the real key (a SECRET) and the policy's model. */
export interface ModelEgressGrant {
  key: string
  model: string
}

/**
 * The credentials a remote sandbox's outbound handlers inject — stored in the sandbox's Durable
 * Object storage on the host, never in the container. `setEgressGrant` REPLACES each half it
 * carries and keeps the other (git is granted before the clone and each push, the model before
 * each turn); it is cleared when the sandbox is destroyed or its container stops. No half → the
 * handler refuses with a 403.
 */
export interface EgressGrant {
  git?: GitEgressGrant
  model?: ModelEgressGrant
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
  readFile(name: string, path: string): Promise<HostResult<string | null>>
  setAllowedHosts(name: string, hosts: string[]): Promise<HostResult<null>>
  destroy(name: string): Promise<HostResult<null>>
  backup(name: string, opts: SandboxBackupOptions): Promise<HostResult<SandboxBackup>>
  restore(name: string, backup: SandboxBackup): Promise<HostResult<null>>
  deleteBackup(name: string, backup: SandboxBackup): Promise<HostResult<null>>
  /** Store (merge) the sandbox's {@link EgressGrant}. Idempotent. */
  setEgressGrant(name: string, grant: EgressGrant): Promise<HostResult<null>>
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
