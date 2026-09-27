/**
 * Every name an app's resources carry (plan §1 "Naming"), computed in ONE place so the pipeline,
 * the scaffold check, the deploy gateway and teardown can never disagree about what `acme`'s
 * staging queue is called. The kit's rename produces the same names in the tomls — `<slug>` for
 * `rocketflare`, `-staging` kept — and `scaffoldProblems` (adapter.ts) checks that it did.
 *
 * | Resource  | Name                               |
 * |-----------|------------------------------------|
 * | Worker    | `<slug>[-staging]`                 |
 * | KV title  | `<slug>-rate-limit[-staging]`      |
 * | Queue     | `<slug>-jobs[-staging]`            |
 * | R2 bucket | `<slug>-files[-staging]`           |
 * | Workflow  | `<slug>-agent-run[-staging]`       |
 * | Resend key| `<slug>[-staging]`                 |
 * | Host      | `<slug>[-staging].<apps_domain>`   |
 *
 * Account-scoped names differ per environment (the kit's parity rule): the last deployer of a
 * shared Workflow or queue name owns it and runs the other environment's work under its bindings.
 */
import type { AppEnvironmentName } from '@launch/shared/launch-apps'

/** The kit's own bindings (kit 0.15 `apps/web/wrangler.toml`), by what they are for. */
export const KIT_BINDINGS = {
  rateLimitKv: 'RATE_LIMIT_KV',
  jobsQueue: 'JOBS_QUEUE',
  files: 'FILES',
  notificationsHub: 'NOTIFICATIONS_HUB',
  agentRunWorkflow: 'AGENT_RUN_WORKFLOW',
} as const

export interface AppResourceNames {
  /** The Worker script name (the toml's `name`). */
  workerName: string
  /** The KV namespace TITLE Launch creates it under (the toml references it by id only). */
  kvTitle: string
  /** `JOBS_QUEUE`'s queue (producer and consumer). */
  queue: string
  /** `FILES`' bucket. */
  r2Bucket: string
  /** `AGENT_RUN_WORKFLOW`'s account-scoped Workflow name. */
  workflow: string
  /** The Resend sending key's name. */
  resendKeyName: string
  /** The public host Launch routes to the Worker. */
  host: string
  /** `https://<host>` — the toml's `APP_URL`. */
  url: string
}

/** `''` for production, `-staging` for staging: the suffix every account-scoped name takes. */
export function environmentSuffix(env: AppEnvironmentName): string {
  return env === 'staging' ? '-staging' : ''
}

/** The account-scoped names alone — what the scaffolded tomls must carry, no domain needed. */
export function accountScopedNames(
  slug: string,
  env: AppEnvironmentName
): Omit<AppResourceNames, 'host' | 'url'> {
  const s = environmentSuffix(env)
  return {
    workerName: `${slug}${s}`,
    kvTitle: `${slug}-rate-limit${s}`,
    queue: `${slug}-jobs${s}`,
    r2Bucket: `${slug}-files${s}`,
    workflow: `${slug}-agent-run${s}`,
    resendKeyName: `${slug}${s}`,
  }
}

/** The names of one environment of app `slug` on `appsDomain` (e.g. `clewro.com`). */
export function appResourceNames(
  slug: string,
  env: AppEnvironmentName,
  appsDomain: string
): AppResourceNames {
  const host = `${slug}${environmentSuffix(env)}.${appsDomain.replace(/^\.+|\.+$/g, '').toLowerCase()}`
  return { ...accountScopedNames(slug, env), host, url: `https://${host}` }
}
