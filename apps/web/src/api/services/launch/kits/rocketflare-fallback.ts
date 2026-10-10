/**
 * The built-in manifest for Rocketflare releases that carry no `launch.kit.json` (D36 §6; every
 * release up to 0.17.x): `docs/plans/multi-kit.md` Appendix A, as the one place Launch's code
 * holds knowledge of a particular kit. `readKitManifest` answers it for a repo whose
 * `.rocketflare.json` says it IS the Rocketflare kit (`kit.name: rocketflare`, no `app`).
 *
 * Every value is what Launch hardcodes today — `tests/config/kit-manifest.test.ts` parses this
 * through `kitManifestSchema` and checks each against its source constant, so the two cannot drift
 * while K2–K4 move those call sites onto the manifest:
 *
 * | Block | Source in Launch today |
 * |---|---|
 * | `scaffold.init` / `postInit` | `rocketflare/scaffold-job.ts` (the rename call, install, lint:fix) |
 * | `scaffold.kitOnly` | the kit's own `.rocketflare.json` `kitOnly` (0.16.0+) |
 * | `worker.tomls` | `rocketflare-manifest.ts` `WRANGLER_PATHS` |
 * | `worker.naming`, `worker.titles` | `rocketflare/names.ts` (`environmentSuffix`, `kvTitle`) |
 * | `launchProvides` | `rocketflare/toml.ts` `launchVars` + `writeConfig`, `adapter.ts` `ROCKETFLARE_WORKER_SECRETS` / `auth` |
 * | `declaredConfig.optional` | `rocketflare/declared-config.ts` `KIT_OPTIONAL_CONFIG` |
 * | `database` | `pipeline/provision-neon.ts` (`MIGRATOR_ROLE`, `APP_ROLE`, the `vector` extension) |
 * | `health`, `release` | `adapter.ts` (`health`, `release`) |
 * | `ci` | `@launch/shared/launch-apps` `KIT_REQUIRED_CHECK`, `sessions/gate.ts` |
 * | `session` | `sessions/rocketflare-dev.ts` (`INSTALL_COMMAND`, the bootstrap, the dev server, the ports, the env) |
 * | `upgrade` | `rocketflare/upgrade-prompt.ts`, `kitUpgradeNotesUrl` |
 *
 * Two things Launch does to Rocketflare have no field, on purpose (Appendix A): the bootstrap's
 * root preload and the scaffold's test/preserved-org patches — legacy steps, not contract.
 * `plugins.defaults` is the kit's `defaultPlugins` at 0.17.8; the scaffold job still reads the
 * kit's own list (`default-plugins.mjs`) until K3.
 */
import {
  type KitManifest,
  type KitManifestInput,
  kitManifestSchema,
} from '@launch/shared/kit-manifest'

/**
 * The fallback, as the kit would write it (`z.input`) — `docs/plans/multi-kit.md` Appendix A is
 * this object as JSON (`tests/config/kit-manifest.test.ts` holds the two equal).
 */
