/**
 * Every name an app's resources carry (plan §1 "Naming", D36 `worker.naming`), computed in ONE
 * place so the pipeline, the scaffold check, the deploy gateway and teardown can never disagree
 * about what `acme`'s staging queue is called.
 *
 * **Launch's own names** do not depend on the kit:
 *
 * | Resource   | Name                             |
 * |------------|----------------------------------|
 * | Host       | `<slug>[-staging].<apps_domain>` |
 * | Resend key | `<slug>[-staging]`               |
 *
 * **The kit's names follow its naming rule** (`worker.naming`, `kitResourceName`): the Worker is
 * `<slug>` plus the staging suffix, every other account-scoped name is `<slug>-<suffix>` plus the
 * staging suffix — the kit's init writes them into the tomls, and Launch reads them back from there
 * (a queue, a bucket, a Workflow) rather than knowing what a kit binds. A KV namespace has no name
 * in the toml, only an id, so its TITLE is computed: `<slug>-<kvTitleSuffix(binding)>[-staging]`.
 * {@link namingProblems} checks a scaffolded toml against the rule.
 *
 * Account-scoped names differ per environment (the kit's parity rule): the last deployer of a
 * shared Workflow or queue name owns it and runs the other environment's work under its bindings.
 *
 * {@link appResourceNames} / {@link accountScopedNames} spell out the Rocketflare fallback's full
 * table (its `jobs` queue, `files` bucket and `agent-run` Workflow) for its tests and docs; Launch's
 * code reads {@link appNames} and the toml.
 */
import { type KitManifest, kitResourceName, kvTitleSuffix } from '@launch/shared/kit-manifest'
import type { AppEnvironmentName } from '@launch/shared/launch-apps'
import { rocketflareFallbackManifest } from './rocketflare-fallback'
import type { TomlResources } from './toml'

type Naming = Pick<KitManifest, 'worker'>

const FALLBACK: Naming = rocketflareFallbackManifest()

/** `''` for production, the kit's staging suffix (`-staging`) for staging. */
export function environmentSuffix(env: AppEnvironmentName, manifest: Naming = FALLBACK): string {
  return env === 'staging' ? manifest.worker.naming.stagingSuffix : ''
}

/** The Worker script name (the toml's `name`): `<slug>` plus the staging suffix. */
export function workerNameOf(slug: string, env: AppEnvironmentName, manifest: Naming = FALLBACK) {
  return `${slug}${environmentSuffix(env, manifest)}`
}

/** The title Launch creates a KV namespace under, for the toml's `binding`. */
export function kvTitleOf(
  slug: string,
  binding: string,
  env: AppEnvironmentName,
  manifest: Naming = FALLBACK
): string {
  return kitResourceName(manifest, slug, kvTitleSuffix(manifest, binding), env)
}

/** Launch's public host for an environment — Launch's routing, not the kit's naming. */
export function appHost(slug: string, env: AppEnvironmentName, appsDomain: string): string {
  const domain = appsDomain.replace(/^\.+|\.+$/g, '').toLowerCase()
  return `${slug}${env === 'staging' ? '-staging' : ''}.${domain}`
}

/** What the pipeline names for one environment, whatever the kit. */
export interface AppNames {
  /** The Worker script name (the toml's `name`). */
  workerName: string
  /** The Resend sending key's name. */
  resendKeyName: string
  /** The public host Launch routes to the Worker. */
  host: string
  /** `https://<host>` — the toml's app-URL var. */
  url: string
}

/** The names of one environment of app `slug` on `appsDomain` (e.g. `clewro.com`). */
export function appNames(
  slug: string,
  env: AppEnvironmentName,
  appsDomain: string,
  manifest: Naming = FALLBACK
): AppNames {
  const host = appHost(slug, env, appsDomain)
  return {
    workerName: workerNameOf(slug, env, manifest),
    resendKeyName: `${slug}${env === 'staging' ? '-staging' : ''}`,
    host,
    url: `https://${host}`,
  }
}

