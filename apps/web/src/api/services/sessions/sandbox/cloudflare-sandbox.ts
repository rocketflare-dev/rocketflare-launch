/**
 * `CloudflareSandbox` — the `SandboxPort` over the Sandbox SDK (`@cloudflare/sandbox` 0.12.10,
 * stable): `getSandbox(env.SESSION_SANDBOX, name)` → `exec`, `startProcess` + `streamProcessLogs`
 * + `killProcess`, `waitForPort` (on the process), `writeFile` / `readFile`, `setAllowedHosts`,
 * `containerFetch(req, port)` and `destroy()`. Used by BOTH backends — locally the container is
 * `wrangler dev`'s own.
 *
 * **Slice 3b owns this file.** From 3a it is a stub: the constructor and `id` are real (the
 * Durable Object id is what the platform hands outbound handlers as `ctx.containerId`), every
 * command throws `NotWiredError`. When 3b fills it in, this is one of the TWO files that import the
 * SDK (the other is `durable-objects/session-sandbox.ts`); map the SDK's "interrupted while the
 * platform was updating" error to `SandboxInterruptedError`.
 */
import type { AppConfig } from '../../../../config'
import type { SessionSandbox } from '../../../durable-objects/session-sandbox'
import {
  NotWiredError,
  type SandboxExecOptions,
  type SandboxExecResult,
  type SandboxLogEvent,
  type SandboxPort,
  type SandboxProcess,
  type SandboxStartOptions,
} from '../ports'

export interface CloudflareSandboxOptions {
  cfg: AppConfig
}

export class CloudflareSandbox implements SandboxPort {
  constructor(
    private readonly ns: DurableObjectNamespace<SessionSandbox>,
    readonly name: string,
    readonly opts: CloudflareSandboxOptions
  ) {}

  /** `ctx.containerId` in the outbound handlers: the Durable Object id of `getSandbox(ns, name)`. */
  get id(): string {
    return this.ns.idFromName(this.name).toString()
  }

  start(_opts?: SandboxStartOptions): Promise<void> {
    throw new NotWiredError('CloudflareSandbox.start', '3b')
  }

  exec(_command: string, _opts?: SandboxExecOptions): Promise<SandboxExecResult> {
    throw new NotWiredError('CloudflareSandbox.exec', '3b')
  }

  startProcess(_command: string, _opts?: SandboxExecOptions): Promise<SandboxProcess> {
    throw new NotWiredError('CloudflareSandbox.startProcess', '3b')
  }

  streamLogs(_processId: string, _opts?: { signal?: AbortSignal }): AsyncIterable<SandboxLogEvent> {
    throw new NotWiredError('CloudflareSandbox.streamLogs', '3b')
  }

  kill(_processId: string, _signal?: 'SIGTERM' | 'SIGKILL' | 'SIGINT'): Promise<void> {
    throw new NotWiredError('CloudflareSandbox.kill', '3b')
  }

  waitForPort(_port: number, _opts?: { path?: string; timeoutMs?: number }): Promise<void> {
    throw new NotWiredError('CloudflareSandbox.waitForPort', '3b')
  }

  writeFile(_path: string, _content: string): Promise<void> {
    throw new NotWiredError('CloudflareSandbox.writeFile', '3b')
  }

  readFile(_path: string): Promise<string | null> {
    throw new NotWiredError('CloudflareSandbox.readFile', '3b')
  }

  setAllowedHosts(_hosts: readonly string[]): Promise<void> {
    throw new NotWiredError('CloudflareSandbox.setAllowedHosts', '3b')
  }

  fetch(_port: number, _req: Request): Promise<Response> {
    throw new NotWiredError('CloudflareSandbox.fetch', '3b')
  }

  destroy(): Promise<void> {
    throw new NotWiredError('CloudflareSandbox.destroy', '3b')
  }
}
