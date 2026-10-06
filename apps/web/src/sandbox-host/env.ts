/**
 * The sandbox host Worker's bindings, vars and secrets (`wrangler.sandbox-host.toml`). Written by
 * hand, unlike Launch's `Cloudflare.Env` (generated from `wrangler.toml` by `wrangler types`): this
 * is a second Worker, and a second generated declaration file would declare a second global
 * `Cloudflare.Env`. `tests/config/sandbox-host.test.ts` checks the toml declares exactly this.
 *
 * The backup settings are read twice: by `sandboxHostConfig` (`worker.ts`, the mode and the R2
 * endpoint) and by the Sandbox SDK itself, inside `HostedSessionSandbox`, from the same env — it
 * signs the presigned URLs with `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` for `BACKUP_BUCKET_NAME`
 * at the account's R2 endpoint, and checks the upload through `BACKUP_BUCKET`.
 */
import type { HostedSessionSandbox } from './hosted-session-sandbox'

export interface SandboxHostEnv {
  SESSION_SANDBOX: DurableObjectNamespace<HostedSessionSandbox>
  /** `open | allowlist`, missing = `allowlist` — read by `sessionEgressMode` (`SESSION_EGRESS`). */
  SESSION_EGRESS?: string
  /**
   * Workspace backups on this host: `off` (missing) or `presigned`. `binding` is refused
   * (`sandboxHostConfig`): it moves the whole archive through this Durable Object's 128 MB.
   */
  SESSION_WORKSPACE_BACKUP?: string
  /** The SDK's fixed binding name: the bucket the archives go to (objects under `backups/`). */
  BACKUP_BUCKET?: R2Bucket
  /** That bucket's name, for the presigned URLs (the SDK reads it). */
  BACKUP_BUCKET_NAME?: string
  /** The account whose R2 endpoint the URLs are signed for… */
  CLOUDFLARE_ACCOUNT_ID?: string
  CLOUDFLARE_R2_ACCOUNT_ID?: string
  /** …or the endpoint itself (a jurisdiction: `https://<account>.eu.r2.cloudflarestorage.com`). */
  BACKUP_BUCKET_ENDPOINT?: string
  /** Secrets (`wrangler secret put … -c wrangler.sandbox-host.toml`): an R2 Object Read & Write token. */
  R2_ACCESS_KEY_ID?: string
  R2_SECRET_ACCESS_KEY?: string
}
