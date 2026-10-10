/**
 * The `TemplateAdapter` (spec/02, D36 K2): everything Launch knows about the KIND of app it drives —
 * names, config, secrets, release, health, sign-in, CI, database, declared config, upgrades —
 * behind one object BUILT FROM THE APP'S KIT MANIFEST (`launch.kit.json`, `@launch/shared/
 * kit-manifest`), so no pipeline step, release, health probe or upgrade reaches into a particular
 * kit. Rocketflare is kit #1: its releases that carry no manifest resolve to the built-in fallback
 * (`rocketflare-fallback.ts`), and {@link rocketflareAdapter} is that fallback's adapter.
 *
 * | Need | Manifest block | Where |
 * |------|----------------|-------|
 * | the app manifest and the tomls | `scaffold.appManifest`, `worker.tomls` | `paths`, `app-manifest.ts` |
 * | every resource name, the naming check | `worker.naming`, `worker.titles` | `names.ts` |
 * | what the tomls declare / writing the answers back | `launchProvides` | `toml.ts` |
 * | the Worker secrets | `launchProvides` (`databaseUrl`, `oidc.clientSecret`, `bootstrapAdmins`, `emailApiKey`, `generated`) | `secrets`, `secretTargets` |
 * | release, health, sign-in, the required check | `release`, `health`, `launchProvides.oidc`, `ci` | below |
 * | the database roles and extensions | `database` | `pipeline/provision-neon.ts` |
 * | the config an app declares (P5) | `declaredConfig` | `declared-config.ts` |
 * | a kit upgrade session's messages (P6 6c) | `upgrade` (none: never upgraded) | `upgrade-prompt.ts` |
 * | the placeholder script | — (Launch's own) | `placeholder/worker.ts` |
 * | the scaffold job's files | — (K3 makes it generic) | `rocketflare/scaffold-job.ts` |
 *
 * **Resolution, per app** ({@link adapterFor}): the manifest snapshot ON THE APP
 * (`apps.kit_manifest`, written when it is created or imported and refreshed when a Release records
 * a kit upgrade), else its kit's snapshot (`kits.manifest`, the last check at the kit's pin), else
 * the Rocketflare fallback. Nothing here reads GitHub, so a Workflow step resolves the same adapter
 * on every retry, and an app keeps the manifest of the kit release it is on while the kit's pin
 * moves on (CONCEPTS §18.24).
 */
import {
  type GeneratedSecretKind,
  type KitManifest,
  kitManifestSchema,
} from '@launch/shared/kit-manifest'
import type { AppEnvironmentName } from '@launch/shared/launch-apps'
import { and, eq } from 'drizzle-orm'
import type { Database } from '../../../../db/client'
import { type AppRow, apps } from '../../../../db/schema'
import type { CommitFile } from '../github-app'
import { placeholderScript } from '../placeholder/worker'
import { SCAFFOLD_WORKFLOW_FILE, scaffoldFiles } from '../rocketflare/scaffold-job'
import {
  type AppManifestIdentity,
  ManifestError,
  parseAppManifest,
  parseWranglerToml,
  type WranglerEnvironment,
} from './app-manifest'
import { type DeclaredConfigSource, declaredConfig, type RepoFileReader } from './declared-config'
import { type AppNames, appNames, kvTitleOf, namingProblems } from './names'
import {
  ROCKETFLARE_KIT_ID,
  ROCKETFLARE_LEGACY_APP_MANIFESTS,
  rocketflareFallbackManifest,
} from './rocketflare-fallback'
import { getKit, type KitRow } from './store'
import { type ConfigValues, resources, writeConfig } from './toml'
import {
  type UpgradePromptInput,
  upgradeFollowUpPrompt,
  upgradePrompt,
  upgradeTitle,
} from './upgrade-prompt'

/** The repo files the scaffold check reads, by what they are. */
export interface ScaffoldedFiles {
  /** The app manifest (`scaffold.appManifest` — Rocketflare's `.rocketflare.json`). */
  manifest: string
  /** `worker.tomls.production`. */
  production: string
  /** `worker.tomls.staging`. */
  staging: string
}

export interface ScaffoldExpectation {
  slug: string
  /**
   * The kit tag the job was pinned to (`kit.version` must equal it, less any leading `v`); null or
   * absent for a commit pin, whose `kit.version` need only be present.
   */
  tag?: string | null
  /** The pinned kit commit; checked against `kit.commit` when given (a commit pin's proof). */
  commit?: string
}

/** A generated secret's 32 random bytes, written the way the kit asks (`launchProvides.generated`). */
export interface GeneratedSecret {
  name: string
  kind: GeneratedSecretKind
}

