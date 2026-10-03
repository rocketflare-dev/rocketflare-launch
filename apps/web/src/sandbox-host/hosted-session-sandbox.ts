/**
 * `HostedSessionSandbox` — a coding session's container in the SANDBOX HOST Worker
 * (`wrangler.sandbox-host.toml`), the Durable Object a laptop's Launch drives over a remote service
 * binding when `SESSION_SANDBOX_HOST=remote` (development only). Same egress settings as Launch's
 * own `SessionSandbox` (`SessionSandboxBase`: the `SESSION_EGRESS` mode from this Worker's own toml,
 * HTTPS intercepted), and the same rule that the container holds NO credential — with two differences:
 *
 * - **Its outbound handlers work from a GRANT, not the database.** The host cannot reach Launch's
 *   database, so local Launch pushes what the handlers inject — the session's repo, branch and
 *   installation token, the model key and the policy's model — to THIS object before git or a turn
 *   needs it (`setEgressGrant` over the host's RPC, the `host` egress mode,
 *   `services/sessions/egress/host.ts`). It is kept in this object's storage, never in the
 *   container, and cleared on `destroy()` and when the container stops. The handlers
 *   (`sandbox-host/egress.ts`) run the same forwarding cores as Launch's proxies. The registry
 *   `outboundByHost` writes to is keyed by CLASS NAME (`@cloudflare/containers`), so this class
 *   declares its own — it would inherit none from `SessionSandbox`, and must not import it.
 * - **No container-time metering, no per-request budget.** `onStop` has nowhere to write, so
 *   `sessions.container_seconds` stays 0 for a remote session, and a container the platform put to
 *   sleep is not marked `suspended` by it: the next step's boot-marker check finds the empty
 *   container instead. Model calls are metered per turn on Launch's side (`turn-meter.ts`).
 */
import {
  type SandboxStopParams,
  SessionSandboxBase,
} from '../api/durable-objects/session-sandbox-base'
import { OPENAI_EGRESS_HOSTS, refuseHost } from '../api/services/sessions/egress/refuse'
import type { EgressGrant } from '../api/services/sessions/sandbox-host/protocol'
import { type GrantLookup, hostedAnthropic, hostedGitHub } from './egress'
import type { SandboxHostEnv } from './env'

/** Where the grant lives in this object's storage. */
const EGRESS_GRANT_KEY = 'launch:egress-grant'

export class HostedSessionSandbox extends SessionSandboxBase<SandboxHostEnv> {
  /** Store the grant: each half it carries replaces the stored one, the other is kept. */
  async setEgressGrant(grant: EgressGrant): Promise<void> {
    const current = (await this.ctx.storage.get<EgressGrant>(EGRESS_GRANT_KEY)) ?? {}
    const next: EgressGrant = {}
    const git = grant.git ?? current.git
    const model = grant.model ?? current.model
    if (git) next.git = git
    if (model) next.model = model
    await this.ctx.storage.put(EGRESS_GRANT_KEY, next)
  }

  /** What the outbound handlers inject, or null (they refuse). */
  async getEgressGrant(): Promise<EgressGrant | null> {
    return (await this.ctx.storage.get<EgressGrant>(EGRESS_GRANT_KEY)) ?? null
  }

  async clearEgressGrant(): Promise<void> {
    await this.ctx.storage.delete(EGRESS_GRANT_KEY)
  }

  override async destroy(): Promise<void> {
    await this.clearEgressGrant()
    await super.destroy()
  }

  /** The credentials go with the container: a stopped one's handlers refuse until the next grant. */
  override async onStop(params: SandboxStopParams): Promise<void> {
    await this.clearEgressGrant()
    await super.onStop(params)
  }

  protected override async recordStop(): Promise<void> {
    // Nowhere to record it: see the header.
  }
}

/** The grant of the object whose container sent the request — resolved by its own id. */
export function grantLookup(env: SandboxHostEnv): GrantLookup {
  return async containerId => {
    const ns = env.SESSION_SANDBOX
    return ns.get(ns.idFromString(containerId)).getEgressGrant()
  }
}

/** The handlers' `env` is typed as Launch's `Cloudflare.Env`; on the host it is this Worker's. */
const lookupIn = (env: unknown): GrantLookup => grantLookup(env as SandboxHostEnv)

HostedSessionSandbox.outboundByHost = {
  'api.anthropic.com': (req, env, ctx) => hostedAnthropic(req, lookupIn(env), ctx),
  'github.com': (req, env, ctx) => hostedGitHub(req, lookupIn(env), ctx),
  // §18.22-B: Codex never runs here (`supportsHostEgress: false`), but its hosts are on the shared
  // allow-list — refused, so they cannot pass straight through.
  ...Object.fromEntries(OPENAI_EGRESS_HOSTS.map(host => [host, refuseHost(host)])),
}
