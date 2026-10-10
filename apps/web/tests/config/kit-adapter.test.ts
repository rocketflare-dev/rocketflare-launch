/**
 * D36 K2: the `TemplateAdapter` built from a kit's manifest (`kits/adapter.ts` `manifestAdapter`),
 * driven with a kit that is NOT Rocketflare — the meta-kit `rocketflare-dev/launch-kit` 0.1.0
 * (`tests/fixtures/launch-kit-0.1/`, its own `launch.kit.json` and tomls). Every name Launch reads or
 * writes comes from that manifest: the app manifest (`.launch-app.json`), the toml vars it writes (no
 * `EMAIL_FROM`, no `OIDC_LABEL`, no fixed vars), the Worker secrets (`SESSION_SECRET` generated as
 * hex, no email key), the declared config, the naming check, the required check, the release
 * workflow and the upgrade prompt. The Rocketflare fallback's adapter is pinned to its old constants
 * by `rocketflare-adapter.test.ts` and `kit-manifest.test.ts`.
 */
import { readFileSync } from 'node:fs'
import { type KitManifest, parseKitManifest } from '@launch/shared/kit-manifest'
import { parse as parseToml } from 'smol-toml'
import { describe, expect, it } from 'vitest'
import {
  adapterFor,
  adapterForKit,
  manifestAdapter,
  rocketflareAdapter,
} from '@/api/services/launch/kits/adapter'
import { checkKitConformance } from '@/api/services/launch/kits/conformance'
import { rocketflareFallbackManifest } from '@/api/services/launch/kits/rocketflare-fallback'
import { patchToml } from '@/api/services/launch/kits/toml'
import { generateSecret } from '@/api/services/launch/pipeline/worker-secrets'
import type { Database } from '@/db/client'

const kitFile = (path: string) =>
  readFileSync(new URL(`../fixtures/launch-kit-0.1/${path}`, import.meta.url), 'utf8')

const manifest: KitManifest = parseKitManifest(kitFile('launch.kit.json'))
const adapter = manifestAdapter(manifest)

const SLUG = 'acme'
/** The kit's tomls as its init leaves them for `acme` (the kit slug is every name's prefix). */
const renamed = (file: string) => kitFile(file).replaceAll('launch-kit', SLUG)
const tomls = {
  production: renamed('apps/web/wrangler.toml'),
  staging: renamed('apps/web/wrangler.staging.toml'),
}
/** `.launch-app.json` as the scaffold stamps it. */
const appManifest = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    app: { slug: SLUG, display: 'Acme', domain: 'example.com' },
    kit: { id: 'launch-kit', version: '0.1.0', commit: 'a'.repeat(40) },
    ...over,
  })

type Doc = Record<string, unknown>
const vars = (text: string) => (parseToml(text) as Doc).vars as Record<string, string>