/** What a kit upgrade session is told, and how its answer and its notes are found (P6 6c). */
export interface UpgradeAdapter {
  prompt(input: UpgradePromptInput): string
  followUp(input: Pick<UpgradePromptInput, 'to'>): string
  title(input: UpgradePromptInput): string
  /** The porting note of `version` in the KIT repo (`upgrade.notes`), or null when it has none. */
  notesPath(version: string): string | null
  /** The prefix of the answer's last line (`LAUNCH-UPGRADE:`). */
  doneMarker: string
}

export interface TemplateAdapter {
  /** The kit's id (`kit.id`): `rocketflare`, `launch-kit`, … */
  id: string
  /** The kit's display name (`kit.name`). */
  name: string
  /** The contract version an app records (`schema`, `'1'`). */
  contractVersion: string
  /** The manifest the adapter was built from. */
  manifest: KitManifest
  /** Where the adapter reads an app's identity and config in its repo. */
  paths: {
    /** `scaffold.appManifest`. */
    manifest: string
    /** Every app-manifest name it accepts, in the order it tries them (the first is `manifest`). */
    manifests: readonly string[]
    tomls: Record<AppEnvironmentName, string>
  }
  scaffold: {
    /** The workflow file the scaffold job's OIDC token must come from. */
    workflowFile: string
    /** The two files to commit before dispatching the job. */
    files: () => CommitFile[]
    /** Why a scaffold is not the app Launch asked for ({@link scaffoldProblems}). */
    problems: (files: ScaffoldedFiles, expected: ScaffoldExpectation) => string[]
  }
  /** Launch's names for one environment (`names.ts`). */
  names: (slug: string, env: AppEnvironmentName, appsDomain: string) => AppNames
  /** The title of the KV namespace Launch creates for a toml binding. */
  kvTitle: (slug: string, binding: string, env: AppEnvironmentName) => string
  /** Why a toml's names are not the app's, by the naming rule. */
  namingProblems: (
    file: string,
    env: AppEnvironmentName,
    declared: ReturnType<typeof resources>,
    slug: string
  ) => string[]
  resources: typeof resources
  writeConfig: (tomlText: string, env: AppEnvironmentName, values: ConfigValues) => string
  placeholderScript: typeof placeholderScript
  /** The app manifest's identity, worded for this kit; throws `ManifestError`. */
  parseManifest: (text: string, file?: string) => AppManifestIdentity
  /** One toml, its URL read from the kit's app-URL var; throws `ManifestError`. */
  parseToml: (text: string, file: string) => WranglerEnvironment
  /** Worker secret names for an environment (the same set for both today). */
  secretTargets: (env: AppEnvironmentName) => readonly string[]
  /** The kit's names for the Worker secrets Launch puts, by what they are. */
  secrets: {
    databaseUrl: string
    oidcClientSecret: string
    /** Null: the kit takes no bootstrap admin. */
    bootstrapAdmins: string | null
    /** Null: the kit sends no email, so Launch mints no sending key. */
    emailApiKey: string | null
    generated: readonly GeneratedSecret[]
  }
  /** How a release happens: `workflow_dispatch` of this file with `{ [environmentInput]: env }`. */
  release: { workflowFile: string; environmentInput: string }
  health: { live: string; ready: string }
  /** The var and secret names the app reads for OIDC sign-in (spec/05). */
  auth: { issuer: string; clientId: string; clientSecret: string }
  /** The check branch protection requires and a landing waits for (`ci.requiredCheck`). */
  requiredCheck: string
  /** The Neon roles and extensions the pipeline creates (`database`). */
  database: { migratorRole: string; appRole: string; extensions: readonly string[] }
  /** The config keys the app's plugins and the kit declare, read through a file reader (P5). */
  declaredConfig: (read: RepoFileReader) => ReturnType<typeof declaredConfig>
  /** Null: the kit declares no upgrade, so its apps are never behind and never upgraded. */
  upgrade: UpgradeAdapter | null
}

/** The app-manifest names an adapter reads: the manifest's, then any legacy one its kit had. */
function appManifestPaths(manifest: KitManifest): readonly string[] {
  const legacy = manifest.kit.id === ROCKETFLARE_KIT_ID ? ROCKETFLARE_LEGACY_APP_MANIFESTS : []
  return [manifest.scaffold.appManifest, ...legacy.filter(p => p !== manifest.scaffold.appManifest)]
}

