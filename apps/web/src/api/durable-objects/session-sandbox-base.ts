/**
 * The coding session container's Durable Object, WITHOUT where it runs: the egress settings and
 * the container-time stamp that every session sandbox shares. Two classes extend it:
 *
 * - `SessionSandbox` (`session-sandbox.ts`) — in Launch's own Worker, deployed and under
 *   `wrangler dev`. Its outbound handlers ARE the egress handlers, and its container time goes
 *   straight to Launch's database.
 * - `HostedSessionSandbox` (`src/sandbox-host/hosted-session-sandbox.ts`) — in the sandbox host
 *   Worker a laptop reaches over a remote service binding (`SESSION_SANDBOX_HOST=remote`). It has
 *   NO outbound handlers (its container calls Anthropic and GitHub directly, with credentials
 *   Launch hands it — the `direct` egress mode) and records no container time.
 *
 * One of the TWO files that import the Sandbox SDK (the other is `sandbox/cloudflare-sandbox.ts`).
 * It imports nothing of Launch's database or config, so the host Worker bundles without them.
 *
 * Egress (plan §1.4, §1.5, S7) — the same in both:
 *
 * - `enableInternet = false` and an allow-list: `SESSION_BASE_ALLOWED_HOSTS`. The session adapter
 *   re-applies it with `setAllowedHosts` at start (`sessionAllowedHosts`), and the prepare and
 *   bootstrap steps widen it by EXACTLY the hosts of the Neon endpoint the container's database
 *   lives on (`sessionDbEgressHosts`) — never a wildcard.
 * - **`interceptHttps = true`, set explicitly.** It defaults to `false` on the stable packages
 *   (containers 0.3.7 / sandbox 0.12.10) despite the docs, and without it no HTTPS leaves a locked
 *   sandbox, allow-listed or not (S7 finding 1).
 * - `SessionSandbox` sets `outboundByHost` for `api.anthropic.com` and `github.com`. The registry
 *   is keyed by CLASS NAME (`@cloudflare/containers`), so the host's class inherits none. A host
 *   must ALSO be on the allow-list for its handler to run (S7: otherwise the proxy answers 520).
 *   A handler identifies the session by `ctx.containerId` — this object's id — never by anything
 *   the sandbox sends.
 *
 * Container time: `onStart` stamps the start in this object's storage, `onStop` hands the elapsed
 * seconds to the subclass's `recordStop`, bounded at {@link ON_STOP_DB_MS}.
 */
import { ContainerProxy, Sandbox } from '@cloudflare/sandbox'
import { sessionAllowedHosts } from '../services/sessions/sandbox-port'

export { ContainerProxy }

/** Where `onStart` stamps the container's start (ms since the epoch). */
const STARTED_AT_KEY = 'launch:container-started-at'

/**
 * The most `onStop`'s write may take. The Containers base class runs a pending `onStop` at the
 * head of the NEXT start (`startAndWaitForPorts` → `syncPendingStoppedEvents`), so a write that
 * hangs would hang that start — the session's `sandbox.start` step — with it.
 */
export const ON_STOP_DB_MS = 10_000

export type SandboxStopParams = Parameters<Sandbox['onStop']>[0]

export abstract class SessionSandboxBase<Env = unknown> extends Sandbox<Env> {
  /** Off by default on the stable packages despite the docs — see the header (S7 finding 1). */
  interceptHttps = true
  enableInternet = false
  allowedHosts = sessionAllowedHosts()

  override async onStart(): Promise<void> {
    await super.onStart()
    await this.ctx.storage.put(STARTED_AT_KEY, Date.now())
  }

  override async onStop(params: SandboxStopParams): Promise<void> {
    await super.onStop(params)
    const startedAt = await this.ctx.storage.get<number>(STARTED_AT_KEY)
    await this.ctx.storage.delete(STARTED_AT_KEY)
    if (!startedAt) return
    await this.recordStop((Date.now() - startedAt) / 1000, params)
  }

  /**
   * Add `seconds` of container time to the session (and settle one the container went away
   * under). Best-effort: it must not throw, and must give up within {@link ON_STOP_DB_MS}.
   */
  protected abstract recordStop(seconds: number, params: SandboxStopParams): Promise<void>
}
