/**
 * `HostedSessionSandbox` — a coding session's container in the SANDBOX HOST Worker
 * (`wrangler.sandbox-host.toml`), the Durable Object a laptop's Launch drives over a remote service
 * binding when `SESSION_SANDBOX_HOST=remote` (development only). Same egress settings as Launch's
 * own `SessionSandbox` (`SessionSandboxBase`: internet off, the base allow-list, HTTPS intercepted),
 * and two deliberate differences:
 *
 * - **No outbound handlers.** The host cannot reach Launch's database, so it cannot run the model
 *   and git proxies. `api.anthropic.com` and `github.com` are on the allow-list and pass straight
 *   through; the container authenticates with the key and the token Launch hands it (the `direct`
 *   egress mode, `services/sessions/egress/direct.ts` — its trade-offs are there).
 * - **No container-time metering.** `onStop` has nowhere to write, so `sessions.container_seconds`
 *   stays 0 for a remote session, and a container the platform put to sleep is not marked
 *   `suspended` by it: the next step's boot-marker check finds the empty container instead.
 */
import { SessionSandboxBase } from '../api/durable-objects/session-sandbox-base'
import type { SandboxHostEnv } from './env'

export class HostedSessionSandbox extends SessionSandboxBase<SandboxHostEnv> {
  protected override async recordStop(): Promise<void> {
    // Nowhere to record it: see the header.
  }
}