/**
 * Why the scaffolded repo is not the app Launch asked for — one sentence per problem, empty when
 * it is. The `scaffold.verify` step fails with these: the app manifest must name the app and the
 * pinned kit, and every account-scoped name in both tomls must follow the kit's naming rule for the
 * app's slug (`namingProblems`; a plugin's resources are fine as long as they are the app's). A
 * binding kind Launch cannot provision is a problem too.
 *
 * Before D36 this also checked four Rocketflare bindings by name (`JOBS_QUEUE`, `FILES`,
 * `AGENT_RUN_WORKFLOW`, `RATE_LIMIT_KV`) and `APP_ENV`; the contract has no field for them, and the
 * naming rule catches every name a rename got wrong, so they were dropped.
 */
function scaffoldProblemsFor(
  manifest: KitManifest,
  files: ScaffoldedFiles,
  expected: ScaffoldExpectation
): string[] {
  const problems: string[] = []
  const file = manifest.scaffold.appManifest
  try {
    const identity = parseAppManifest(files.manifest, file, manifest.kit.name)
    if (identity.slug !== expected.slug) {
      problems.push(`${file} names the app ${identity.slug ?? '(none)'}, not ${expected.slug}`)
    }
    if (expected.tag) {
      const tag = expected.tag.replace(/^v/, '')
      if (identity.kitVersion !== tag) {
        problems.push(`${file} says kit ${identity.kitVersion ?? '(none)'}, not ${tag}`)
      }
    } else if (!identity.kitVersion) {
      problems.push(`${file} records no kit version`)
    }
    if (expected.commit && identity.kitCommit !== expected.commit) {
      problems.push(
        `${file} says kit commit ${identity.kitCommit ?? '(none)'}, not ${expected.commit}`
      )
    }
  } catch (err) {
    problems.push(err instanceof ManifestError ? err.message : `${file} is unreadable`)
  }

  for (const env of ['production', 'staging'] as const) {
    const path = manifest.worker.tomls[env]
    let declared: ReturnType<typeof resources>
    try {
      declared = resources(files[env])
    } catch (err) {
      problems.push(err instanceof Error ? `${path}: ${err.message}` : `${path} is unreadable`)
      continue
    }
    problems.push(...namingProblems(path, env, declared, expected.slug, manifest))
    if (declared.unsupported.length > 0) {
      problems.push(`${path}: Launch cannot provision ${declared.unsupported.join(', ')}`)
    }
  }
  return problems
}

/** Build the adapter for one kit manifest. Pure. */
export function manifestAdapter(manifest: KitManifest): TemplateAdapter {
  const p = manifest.launchProvides
  const generated = p.generated.map(g => ({ name: g.name, kind: g.kind }))
  const secretTargets = [
    ...generated.map(g => g.name),
    p.oidc.clientSecret,
    ...(p.bootstrapAdmins ? [p.bootstrapAdmins] : []),
    p.databaseUrl,
    ...(p.emailApiKey ? [p.emailApiKey] : []),
  ]
  const manifests = appManifestPaths(manifest)
  const declared: DeclaredConfigSource = { manifest, manifests }
  const upgrade = manifest.upgrade
  return {
    id: manifest.kit.id,
    name: manifest.kit.name,
    contractVersion: String(manifest.schema),
    manifest,
    paths: { manifest: manifest.scaffold.appManifest, manifests, tomls: manifest.worker.tomls },
    scaffold: {
      workflowFile: SCAFFOLD_WORKFLOW_FILE,
      files: scaffoldFiles,
      problems: (files, expected) => scaffoldProblemsFor(manifest, files, expected),
    },
    names: (slug, env, appsDomain) => appNames(slug, env, appsDomain, manifest),
    kvTitle: (slug, binding, env) => kvTitleOf(slug, binding, env, manifest),
    namingProblems: (file, env, declared, slug) =>
      namingProblems(file, env, declared, slug, manifest),
    resources,
    writeConfig: (tomlText, env, values) => writeConfig(tomlText, env, values, manifest),
    placeholderScript: (tomlText, opts = {}) =>
      placeholderScript(tomlText, { healthPath: manifest.health.live, ...opts }),
    parseManifest: (text, file = manifest.scaffold.appManifest) =>
      parseAppManifest(text, file, manifest.kit.name),
    parseToml: (text, file) => parseWranglerToml(text, file, p.appUrl),
    secretTargets: () => secretTargets,
    secrets: {
      databaseUrl: p.databaseUrl,
      oidcClientSecret: p.oidc.clientSecret,
      bootstrapAdmins: p.bootstrapAdmins ?? null,
      emailApiKey: p.emailApiKey ?? null,
      generated,
    },
    release: {
      workflowFile: manifest.release.workflow,
      environmentInput: manifest.release.environmentInput,
    },
    health: { live: manifest.health.live, ready: manifest.health.ready },
    auth: { issuer: p.oidc.issuer, clientId: p.oidc.clientId, clientSecret: p.oidc.clientSecret },
    requiredCheck: manifest.ci.requiredCheck,
    database: {
      migratorRole: manifest.database.roles.migrator,
      appRole: manifest.database.roles.app,
      extensions: manifest.database.extensions,
    },
    declaredConfig: read => declaredConfig(read, declared),
    upgrade: upgrade
      ? {
          prompt: input => upgradePrompt(input, manifest),
          followUp: input => upgradeFollowUpPrompt(input, manifest),
          title: upgradeTitle,
          notesPath: version =>
            upgrade.notes ? upgrade.notes.replaceAll('{version}', version) : null,
          doneMarker: upgrade.doneMarker,
        }
      : null,
  }
}