describe('a non-Rocketflare kit, through its manifest', () => {
  it('is its kit, and reads the files its manifest names', () => {
    expect(adapter).toMatchObject({
      id: 'launch-kit',
      name: 'Launch Kit',
      contractVersion: '1',
      paths: {
        manifest: '.launch-app.json',
        manifests: ['.launch-app.json'],
        tomls: { production: 'apps/web/wrangler.toml', staging: 'apps/web/wrangler.staging.toml' },
      },
      release: { workflowFile: 'deploy.yml', environmentInput: 'environment' },
      health: { live: '/api/health', ready: '/api/ready' },
      requiredCheck: 'Gate',
      database: { migratorRole: 'migrator', appRole: 'app', extensions: [] },
    })
    expect(adapter.parseManifest(appManifest())).toMatchObject({
      slug: SLUG,
      kitId: 'launch-kit',
      kitVersion: '0.1.0',
    })
    expect(() => adapter.parseManifest('[]')).toThrow(
      '.launch-app.json is not a Launch Kit manifest'
    )
  })

  it('names the Worker by the naming rule and the KV by its binding (no titles map)', () => {
    expect(adapter.names(SLUG, 'staging', 'Example.com.')).toEqual({
      workerName: 'acme-staging',
      resendKeyName: 'acme-staging',
      host: 'acme-staging.example.com',
      url: 'https://acme-staging.example.com',
    })
    expect(adapter.kvTitle(SLUG, 'RATE_LIMIT_KV', 'production')).toBe('acme-rate-limit-kv')
    expect(adapter.kvTitle(SLUG, 'RATE_LIMIT_KV', 'staging')).toBe('acme-rate-limit-kv-staging')
  })

  it('writes only the vars the kit maps: no EMAIL_FROM, no OIDC_LABEL, no fixed vars', () => {
    const values = (env: 'production' | 'staging') => ({
      appUrl: adapter.names(SLUG, env, 'example.com').url,
      emailFrom: 'never written',
      kvIds: { RATE_LIMIT_KV: env === 'staging' ? 'b'.repeat(32) : 'a'.repeat(32) },
      oidc: { issuer: 'https://launch.example.com', clientId: `lc_${env}` },
    })
    for (const env of ['production', 'staging'] as const) {
      const out = adapter.writeConfig(tomls[env], env, values(env))
      const v = vars(out)
      expect(v).toMatchObject({
        APP_URL: values(env).appUrl,
        OIDC_ISSUER: 'https://launch.example.com',
        OIDC_CLIENT_ID: `lc_${env}`,
        AUTH_OIDC_ONLY: 'true',
        DATABASE_DRIVER: 'neon',
      })
      for (const absent of ['EMAIL_FROM', 'OIDC_LABEL', 'TENANCY_MODE', 'SIGNUP_MODE']) {
        expect(v[absent]).toBeUndefined()
      }
      expect((parseToml(out) as Doc).workers_dev).toBe(false)
      expect(out).not.toContain('<RATE_LIMIT_KV')
      expect(out).toContain('the client secret is the OIDC_CLIENT_SECRET Worker secret')
      // Idempotent, like the Rocketflare writer.
      expect(adapter.writeConfig(out, env, values(env))).toBe(out)
    }
  })

  it('a kit that names no driver var still gets no Hyperdrive block', () => {
    const noDriver = manifestAdapter({
      ...manifest,
      launchProvides: { ...manifest.launchProvides, databaseDriver: undefined },
    })
    const withHyperdrive = `${tomls.production}\n[[hyperdrive]]\nbinding = "HYPERDRIVE"\nid = "x"\n`
    const out = noDriver.writeConfig(withHyperdrive, 'production', {
      appUrl: 'https://acme.example.com',
      emailFrom: '',
      kvIds: { RATE_LIMIT_KV: 'a'.repeat(32) },
      oidc: { issuer: 'https://launch.example.com', clientId: 'lc_x' },
    })
    expect(out).not.toContain('[[hyperdrive]]')
    expect(out).toContain('DATABASE_DRIVER = "neon"') // the kit's own committed value, untouched
  })

  it('puts the secrets the kit names, generating SESSION_SECRET as hex', () => {
    expect(adapter.secretTargets('production')).toEqual([
      'SESSION_SECRET',
      'OIDC_CLIENT_SECRET',
      'BOOTSTRAP_ADMIN_EMAILS',
      'DATABASE_URL',
    ])
    expect(adapter.secrets).toEqual({
      databaseUrl: 'DATABASE_URL',
      oidcClientSecret: 'OIDC_CLIENT_SECRET',
      bootstrapAdmins: 'BOOTSTRAP_ADMIN_EMAILS',
      emailApiKey: null,
      generated: [{ name: 'SESSION_SECRET', kind: 'hex64' }],
    })
    expect(generateSecret('hex64')).toMatch(/^[0-9a-f]{64}$/)
    expect(generateSecret('hex64')).not.toBe(generateSecret('hex64'))
    // Rocketflare's key stays the base64 it always was.
    expect(rocketflareAdapter.secrets.generated).toEqual([
      { name: 'OAUTH_ENCRYPTION_KEY', kind: 'base64-32' },
    ])
    expect(atob(generateSecret('base64-32'))).toHaveLength(32)
  })

  it('declares only what the kit declares, from its own app manifest', async () => {
    const reads: string[] = []
    const read = (files: Record<string, string>) => async (path: string) => {
      reads.push(path)
      return files[path] ?? null
    }
    expect(await adapter.declaredConfig(read({}))).toEqual([])
    expect(reads).toEqual(['.launch-app.json'])
    expect(await adapter.declaredConfig(read({ '.launch-app.json': appManifest() }))).toEqual([])
    // A kit with plugins and optional config: anchors default from its glob, `plain` is not secret.
    const withPlugins = manifestAdapter({
      ...manifest,
      declaredConfig: {
        optional: ['SENTRY_DSN', 'SENTRY_ENV'],
        plain: ['SENTRY_ENV'],
        pluginManifests: 'src/extensions/*/manifest.json',
      },
    })
    const declared = await withPlugins.declaredConfig(
      read({
        '.launch-app.json': appManifest({
          surfaces: [{ id: 'crm', kind: 'plugin' }],
        }),
        'src/extensions/crm/manifest.json': JSON.stringify({ id: 'crm', vars: ['CRM_URL'] }),
      })
    )
    expect(declared).toEqual([
      { key: 'CRM_URL', secret: false, pluginId: 'crm' },
      { key: 'SENTRY_DSN', secret: true, pluginId: 'kit' },
      { key: 'SENTRY_ENV', secret: false, pluginId: 'kit' },
    ])
  })

  it('checks a scaffold by its own manifest and naming rule', () => {
    const files = { manifest: appManifest(), ...tomls }
    const expected = { slug: SLUG, tag: '0.1.0', commit: 'a'.repeat(40) }
    expect(adapter.scaffold.problems(files, expected)).toEqual([])
    expect(adapter.scaffold.problems(files, { ...expected, slug: 'other' })).toEqual([
      '.launch-app.json names the app acme, not other',
      'apps/web/wrangler.toml: name is acme, not other',
      'apps/web/wrangler.staging.toml: name is acme-staging, not other-staging',
    ])
    const foreign = patchToml(tomls.staging, {
      bindings: [{ type: 'r2', binding: 'UPLOADS', name: 'someone-elses-bucket' }],
    })
    expect(adapter.scaffold.problems({ ...files, staging: foreign }, expected)).toEqual([
      "apps/web/wrangler.staging.toml: someone-elses-bucket is not one of acme-staging's names",
    ])
    const own = patchToml(tomls.staging, {
      bindings: [{ type: 'queue', binding: 'MAIL_QUEUE', name: 'acme-mail-staging' }],
    })
    expect(adapter.scaffold.problems({ ...files, staging: own }, expected)).toEqual([])
  })

  it('upgrades with the kit’s own command, skill and app manifest — and only if it declares one', () => {
    const upgrade = adapter.upgrade
    expect(upgrade).not.toBeNull()
    const prompt = upgrade?.prompt({ from: '0.1.0', to: '0.2.0' }) ?? ''
    expect(prompt).toContain("Upgrade this app's Launch Kit kit from 0.1.0 to 0.2.0.")
    expect(prompt).toContain('`node scripts/upgrade.mjs --to 0.2.0 --apply`')
    expect(prompt).toContain('Read `.claude/skills/upgrade/SKILL.md`')
    expect(prompt).toContain('`.launch-app.json` says 0.2.0')
    expect(prompt.trimEnd().endsWith('otherwise `LAUNCH-UPGRADE: STOPPED`.')).toBe(true)
    expect(prompt).not.toMatch(/kit:upgrade|rocketflare|rf-upgrade|\.upgrade\/work/i)
    expect(upgrade?.followUp({ to: '0.2.0' })).toContain(
      'Run `node scripts/upgrade.mjs --to 0.2.0 --apply` now and follow `.claude/skills/upgrade/SKILL.md`'
    )
    expect(upgrade?.notesPath('0.2.0')).toBe('docs/upgrades/0.2.0.md')
    expect(manifestAdapter({ ...manifest, upgrade: undefined }).upgrade).toBeNull()
  })

  it('the placeholder page polls the kit’s live route', () => {
    const own = manifestAdapter({ ...manifest, health: { live: '/healthz', ready: '/readyz' } })
    const script = own.placeholderScript(tomls.production, { appName: 'Acme' })
    expect(script.modules[0]?.content).toContain('/healthz')
  })
})

