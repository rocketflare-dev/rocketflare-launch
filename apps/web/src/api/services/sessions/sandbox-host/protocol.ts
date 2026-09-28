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
 * Nothing flows back: the host has no outbound handlers. A remote session's container calls
 * Anthropic and GitHub DIRECTLY with a key and a token Launch hands it (the `direct` egress mode,
 * `egress/direct.ts`), because the host cannot reach Launch's database to run the proxies.
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
 * remote sandbox is recorded by its name. Nothing looks it up (no egress handler runs for a
 * remote container); it only has to be unique, and it never collides with a real id (64 hex
 * characters).
 */
export function remoteSandboxId(name: string): string {
  return `remote:${name}`
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