/**
 * Why a toml's names are not app `slug`'s, by the kit's naming rule — one sentence per problem:
 * the Worker's `name` must be {@link workerNameOf}; every account-scoped name (queue producers and
 * consumers, R2 buckets, Workflows) must be `<slug>-…` with the staging suffix in staging. A name
 * that follows the rule for ANOTHER slug — the toml's own, e.g. a rename that did not run — is
 * reported with the name it should have been; anything else as not one of the app's names.
 */
export function namingProblems(
  file: string,
  env: AppEnvironmentName,
  declared: Pick<TomlResources, 'workerName' | 'queues' | 'queueConsumers' | 'r2' | 'workflows'>,
  slug: string,
  manifest: Naming = FALLBACK
): string[] {
  const problems: string[] = []
  const suffix = environmentSuffix(env, manifest)
  const workerName = workerNameOf(slug, env, manifest)
  if (declared.workerName !== workerName) {
    problems.push(`${file}: name is ${declared.workerName ?? '(missing)'}, not ${workerName}`)
  }
  // The slug the toml itself was written for: its Worker name less the staging suffix.
  const own =
    declared.workerName && (!suffix || declared.workerName.endsWith(suffix))
      ? declared.workerName.slice(0, declared.workerName.length - suffix.length)
      : null
  const follows = (name: string, s: string) =>
    name.startsWith(`${s}-`) && name.length > s.length + 1 + suffix.length && name.endsWith(suffix)
  const scoped: Array<{ binding: string | null; name: string }> = [
    ...declared.queues.map(q => ({ binding: q.binding, name: q.queue })),
    ...declared.queueConsumers.map(q => ({ binding: null, name: q.queue })),
    ...declared.r2.map(r => ({ binding: r.binding, name: r.bucketName })),
    ...declared.workflows.map(w => ({ binding: w.binding, name: w.name })),
  ]
  for (const { binding, name } of scoped) {
    if (follows(name, slug)) continue
    if (binding && own && own !== slug && follows(name, own)) {
      const rest = name.slice(own.length + 1, name.length - suffix.length)
      problems.push(`${file}: ${binding} is ${name}, not ${slug}-${rest}${suffix}`)
    } else {
      problems.push(`${file}: ${name} is not one of ${workerName}'s names`)
    }
  }
  return problems
}

// ---- the Rocketflare fallback's full table (its tests and docs) -----------------------------------

/** Every name of one Rocketflare environment, as plan §1's table lists them. */
export interface AppResourceNames extends AppNames {
  /** `RATE_LIMIT_KV`'s title. */
  kvTitle: string
  /** `JOBS_QUEUE`'s queue (producer and consumer). */
  queue: string
  /** `FILES`' bucket. */
  r2Bucket: string
  /** `AGENT_RUN_WORKFLOW`'s account-scoped Workflow name. */
  workflow: string
}

/** The account-scoped names alone of a Rocketflare environment — no domain needed. */
export function accountScopedNames(
  slug: string,
  env: AppEnvironmentName
): Omit<AppResourceNames, 'host' | 'url'> {
  return {
    workerName: workerNameOf(slug, env, FALLBACK),
    kvTitle: kvTitleOf(slug, 'RATE_LIMIT_KV', env, FALLBACK),
    queue: kitResourceName(FALLBACK, slug, 'jobs', env),
    r2Bucket: kitResourceName(FALLBACK, slug, 'files', env),
    workflow: kitResourceName(FALLBACK, slug, 'agent-run', env),
    resendKeyName: appNames(slug, env, 'x', FALLBACK).resendKeyName,
  }
}

/** The full names of one Rocketflare environment of app `slug` on `appsDomain`. */
export function appResourceNames(
  slug: string,
  env: AppEnvironmentName,
  appsDomain: string
): AppResourceNames {
  const { host, url } = appNames(slug, env, appsDomain, FALLBACK)
  return { ...accountScopedNames(slug, env), host, url }
}