describe('conformance: one generated secret', () => {
  it('a kit that names two is refused', async () => {
    const two = {
      ...JSON.parse(kitFile('launch.kit.json')),
      launchProvides: {
        ...JSON.parse(kitFile('launch.kit.json')).launchProvides,
        generated: [
          { name: 'SESSION_SECRET', kind: 'hex64' },
          { name: 'OTHER_SECRET', kind: 'hex64' },
        ],
      },
    }
    const result = await checkKitConformance(async path =>
      path === 'launch.kit.json' ? JSON.stringify(two) : null
    )
    expect(result.problems).toContain(
      'launchProvides.generated names 2 secrets; Launch generates at most one per environment'
    )
  })
})

describe('resolution (no database needed when the app carries its manifest)', () => {
  const noDb = {} as Database
  it('an app’s own snapshot wins; none and no kit is the Rocketflare fallback', async () => {
    expect((await adapterFor(noDb, { kitId: null, kitManifest: manifest })).id).toBe('launch-kit')
    expect(await adapterFor(noDb, { kitId: null, kitManifest: null })).toBe(rocketflareAdapter)
    // A snapshot that no longer parses is never used.
    expect(
      await adapterFor(noDb, { kitId: null, kitManifest: { schema: 9 } as unknown as KitManifest })
    ).toBe(rocketflareAdapter)
  })

  it('a kit row stands for its snapshot, else the fallback', () => {
    expect(adapterForKit({ manifest }).id).toBe('launch-kit')
    expect(adapterForKit({ manifest: null })).toBe(rocketflareAdapter)
    expect(adapterForKit(null).manifest).toEqual(rocketflareFallbackManifest())
  })
})
