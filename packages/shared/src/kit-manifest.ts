/**
 * The Launch kit contract (D36, `docs/plans/multi-kit.md` §4): `launch.kit.json` at a kit's root
 * says what the kit calls things and how to drive it, so Launch can create, develop in, ship and
 * upgrade apps from ANY conforming kit with no kit-specific code. Rocketflare is kit #1; its
 * releases without a manifest resolve to a built-in fallback (`services/launch/kits/`).
 *
 * Readers tolerate unknown fields (`passthrough`), as the gate list does: a kit adds a field
 * freely and raises `schema` only for a change a reader cannot ignore. The meta-kit
 * (`rocketflare-dev/launch-kit`, K6) will check the same shape in plain JS
 * (`scripts/kit-check.mjs`); `apps/web/tests/config/kit-manifest.test.ts` pins this schema to the
 * built-in Rocketflare fallback and to hand-written fixtures until then.
 *
 * Command and path templates substitute `{name}` placeholders ({@link fillTemplate}); each field
 * names the ones it receives. Values are never shell-quoted by the kit — Launch quotes them.
 */
import { z } from 'zod'

/** The one manifest schema version Launch reads. */
export const KIT_MANIFEST_SCHEMA_VERSION = 1

/** The manifest's path at a kit's (and a copy's) root. */
export const KIT_MANIFEST_PATH = 'launch.kit.json'

/** The Cloudflare binding kinds Launch can provision (`deploy/binding-check.ts`). */
export const PROVISIONABLE_BINDING_KINDS = [
  'kv_namespaces',
  'queues',
  'r2_buckets',
  'durable_objects',
  'workflows',
  'ai',
  'assets',
] as const

/** Rocketflare's relying-party paths, the contract's defaults (`launchProvides.oidc`). */
export const KIT_OIDC_CALLBACK_PATH = '/auth/oidc/callback'
export const KIT_OIDC_SIGNED_OUT_PATH = '/login?signedOut=1'

/** A path on the app's own origin: starts with one `/`, no scheme, no host, no fragment. */
const rpPathSchema = z
  .string()
  .max(300)
  .regex(/^\/(?!\/)[^\s#]*$/, 'a path on the app, starting with /')

const kitIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{1,38}[a-z0-9]$/, 'lowercase letters, digits and dashes (3-40)')

const commandSchema = z.string().trim().min(1).max(500)
const relPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .refine(p => !p.startsWith('/') && !p.split('/').includes('..'), 'a path inside the repo')
const envNameSchema = z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'an UPPER_SNAKE env name')

const kitBlock = z
  .object({
    id: kitIdSchema,
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(300).optional(),
    /** A repo path to a square image, or an emoji-free short mark; display only. */
    icon: z.string().trim().max(300).optional(),
    /** Where the kit lives (a git URL or `owner/name`) — what a copy's upgrade fetches from. */
    repo: z.string().trim().min(1).max(300).optional(),
    /** Where the kit's (and a copy's) version lives. Today: a JSON file's string field. */
    version: z
      .object({ file: relPathSchema, field: z.string().min(1).max(100) })
      .default({ file: 'package.json', field: 'version' }),
    /** The release tags Launch pins to and follows. */
    tagPattern: z.string().min(1).max(200).default('^\\d+\\.\\d+\\.\\d+$'),
  })
  .passthrough()

const scaffoldBlock = z
  .object({
    /** Non-interactive; receives `{slug}`, `{display}`, `{domain}`; exit 0 ok, 1 error, 2 usage. */
    init: commandSchema,
    /** Globs deleted from a copy after init (kit-only tests, the kit's own CI). */
    kitOnly: z.array(z.string().min(1).max(300)).default([]),
    /** Commands run after init, in order (install, lint:fix). */
    postInit: z.array(commandSchema).default([]),
    /** Where a copy records `app {slug, display, domain}` and `kit {id, version, commit}`. */
    appManifest: relPathSchema,
  })
  .passthrough()

const workerBlock = z
  .object({
    tomls: z.object({ production: relPathSchema, staging: relPathSchema }).passthrough(),
    /**
     * Account-scoped names are `{slug}-{suffix}`, plus `stagingSuffix` in staging; ids in the
     * committed tomls are `<NAME_ID>` placeholders Launch fills.
     */
    naming: z
      .object({
        pattern: z.literal('{slug}-{suffix}').default('{slug}-{suffix}'),
        stagingSuffix: z.string().min(1).max(30).default('-staging'),
      })
      .passthrough()
      .default({}),
    /**
     * A KV namespace has no name in the toml (only an id), so the TITLE Launch creates it under is
     * `{slug}-<suffix>`: this map's suffix for the binding, else one derived from the binding name
     * ({@link kvTitleSuffix}: `RATE_LIMIT_KV` → `rate-limit-kv`).
     */
    titles: z
      .record(z.string().min(1).max(100), z.string().regex(/^[a-z0-9][a-z0-9-]*$/))
      .optional(),
  })
  .passthrough()

