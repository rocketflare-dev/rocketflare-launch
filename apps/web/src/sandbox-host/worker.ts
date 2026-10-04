/**
 * The SANDBOX HOST Worker (`wrangler.sandbox-host.toml`, deployed as `launch-sandbox-dev`): real
 * Cloudflare containers for a laptop's Launch. `wrangler dev` always runs `[[containers]]` on local
 * Docker, and a Durable Object cannot be a remote binding — but a service binding can
 * (`remote = true`). So this small Worker holds the session sandbox Durable Object and its
 * container, and local Launch reaches it through `SANDBOX_HOST` for a session on the `remote` host
 * (`RemoteSandbox`, `docs/SESSIONS-LOCAL.md` § Real containers from a laptop).
 *
 * The default export is a `WorkerEntrypoint` whose methods are `SandboxPort` with the sandbox name
 * first (`SandboxHostRpc`), each one a `CloudflareSandbox` call — the adapter Launch runs
 * in-process — answered as a `HostResult` so an error keeps its name across the binding. Its
 * `fetch` is the preview's way in (a WebSocket upgrade crosses a service binding's `fetch`, never
 * RPC). `ContainerProxy` is exported because the platform routes the container's intercepted
 * traffic through it — and runs `HostedSessionSandbox`'s outbound handlers in it, which inject the
 * credentials from the sandbox's EGRESS GRANT (`setEgressGrant` / `clearEgressGrant`, stored on
 * the sandbox's Durable Object, `sandbox-host/egress.ts`).
 *
 * It has no public URL (`workers_dev = false`, `preview_urls = false`) and no secrets of its own:
 * only a binding in the same account reaches it, and it knows nothing about Launch but a sandbox's
 * name and the grant Launch pushed for it.
 */
import { WorkerEntrypoint } from 'cloudflare:workers'
import {
  CloudflareSandbox,
  type CloudflareSandboxConfig,
  mapSandboxError,
} from '../api/services/sessions/sandbox/cloudflare-sandbox'
import {
  type EgressGrantUpdate,
  type HostResult,
  PREVIEW_HEADERS,
  type SandboxHostRpc,
} from '../api/services/sessions/sandbox-host/protocol'
import type {
  SandboxBackup,
  SandboxBackupOptions,
  SandboxExecOptions,
  SandboxStartOptions,
  SandboxWaitForPortOptions,
} from '../api/services/sessions/sandbox-port'
import type { SandboxHostEnv } from './env'
import type { HostedSessionSandbox } from './hosted-session-sandbox'

export { ContainerProxy } from '../api/durable-objects/session-sandbox-base'
export { HostedSessionSandbox } from './hosted-session-sandbox'

/**
 * The adapter's settings on this side. Workspace backups are OFF: the only mode that needs no R2
 * credentials (`binding`) moves the whole archive through the Durable Object's 128 MB of memory,
 * which suits `wrangler dev`, not the platform.
 */
export const SANDBOX_HOST_CONFIG: CloudflareSandboxConfig = {
  APP_ENV: 'development',
  SESSION_WORKSPACE_BACKUP: 'off',
}

/** The SDK's control server's own port inside a sandbox — never a preview. */
const SDK_CONTROL_PORT = 3000

/** A sandbox name as Launch makes them: a session id, or `prepare-<appId>`. */
const SANDBOX_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/

/** `work`'s value, or its error (mapped like the in-process adapter's) as `{ name, message }`. */
export async function hostCall<T>(work: () => Promise<T>): Promise<HostResult<T>> {
  try {
    return { ok: true, value: await work() }
  } catch (err) {
    const mapped = mapSandboxError(err)
    return {
      ok: false,
      error:
        mapped instanceof Error
          ? { name: mapped.name, message: mapped.message }
          : { name: 'Error', message: String(mapped) },
    }
  }
}

const done = async (work: Promise<unknown>): Promise<null> => {
  await work
  return null
}