export const ROCKETFLARE_FALLBACK_INPUT = {
  schema: 1,
  kit: {
    id: 'rocketflare',
    name: 'Rocketflare',
    description: 'Multi-tenant SaaS starter for internal tools and B2B products',
    repo: 'https://github.com/rocketflare-dev/rocketflare.git',
    version: { file: 'package.json', field: 'version' },
    tagPattern: '^\\d+\\.\\d+\\.\\d+$',
  },
  scaffold: {
    init: 'node scripts/rename.mjs {slug} {display} --domain {domain} --force --skip-install',
    kitOnly: [
      'apps/web/tests/kit-only/**',
      '.github/workflows/kit.yml',
      '.github/workflows/plugin-ci.yml',
      '.github/workflows/notify-plugins.yml',
    ],
    postInit: ['pnpm install --no-frozen-lockfile', 'pnpm lint:fix'],
    appManifest: '.rocketflare.json',
  },
  worker: {
    tomls: { production: 'apps/web/wrangler.toml', staging: 'apps/web/wrangler.staging.toml' },
    naming: { pattern: '{slug}-{suffix}', stagingSuffix: '-staging' },
    // `names.ts`: the KV is created as `<slug>-rate-limit[-staging]`, not `…-rate-limit-kv`.
    titles: { RATE_LIMIT_KV: 'rate-limit' },
  },
  launchProvides: {
    appUrl: 'APP_URL',
    emailFrom: 'EMAIL_FROM',
    databaseUrl: 'DATABASE_URL',
    databaseDriver: { name: 'DATABASE_DRIVER', value: 'neon' },
    oidc: {
      issuer: 'OIDC_ISSUER',
      clientId: 'OIDC_CLIENT_ID',
      clientSecret: 'OIDC_CLIENT_SECRET',
      label: 'OIDC_LABEL',
      only: 'AUTH_OIDC_ONLY',
    },
    bootstrapAdmins: 'BOOTSTRAP_ADMIN_EMAILS',
    emailApiKey: 'RESEND_API_KEY',
    generated: [{ name: 'OAUTH_ENCRYPTION_KEY', kind: 'hex64' }],
    vars: { TENANCY_MODE: 'single', SIGNUP_MODE: 'open' },
  },
  declaredConfig: {
    optional: [
      'ANTHROPIC_API_KEY',
      'EMBEDDINGS_API_KEY',
      'FIREWORKS_API_KEY',
      'GEMINI_API_KEY',
      'LANGFUSE_PUBLIC_KEY',
      'LANGFUSE_SECRET_KEY',
      'OTEL_EXPORTER_OTLP_ENDPOINT',
      'OTEL_EXPORTER_OTLP_HEADERS',
    ],
    pluginManifests: 'apps/web/src/plugins/*/plugin.json',
  },
  database: {
    roles: { migrator: 'migrator', app: 'app' },
    extensions: ['vector'],
    migrate: 'pnpm db:migrate:ci',
    rlsRole: '{slug_snake}_app',
  },
  health: { live: '/api/health', ready: '/api/ready' },
  ci: {
    requiredCheck: 'Gate',
    gateList: 'pnpm gate --list --json',
    gateRun: 'pnpm gate {step}',
    verifiedVariable: 'LAUNCH_GATE_APP_ID',
    testEnv: { branch: 'TEST_DATABASE_BRANCH', endpoint: 'TEST_DATABASE_ENDPOINT' },
  },
  release: { workflow: 'deploy.yml', environmentInput: 'environment', deployerProtocol: 1 },
  session: {
    install: 'pnpm install --frozen-lockfile --prefer-offline --reporter=silent',
    bootstrap:
      'node scripts/bootstrap.mjs --db-url {dbUrl} --driver neon --offline --no-dev --no-open --no-plugins --yes',
    devStart: 'node apps/web/scripts/dev-server.mjs --start',
    devStop: 'pnpm dev:stop',
    ports: { ui: 'DEV_UI_PORT', api: 'DEV_API_PORT', allowedHosts: 'DEV_ALLOWED_HOSTS' },
    writes: ['apps/web/.dev.vars', 'apps/web/wrangler.session.toml'],
    env: { skip: 'ROCKETFLARE_BOOTSTRAP_SKIP', allowRoot: 'ROCKETFLARE_ALLOW_ROOT' },
  },
  upgrade: {
    command: 'pnpm kit:upgrade --to {to} --apply',
    skill: '.claude/skills/rf-upgrade/SKILL.md',
    notes: 'docs/upgrades/{version}.md',
    doneMarker: 'LAUNCH-UPGRADE:',
  },
  plugins: {
    defaults: [
      {
        id: 'analytics',
        repo: 'https://github.com/rocketflare-dev/rocketflare-plugins.git',
        ref: '3.4.2',
        subdir: 'plugins/analytics',
      },
    ],
    add: 'pnpm plugin add {repo} --apply --allow-dirty',
  },
} satisfies KitManifestInput

/** The Rocketflare fallback manifest, parsed (defaults filled) — a fresh copy per call. */
export function rocketflareFallbackManifest(): KitManifest {
  return kitManifestSchema.parse(structuredClone(ROCKETFLARE_FALLBACK_INPUT))
}

/** The Rocketflare kit's `id` (`kit.id`) — the slug of the built-in catalogue row. */
export const ROCKETFLARE_KIT_ID = 'rocketflare'