// ---- the Rocketflare fallback ---------------------------------------------------------------------

/** The Rocketflare fallback's adapter: every app with no kit manifest of its own resolves to it. */
export const rocketflareAdapter: TemplateAdapter = manifestAdapter(rocketflareFallbackManifest())

/** The adapter contract version an app records (spec/02, "Rocketflare adapter v1"). */
export const ROCKETFLARE_CONTRACT_VERSION = rocketflareAdapter.contractVersion

/** The Rocketflare fallback's Worker secrets (`secretTargets`). */
export const ROCKETFLARE_WORKER_SECRETS = rocketflareAdapter.secretTargets('production')

/** The fallback's scaffold check (`TemplateAdapter.scaffold.problems`). */
export function scaffoldProblems(files: ScaffoldedFiles, expected: ScaffoldExpectation): string[] {
  return rocketflareAdapter.scaffold.problems(files, expected)
}

// ---- resolution -----------------------------------------------------------------------------------

/** A stored manifest, parsed again (defaults filled); null when it no longer parses. */
function storedManifest(value: unknown): KitManifest | null {
  if (value === null || value === undefined) return null
  const parsed = kitManifestSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

/** The manifest a kit row stands for: its snapshot, else (none read yet) the Rocketflare fallback. */
export function kitManifestOf(kit: Pick<KitRow, 'manifest'> | null | undefined): KitManifest {
  return storedManifest(kit?.manifest) ?? rocketflareFallbackManifest()
}

/** The adapter of a kit row (see {@link kitManifestOf}). */
export function adapterForKit(kit: Pick<KitRow, 'manifest'> | null | undefined): TemplateAdapter {
  const manifest = storedManifest(kit?.manifest)
  return manifest ? manifestAdapter(manifest) : rocketflareAdapter
}

/** What {@link adapterFor} reads of an app. */
export type AdapterApp = Pick<AppRow, 'kitId' | 'kitManifest'>

/**
 * The adapter an app is driven by: its own manifest snapshot, else its kit's, else the fallback
 * (see the header). Reads the database only when the app carries no snapshot.
 */
export async function adapterFor(db: Database, app: AdapterApp): Promise<TemplateAdapter> {
  const own = storedManifest(app.kitManifest)
  if (own) return manifestAdapter(own)
  if (!app.kitId) return rocketflareAdapter
  return adapterForKit(await getKit(db, app.kitId))
}

/** {@link adapterFor} by id — for a caller that holds a row of the app's, not the app. */
export async function adapterForAppId(
  db: Database,
  tenantId: string,
  appId: string
): Promise<TemplateAdapter> {
  const [app] = await db
    .select({ kitId: apps.kitId, kitManifest: apps.kitManifest })
    .from(apps)
    .where(and(eq(apps.tenantId, tenantId), eq(apps.id, appId)))
    .limit(1)
  return app ? adapterFor(db, app) : rocketflareAdapter
}

/**
 * Many apps' adapters at once (a catalogue, a health poll): one kit read per distinct kit, an
 * app's own snapshot first. Keyed by the app objects passed in.
 */
export async function adaptersFor<T extends AdapterApp>(
  db: Database,
  list: readonly T[]
): Promise<Map<T, TemplateAdapter>> {
  const kits = new Map<string, Promise<TemplateAdapter>>()
  const out = new Map<T, TemplateAdapter>()
  for (const app of list) {
    const own = storedManifest(app.kitManifest)
    if (own) {
      out.set(app, manifestAdapter(own))
      continue
    }
    if (!app.kitId) {
      out.set(app, rocketflareAdapter)
      continue
    }
    const kitId = app.kitId
    let pending = kits.get(kitId)
    if (!pending) {
      pending = getKit(db, kitId).then(adapterForKit)
      kits.set(kitId, pending)
    }
    out.set(app, await pending)
  }
  return out
}