/** How Launch writes a generated secret's 32 random bytes. */
export const GENERATED_SECRET_KINDS = ['hex64', 'base64-32'] as const
export type GeneratedSecretKind = (typeof GENERATED_SECRET_KINDS)[number]

/** Launch's vocabulary → the kit's own var/secret names. */
const launchProvidesBlock = z
  .object({
    appUrl: envNameSchema,
    emailFrom: envNameSchema.optional(),
    databaseUrl: envNameSchema,
    /** A var Launch sets so the app speaks Neon's serverless driver; absent: the kit needs none. */
    databaseDriver: z.object({ name: envNameSchema, value: z.string().min(1) }).optional(),
    oidc: z
      .object({
        issuer: envNameSchema,
        clientId: envNameSchema,
        clientSecret: envNameSchema,
        /** The sign-in button's label var (Launch writes "Sign in with Launch"). */
        label: envNameSchema.optional(),
        /** A var set to `true` so OIDC is the only sign-in method. */
        only: envNameSchema.optional(),
        /**
         * Where the app's sign-in returns to, relative to an environment's URL: Launch registers
         * `{url}{callbackPath}` as the client's redirect URI. Absent: Rocketflare's.
         */
        callbackPath: rpPathSchema.default(KIT_OIDC_CALLBACK_PATH),
        /** Where a sign-out lands (the post-logout redirect URI). Absent: Rocketflare's. */
        signedOutPath: rpPathSchema.default(KIT_OIDC_SIGNED_OUT_PATH),
      })
      .passthrough(),
    bootstrapAdmins: envNameSchema.optional(),
    emailApiKey: envNameSchema.optional(),
    /**
     * Secrets Launch generates once per environment and never rotates blindly — 32 random bytes,
     * written as 64 hex characters (`hex64`) or as standard base64 (`base64-32`, 44 characters).
     * Launch keeps ONE generated secret per environment today (sealed on the environment row), so
     * a manifest naming more fails conformance.
     */
    generated: z
      .array(z.object({ name: envNameSchema, kind: z.enum(GENERATED_SECRET_KINDS) }).passthrough())
      .default([]),
    /** Fixed `[vars]` Launch writes into both tomls. */
    vars: z.record(envNameSchema, z.string()).default({}),
  })
  .passthrough()

const declaredConfigBlock = z
  .object({
    /** Optional secret/var names the app reads when set (they feed grants, spec/09). */
    optional: z.array(envNameSchema).default([]),
    /** The names in `optional` that are NOT secrets (shown as plain vars); absent: all secret. */
    plain: z.array(envNameSchema).default([]),
    /** A glob of plugin manifests whose `vars[]` the app also declares. */
    pluginManifests: z.string().min(1).max(300).optional(),
  })
  .passthrough()

const databaseBlock = z
  .object({
    roles: z
      .object({ migrator: z.string().min(1).max(63), app: z.string().min(1).max(63) })
      .default({ migrator: 'migrator', app: 'app' }),
    extensions: z.array(z.string().regex(/^[a-z_][a-z0-9_]*$/)).default([]),
    /** Run by the deploy job with the migrator's short-lived credentials. */
    migrate: commandSchema,
    /** The app's runtime RLS role, `{slug_snake}` substituted; absent: no per-app role. */
    rlsRole: z.string().min(1).max(63).optional(),
  })
  .passthrough()

/** `live` SHOULD answer JSON that includes the running `version` (not checked); `ready` reaches the database. */
const healthBlock = z
  .object({
    live: z.string().startsWith('/').default('/api/health'),
    ready: z.string().startsWith('/').default('/api/ready'),
  })
  .passthrough()

const ciBlock = z
  .object({
    /** The check name branch protection requires (a job in `.github/workflows/ci.yml`). */
    requiredCheck: z.string().min(1).max(100),
    /**
     * Prints the gate's steps as JSON (gate list schema 1). The output may be preceded by a
     * package manager's header lines; readers take the outermost `{…}`.
     */
    gateList: commandSchema,
    /** Runs one step by id, `{step}` substituted. */
    gateRun: commandSchema,
    /** The repo variable naming Launch's GitHub App, so CI can trust a `launch/gate` check run. */
    verifiedVariable: envNameSchema.optional(),
    /** Env names the gate's test step reads for a throwaway Neon branch. */
    testEnv: z
      .object({ branch: envNameSchema, endpoint: envNameSchema.optional() })
      .passthrough()
      .optional(),
  })
  .passthrough()

