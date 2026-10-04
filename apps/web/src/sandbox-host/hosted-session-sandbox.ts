/**
 * `HostedSessionSandbox` — a coding session's (or a sign-in's) container in the SANDBOX HOST Worker
 * (`wrangler.sandbox-host.toml`), the Durable Object a laptop's Launch drives over a remote service
 * binding for a session on the `remote` sandbox host (development only). Same egress settings as
 * Launch's own `SessionSandbox` (`SessionSandboxBase`: the `SESSION_EGRESS` mode from this Worker's
 * own toml, HTTPS intercepted), the same hosts handled, and the same rule that the container holds
 * no Launch credential — with two differences:
 *
 * - **Its outbound handlers work from a GRANT, not the database.** The host cannot reach Launch's
 *   database, so local Launch pushes what the handlers inject — the session's repo, branch and
 *   installation token; the turn's model credential (Anthropic key or subscription token, OpenAI
 *   key, or a ChatGPT plan's token refresh) and the policy's model; a login sandbox's runtime — to
 *   THIS object before git, a turn or a sign-in needs it (`setEgressGrant` over the host's RPC, the `host` egress mode,
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
import {
  type EgressGrant,
  type EgressGrantUpdate,
  mergeEgressGrant,
} from '../api/services/sessions/sandbox-host/protocol'
import {
  type GrantLookup,
  hostedAnthropic,
  hostedClaudeSignIn,
  hostedGitHub,
  hostedOpenAi,
  hostedOpenAiAuth,
} from './egress'
import type { SandboxHostEnv } from './env'

/** Where the grant lives in this object's storage. */
const EGRESS_GRANT_KEY = 'launch:egress-grant'

export class HostedSessionSandbox extends SessionSandboxBase<SandboxHostEnv> {
  /** Store the grant: each part it carries replaces the stored one, `null` removes it, the rest is kept. */
  async setEgressGrant(grant: EgressGrantUpdate): Promise<void> {
    const current = (await this.ctx.storage.get<EgressGrant>(EGRESS_GRANT_KEY)) ?? {}
    await this.ctx.storage.put(EGRESS_GRANT_KEY, mergeEgressGrant(current, grant))
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

/**
 * The same hosts as Launch's `SESSION_OUTBOUND_HANDLERS` (`egress/registry.ts`) — the parity test
 * (`session-egress-forward.test.ts`) keeps the two key sets equal — each answered from the grant.
 * `chatgpt.com` is deliberately absent from both: ChatGPT blocks requests from the Workers runtime,
 * so a ChatGPT plan's container reaches it directly (`DIRECT_CODEX_HOSTS`).
 */
HostedSessionSandbox.outboundByHost = {
  'api.anthropic.com': (req, env, ctx) => hostedAnthropic(req, lookupIn(env), ctx),
  'platform.claude.com': (req, env, ctx) => hostedClaudeSignIn(req, lookupIn(env), ctx),
  'github.com': (req, env, ctx) => hostedGitHub(req, lookupIn(env), ctx),
  'api.openai.com': (req, env, ctx) => hostedOpenAi(req, lookupIn(env), ctx),
  'auth.openai.com': (req, env, ctx) => hostedOpenAiAuth(req, lookupIn(env), ctx),
}