export default class SandboxHost
  extends WorkerEntrypoint<SandboxHostEnv>
  implements SandboxHostRpc
{
  private sandbox(name: string): CloudflareSandbox<HostedSessionSandbox> {
    if (!SANDBOX_NAME.test(name)) throw new Error('Not a Launch sandbox name')
    return new CloudflareSandbox(this.env.SESSION_SANDBOX, name, { cfg: SANDBOX_HOST_CONFIG })
  }

  /** The sandbox's Durable Object itself — the same one `getSandbox(ns, name)` reaches. */
  private object(name: string) {
    if (!SANDBOX_NAME.test(name)) throw new Error('Not a Launch sandbox name')
    const ns = this.env.SESSION_SANDBOX
    return ns.get(ns.idFromName(name))
  }

  start(name: string, opts: SandboxStartOptions = {}) {
    return hostCall(() => done(this.sandbox(name).start(opts)))
  }

  exec(name: string, command: string, opts: SandboxExecOptions = {}) {
    return hostCall(() => this.sandbox(name).exec(command, opts))
  }

  startProcess(name: string, command: string, opts: SandboxExecOptions = {}) {
    return hostCall(() => this.sandbox(name).startProcess(command, opts))
  }

  logStream(name: string, processId: string) {
    return hostCall(() => this.sandbox(name).logStream(processId))
  }

  kill(name: string, processId: string, signal: 'SIGTERM' | 'SIGKILL' | 'SIGINT') {
    return hostCall(() => done(this.sandbox(name).kill(processId, signal)))
  }

  waitForPort(name: string, port: number, opts: SandboxWaitForPortOptions = {}) {
    return hostCall(() => done(this.sandbox(name).waitForPort(port, opts)))
  }

  writeFile(name: string, path: string, content: string) {
    return hostCall(() => done(this.sandbox(name).writeFile(path, content)))
  }

  writeFileBytes(name: string, path: string, bytes: Uint8Array) {
    return hostCall(() => done(this.sandbox(name).writeFileBytes(path, bytes)))
  }

  readFile(name: string, path: string) {
    return hostCall(() => this.sandbox(name).readFile(path))
  }

  setAllowedHosts(name: string, hosts: string[]) {
    return hostCall(() => done(this.sandbox(name).setAllowedHosts(hosts)))
  }

  destroy(name: string) {
    return hostCall(() => done(this.sandbox(name).destroy()))
  }

  backup(name: string, opts: SandboxBackupOptions) {
    return hostCall(() => this.sandbox(name).backup(opts))
  }

  restore(name: string, backup: SandboxBackup) {
    return hostCall(() => done(this.sandbox(name).restore(backup)))
  }

  deleteBackup(name: string, backup: SandboxBackup) {
    return hostCall(() => done(this.sandbox(name).deleteBackup(backup)))
  }

  setEgressGrant(name: string, grant: EgressGrantUpdate) {
    return hostCall(() => done(this.object(name).setEgressGrant(grant)))
  }

  clearEgressGrant(name: string) {
    return hostCall(() => done(this.object(name).clearEgressGrant()))
  }

  /** The preview: plain HTTP or the HMR WebSocket upgrade, to one port of one sandbox. */
  override async fetch(request: Request): Promise<Response> {
    const name = request.headers.get(PREVIEW_HEADERS.sandbox) ?? ''
    const port = Number(request.headers.get(PREVIEW_HEADERS.port))
    if (!SANDBOX_NAME.test(name) || !Number.isInteger(port) || port < 1 || port > 65535) {
      return new Response('Not found', { status: 404 })
    }
    if (port === SDK_CONTROL_PORT) return new Response('Forbidden', { status: 403 })
    const headers = new Headers(request.headers)
    headers.delete(PREVIEW_HEADERS.sandbox)
    headers.delete(PREVIEW_HEADERS.port)
    return this.sandbox(name).fetch(port, new Request(request, { headers }))
  }
}