const releaseBlock = z
  .object({
    /** A file under `.github/workflows/`: tag → staging, published release → production. */
    workflow: z.string().regex(/^[\w.-]+\.ya?ml$/),
    /** The `workflow_dispatch` input naming the environment; it must offer `staging` and `production`. */
    environmentInput: z.string().min(1).max(50).default('environment'),
    deployerProtocol: z.literal(1),
  })
  .passthrough()

const sessionBlock = z
  .object({
    install: commandSchema,
    /**
     * Brings a fresh checkout up against `{dbUrl}` (a Neon branch); no Docker, no prompts. Launch
     * substitutes `{dbUrl}` with the SHELL REFERENCE `"$LAUNCH_DB_URL"`, never the URL itself: the
     * URL travels only in the command's environment (`sessions/kit-dev.ts`), so it is in
     * no argument list, log line or step result.
     */
    bootstrap: commandSchema,
    devStart: commandSchema,
    devStop: commandSchema.optional(),
    /** Env names the dev servers read for the ports (and allowed hosts) Launch assigns. */
    ports: z
      .object({ ui: envNameSchema, api: envNameSchema, allowedHosts: envNameSchema.optional() })
      .passthrough(),
    /** Files Launch may write in a session checkout (never committed by it). */
    writes: z.array(relPathSchema).default([]),
    env: z
      .object({ skip: envNameSchema.optional(), allowRoot: envNameSchema.optional() })
      .passthrough()
      .default({}),
  })
  .passthrough()

const upgradeBlock = z
  .object({
    /** `{to}` substituted; run by the upgrade session inside the app's repo. */
    command: commandSchema,
    skill: relPathSchema.optional(),
    /** `{version}` substituted, a path in the KIT repo. */
    notes: z.string().min(1).max(300).optional(),
    /** The prefix of the last line an upgrade answer ends with: `<marker> DONE|STOPPED`. */
    doneMarker: z.string().min(1).max(60).default('LAUNCH-UPGRADE:'),
  })
  .passthrough()

const pluginsBlock = z
  .object({
    defaults: z
      .array(
        z
          .object({
            id: z.string().min(1).max(60),
            repo: z.string().min(1).max(300),
            ref: z.string().min(1).max(100),
            subdir: z.string().max(300).optional(),
          })
          .passthrough()
      )
      .default([]),
    /** `{repo}`, `{ref}`, `{subdir}`, `{id}` substituted. */
    add: commandSchema.optional(),
  })
  .passthrough()

const modulesBlock = z.array(
  z
    .object({
      id: z.string().min(1).max(60),
      name: z.string().min(1).max(80),
      description: z.string().max(300).optional(),
    })
    .passthrough()
)

export const kitManifestSchema = z
  .object({
    schema: z.literal(KIT_MANIFEST_SCHEMA_VERSION),
    kit: kitBlock,
    scaffold: scaffoldBlock,
    worker: workerBlock,
    launchProvides: launchProvidesBlock,
    declaredConfig: declaredConfigBlock.default({}),
    database: databaseBlock,
    health: healthBlock.default({}),
    ci: ciBlock,
    release: releaseBlock,
    session: sessionBlock,
    upgrade: upgradeBlock.optional(),
    plugins: pluginsBlock.optional(),
    modules: modulesBlock.optional(),
  })
  .passthrough()
export type KitManifest = z.infer<typeof kitManifestSchema>
export type KitManifestInput = z.input<typeof kitManifestSchema>

/** Parse a manifest's text; throws a ZodError (or SyntaxError) naming the problem. */
export function parseKitManifest(text: string): KitManifest {
  return kitManifestSchema.parse(JSON.parse(text))
}

/**
 * Substitute `{name}` placeholders. An unknown placeholder throws: a kit naming a value Launch
 * does not supply is a contract error, never an empty string in a command.
 */
export function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{([a-z_]+)\}/gi, (_, name: string) => {
    const value = values[name]
    if (value === undefined) throw new Error(`Unknown placeholder {${name}} in "${template}"`)
    return value
  })
}

/** The account-scoped name of a resource, by the manifest's naming rule. */
export function kitResourceName(
  manifest: Pick<KitManifest, 'worker'>,
  slug: string,
  suffix: string,
  env: 'production' | 'staging'
): string {
  const base = `${slug}-${suffix}`
  return env === 'staging' ? `${base}${manifest.worker.naming.stagingSuffix}` : base
}

/**
 * The suffix of a KV namespace's title for `binding` — the manifest's `worker.titles` entry, else
 * the binding name lowercased with `_` → `-` (`RATE_LIMIT_KV` → `rate-limit-kv`). The title is
 * {@link kitResourceName}`(manifest, slug, suffix, env)`.
 */
export function kvTitleSuffix(manifest: Pick<KitManifest, 'worker'>, binding: string): string {
  return manifest.worker.titles?.[binding] ?? binding.toLowerCase().replace(/_/g, '-')
}
