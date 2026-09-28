/**
 * `SessionSandbox` (Launch P3, plan §1.2) — the coding session's container, and its Durable Object:
 * it IS the Sandbox SDK's class (`@cloudflare/sandbox` 0.12.10, stable, with the matching
 * `cloudflare/sandbox:0.12.10` base image), reached with `getSandbox(env.SESSION_SANDBOX, name)`
 * where `name` is the session id. Bound in BOTH tomls as `[[containers]]` + the `SESSION_SANDBOX`
 * Durable Object + `[[migrations]] v2` (`new_sqlite_classes`, as the SDK requires). Exported from
 * `src/worker.ts`, never from `api/index.ts`, together with the SDK's `ContainerProxy` — the
 * WorkerEntrypoint the platform routes a container's outbound traffic through, which is what lets
 * `outboundByHost` run IN THIS WORKER.
 *
 * Egress (plan §1.4, §1.5, S7):
 *
 * - `enableInternet = false` and an allow-list: `SESSION_BASE_ALLOWED_HOSTS` — the same on a
 *   laptop. The session adapter re-applies it with `setAllowedHosts` at start
 *   (`sessionAllowedHosts`), and the prepare and bootstrap steps widen it by EXACTLY the hosts of
 *   the Neon endpoint the container's database lives on (`sessionDbEgressHosts`: the endpoint for
 *   the driver's WebSocket, its region's `api.` host for its HTTP queries) — never a wildcard.
 * - **`interceptHttps = true`, set explicitly.** It defaults to `false` on the stable packages
 *   (containers 0.3.7 / sandbox 0.12.10) despite the docs, and without it no HTTPS leaves a locked
 *   sandbox, allow-listed or not (S7 finding 1).
 * - `outboundByHost` hands `api.anthropic.com` to the model proxy (`egress/anthropic.ts`, slice 3c)
 *   and `github.com` to the git proxy (`egress/github.ts`, slice 3d). A host must ALSO be on the
 *   allow-list for its handler to run at all (S7: otherwise the proxy answers 520). The handlers
 *   identify the session by `ctx.containerId` — this object's id — never by anything the sandbox
 *   sends.
 * - **`wrangler dev` honours all of it** (checked in slice 3b against 0.12.10 / wrangler 4.127: a
 *   handler runs for HTTP and HTTPS, `ctx.containerId` is `idFromName(name).toString()`, a host off
 *   the list answers 520, `setAllowedHosts` applies at runtime; an outbound `wss://` to an
 *   allow-listed host with no handler passes through the interception). One local difference:
 *   `host.docker.internal` is reachable from a local container even when it is NOT on the list.
 *   Nothing in a session uses it.
 *
 * Container time (`sessions.container_seconds`): `onStart` stamps the start in this object's
 * storage, `onStop` adds the elapsed seconds to the session (`recordContainerStop`) — and, when the
 * container went away under a session that still thinks it is live (the SDK's idle sleep, a
 * rollout), marks it `suspended` so the next wake boots again.
 */
import { ContainerProxy, Sandbox } from '@cloudflare/sandbox'
import { type AppConfig, loadConfig } from '../../config'
import { openDatabase } from '../../db/client'
import { withDeadline } from '../services/sessions/deadline'
import { handleAnthropic } from '../services/sessions/egress/anthropic'
import { handleGitHub } from '../services/sessions/egress/github'
import { recordContainerStop } from '../services/sessions/lifecycle'
import { sessionAllowedHosts } from '../services/sessions/ports'
import type { AppBindings } from '../types'
import { loggerFor } from '../utils/core/logger'

export { ContainerProxy }

/** Where `onStart` stamps the container's start (ms since the epoch). */
const STARTED_AT_KEY = 'launch:container-started-at'

/**
 * The most `onStop`'s database write may take. The Containers base class runs a pending `onStop`
 * at the head of the NEXT start (`startAndWaitForPorts` → `syncPendingStoppedEvents`), so a write
 * that hangs would hang that start — the session's `sandbox.start` step — with it.
 */
export const ON_STOP_DB_MS = 10_000

export class SessionSandbox extends Sandbox<AppBindings> {
  /** Off by default on the stable packages despite the docs — see the header (S7 finding 1). */
  interceptHttps = true
  enableInternet = false
  allowedHosts = sessionAllowedHosts()

  override async onStart(): Promise<void> {
    await super.onStart()
    await this.ctx.storage.put(STARTED_AT_KEY, Date.now())
  }

  override async onStop(params: Parameters<Sandbox<AppBindings>['onStop']>[0]): Promise<void> {
    await super.onStop(params)
    const startedAt = await this.ctx.storage.get<number>(STARTED_AT_KEY)
    await this.ctx.storage.delete(STARTED_AT_KEY)
    if (!startedAt) return
    let cfg: AppConfig
    try {
      cfg = loadConfig(this.env)
    } catch {
      return
    }
    const handle = openDatabase({ ...cfg, HYPERDRIVE: this.env.HYPERDRIVE })
    try {
      await withDeadline('session-sandbox: recording the container stop', ON_STOP_DB_MS, () =>
        recordContainerStop(handle.db, this.ctx.id.toString(), (Date.now() - startedAt) / 1000)
      )
    } catch (err) {
      // Metering is best-effort: a lost stop costs a few seconds of accounting, never the session.
      loggerFor(cfg, { durableObject: 'session-sandbox' }).warn(
        { err, exitCode: params?.exitCode, reason: params?.reason },
        'session-sandbox: could not record container time'
      )
    } finally {
      await withDeadline('session-sandbox: closing the database', ON_STOP_DB_MS, () =>
        handle.close()
      ).catch(() => {})
    }
  }
}

SessionSandbox.outboundByHost = {
  'api.anthropic.com': (req, env, ctx) => handleAnthropic(req, env as AppBindings, ctx),
  'github.com': (req, env, ctx) => handleGitHub(req, env as AppBindings, ctx),
}
