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
 * - `enableInternet = false` and an allow-list (`SESSION_BASE_ALLOWED_HOSTS`, plus
 *   `host.docker.internal` when local — `setAllowedHosts` at start).
 * - **`interceptHttps = true`, set explicitly.** It defaults to `false` on the stable packages
 *   (containers 0.3.7 / sandbox 0.12.10) despite the docs, and without it no HTTPS leaves a locked
 *   sandbox, allow-listed or not (S7 finding 1).
 * - `outboundByHost` hands `api.anthropic.com` to the model proxy (`egress/anthropic.ts`, slice 3c)
 *   and `github.com` to the git proxy (`egress/github.ts`, slice 3d). A host must ALSO be on the
 *   allow-list for its handler to run at all (S7: otherwise the proxy answers 520). The handlers
 *   identify the session by `ctx.containerId` — this object's id — never by anything the sandbox
 *   sends.
 *
 * **Slice 3b owns this file** (the allow-list at start, `onStart` / `onStop` adding to
 * `sessions.container_seconds`). From 3a it carries the egress settings and the two handlers, so
 * 3c and 3d only ever edit their own egress module.
 */
import { ContainerProxy, Sandbox } from '@cloudflare/sandbox'
import { handleAnthropic } from '../services/sessions/egress/anthropic'
import { handleGitHub } from '../services/sessions/egress/github'
import { SESSION_BASE_ALLOWED_HOSTS } from '../services/sessions/ports'
import type { AppBindings } from '../types'

export { ContainerProxy }

export class SessionSandbox extends Sandbox<AppBindings> {
  /** Off by default on the stable packages despite the docs — see the header (S7 finding 1). */
  interceptHttps = true
  enableInternet = false
  allowedHosts = [...SESSION_BASE_ALLOWED_HOSTS]
}

SessionSandbox.outboundByHost = {
  'api.anthropic.com': (req, env, ctx) => handleAnthropic(req, env as AppBindings, ctx),
  'github.com': (req, env, ctx) => handleGitHub(req, env as AppBindings, ctx),
}
