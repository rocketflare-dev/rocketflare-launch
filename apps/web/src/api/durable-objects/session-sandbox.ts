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
 * The egress settings and the container-time stamp live in `SessionSandboxBase`
 * (`session-sandbox-base.ts`), shared with the sandbox host Worker's `HostedSessionSandbox`; this
 * class adds what only Launch's own Worker can do — the handlers and the database write.
 *
 * Egress (plan §1.4, §1.5, S7) — the mode (`SESSION_EGRESS`: `allowlist`, or `open` for now) and
 * everything it switches live in `SessionSandboxBase`; see its header. Under `allowlist`:
 *
 * - `enableInternet = false` and an allow-list: `SESSION_BASE_ALLOWED_HOSTS` — the same on a
 *   laptop. The session adapter re-applies it with `setAllowedHosts` at start
 *   (`sessionAllowedHosts`), and the prepare and bootstrap steps widen it by EXACTLY the hosts of
 *   the Neon endpoint the container's database lives on (`sessionDbEgressHosts`: the endpoint for
 *   the driver's WebSocket, its region's `api.` host for its HTTP queries) — never a wildcard.
 *   Under `open` the internet is on and the database goes direct.
 * - **`interceptHttps = true`, set explicitly.** It defaults to `false` on the stable packages
 *   (containers 0.3.7 / sandbox 0.12.10) despite the docs, and without it no HTTPS leaves a locked
 *   sandbox, allow-listed or not (S7 finding 1).
 * - `outboundByHost` is `SESSION_OUTBOUND_HANDLERS` (`egress/registry.ts`, §18.22): it hands
 *   `api.anthropic.com` to the model proxy (`egress/anthropic.ts`, slice 3c) and `github.com` to the
 *   git proxy (`egress/github.ts`, slice 3d) — in both modes — plus a Claude sign-in's
 *   `platform.claude.com` (§18.22-A) and Codex's three OpenAI hosts (§18.22-B). A login sandbox (`login-<id>`, `AgentLoginWorkflow`) is this class too. Under
 *   `allowlist` a host must ALSO be on the allow-list for its handler to run at all (S7: otherwise
 *   the proxy answers 520). The database has no handler: see `egress/forward-database.ts`. The handlers
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
import { type AppConfig, loadConfig } from '../../config'
import { openDatabase } from '../../db/client'
import { withDeadline } from '../services/sessions/deadline'
import { SESSION_OUTBOUND_HANDLERS } from '../services/sessions/egress/registry'
import { recordContainerStop } from '../services/sessions/lifecycle'
import type { AppBindings } from '../types'
import { loggerFor } from '../utils/core/logger'
import { ON_STOP_DB_MS, type SandboxStopParams, SessionSandboxBase } from './session-sandbox-base'

export { ContainerProxy, ON_STOP_DB_MS } from './session-sandbox-base'

export class SessionSandbox extends SessionSandboxBase<AppBindings> {
  protected override async recordStop(seconds: number, params: SandboxStopParams): Promise<void> {
    let cfg: AppConfig
    try {
      cfg = loadConfig(this.env)
    } catch {
      return
    }
    const handle = openDatabase({ ...cfg, HYPERDRIVE: this.env.HYPERDRIVE })
    try {
      await withDeadline('session-sandbox: recording the container stop', ON_STOP_DB_MS, () =>
        recordContainerStop(handle.db, this.ctx.id.toString(), seconds)
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

// Every host Launch handles a container's traffic for, from ONE table (§18.22,
// `egress/registry.ts`): the model proxy and the git proxy.
SessionSandbox.outboundByHost = SESSION_OUTBOUND_HANDLERS
