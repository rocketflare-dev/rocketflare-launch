/**
 * The coding session container's Durable Object, WITHOUT where it runs: the egress settings and
 * the container-time stamp that every session sandbox shares. Two classes extend it:
 *
 * - `SessionSandbox` (`session-sandbox.ts`) — in Launch's own Worker, deployed and under
 *   `wrangler dev`. Its outbound handlers ARE the egress handlers, and its container time goes
 *   straight to Launch's database.
 * - `HostedSessionSandbox` (`src/sandbox-host/hosted-session-sandbox.ts`) — in the sandbox host
 *   Worker a laptop reaches over a remote service binding (a session on the remote sandbox host). Its
 *   outbound handlers run the same forwarding cores over an EGRESS GRANT Launch pushes to it (the
 *   host cannot reach Launch's database — the `host` egress mode), and it records no container
 *   time.
 *
 * One of the TWO files that import the Sandbox SDK (the other is `sandbox/cloudflare-sandbox.ts`).
 * It imports nothing of Launch's database or config, so the host Worker bundles without them.
 *
 * Egress (plan §1.4, §1.5, S7) — the same in both, in one of two modes (`SESSION_EGRESS`, read
 * with `sessionEgressMode(env)`; missing = `allowlist`):
 *
 * - **`allowlist`** (spec/03): `enableInternet = false` and an allow-list,
 *   `SESSION_BASE_ALLOWED_HOSTS`. The session adapter re-applies it with `setAllowedHosts` at start
 *   (`sessionAllowedHosts`), and the prepare and bootstrap steps widen it by EXACTLY the hosts of
 *   the Neon endpoint the container's database lives on (`sessionDbEgressHosts`) — never a
 *   wildcard. Any allow-list makes `@cloudflare/containers` intercept EVERY outbound connection.
 * - **`open`** (the tomls, for now): `enableInternet = true`, no allow-list, and
 *   `setAllowedHosts` a no-op, so none of its callers can turn the allow-list back on. Only the
 *   `outboundByHost` hosts are intercepted; everything else, the database included, goes direct.
 *   The reason: on real containers the interception never ends a container's stream after a
 *   WebSocket closes, so the kit's migrate / db-roles / seed never exit
 *   (docs/plans/sandbox-websocket-close.md). The constructor also deletes the SDK's persisted
 *   outbound configuration BEFORE `super()` — the base class restores it there, and an object
 *   reused across boots (`prepare-<appId>`) would otherwise bring back its allow-list and
 *   intercept-all. A container ALREADY running keeps the interception it was started with until
 *   it restarts: the runtime cannot remove one.
 *
 *   The SDK reads these fields in a `blockConcurrencyWhile` after its first `await`
 *   (`@cloudflare/containers` 0.3.7) and at `start`, so setting them after `super()` is in time.
 *
 * In both:
 *
 * - **`interceptHttps = true`, set explicitly.** It defaults to `false` on the stable packages
 *   (containers 0.3.7 / sandbox 0.12.10) despite the docs, and without it no HTTPS leaves a locked
 *   sandbox, allow-listed or not (S7 finding 1); under `open` the two handlers below need it.
 * - EACH subclass sets its own `outboundByHost` for `api.anthropic.com` and `github.com`: the
 *   registry is keyed by CLASS NAME (`@cloudflare/containers`), so nothing is inherited. Under
 *   `allowlist` a host must ALSO be on the allow-list for its handler to run (S7: otherwise the
 *   proxy answers 520). A handler identifies the sandbox by `ctx.containerId` — this object's id,
 *   `this.ctx.id.toString()` — never by anything the sandbox sends. Either way the container holds
 *   no credential.
 *
 * Container time: `onStart` stamps the start in this object's storage, `onStop` hands the elapsed
 * seconds to the subclass's `recordStop`, bounded at {@link ON_STOP_DB_MS}.
 */
import { ContainerProxy, Sandbox } from '@cloudflare/sandbox'
import {
  type SessionEgressMode,
  sessionAllowedHosts,
  sessionEgressMode,
} from '../services/sessions/sandbox-port'

export { ContainerProxy }

/** Where `onStart` stamps the container's start (ms since the epoch). */
const STARTED_AT_KEY = 'launch:container-started-at'

/**
 * Where `@cloudflare/containers` 0.3.7 persists the outbound configuration (its allow-list, and
 * whether the container was promoted to intercept-all) and restores it from in its constructor.
 */
export const SDK_OUTBOUND_CONFIGURATION_KEY = 'OUTBOUND_CONFIGURATION'

/**
 * The most `onStop`'s write may take. The Containers base class runs a pending `onStop` at the
 * head of the NEXT start (`startAndWaitForPorts` → `syncPendingStoppedEvents`), so a write that
 * hangs would hang that start — the session's `sandbox.start` step — with it.
 */
export const ON_STOP_DB_MS = 10_000

export type SandboxStopParams = Parameters<Sandbox['onStop']>[0]

/** The Durable Object state the SDK's constructor takes. */
type SandboxState = ConstructorParameters<typeof Sandbox>[0]

export abstract class SessionSandboxBase<Env = unknown> extends Sandbox<Env> {
  /** Off by default on the stable packages despite the docs — see the header (S7 finding 1). */
  interceptHttps = true
  enableInternet = false
  allowedHosts: string[] | undefined = sessionAllowedHosts()
  /** `SESSION_EGRESS` for this object's Worker — see the header. */
  readonly egressMode: SessionEgressMode

  constructor(ctx: SandboxState, env: Env) {
    const open = sessionEgressMode(env) === 'open'
    // Before `super()`, which restores it: see the header.
    if (open) ctx.storage.kv.delete(SDK_OUTBOUND_CONFIGURATION_KEY)
    super(ctx, env)
    this.egressMode = open ? 'open' : 'allowlist'
    if (open) {
      this.enableInternet = true
      this.allowedHosts = undefined
    }
  }

  /** Under `open`, a no-op: an allow-list would bring back intercept-all (see the header). */
  override async setAllowedHosts(hosts: string[]): Promise<void> {
    if (this.egressMode === 'open') return
    await super.setAllowedHosts(hosts)
  }

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
