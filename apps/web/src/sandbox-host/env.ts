/**
 * The sandbox host Worker's bindings (`wrangler.sandbox-host.toml`). Written by hand, unlike
 * Launch's `Cloudflare.Env` (generated from `wrangler.toml` by `wrangler types`): this is a second
 * Worker with one binding, and a second generated declaration file would declare a second global
 * `Cloudflare.Env`. `tests/config/sandbox-host.test.ts` checks the toml declares exactly this.
 */
import type { HostedSessionSandbox } from './hosted-session-sandbox'

export interface SandboxHostEnv {
  SESSION_SANDBOX: DurableObjectNamespace<HostedSessionSandbox>
  /** `open | allowlist`, missing = `allowlist` — read by `sessionEgressMode` (`SESSION_EGRESS`). */
  SESSION_EGRESS?: string
}
