/**
 * The Launch kit contract (D36, `@launch/shared/kit-manifest`) and the one kit Launch knows by
 * name: the built-in Rocketflare fallback (`services/launch/kits/rocketflare-fallback.ts`, the
 * design's Appendix A). The fallback must parse through the schema, and every value in it must be
 * the constant Launch hardcodes today — K2–K4 move those call sites onto the manifest, and until
 * then the two may not drift.
 */
import { readFileSync } from 'node:fs'
import {
  fillTemplate,
  KIT_MANIFEST_SCHEMA_VERSION,
  kitManifestSchema,
  kitResourceName,
  kvTitleSuffix,
  PROVISIONABLE_BINDING_KINDS,
  parseKitManifest,
} from '@launch/shared/kit-manifest'
import { KIT_REQUIRED_CHECK } from '@launch/shared/launch-apps'
import { DEFAULT_TEMPLATE_PIN } from '@launch/shared/launch-setup'
import { UPGRADE_RESULT_MARKER } from '@launch/shared/launch-upgrades'
import { describe, expect, it } from 'vitest'
import { unprovisionableKeys } from '@/api/services/launch/deploy/binding-check'
import { ROCKETFLARE_WORKER_SECRETS, rocketflareAdapter } from '@/api/services/launch/kits/adapter'
import { WRANGLER_PATHS } from '@/api/services/launch/kits/app-manifest'
import { KIT_OPTIONAL_CONFIG } from '@/api/services/launch/kits/declared-config'
import {
  isRocketflareKit,
  KitManifestError,
  readKitManifest,
} from '@/api/services/launch/kits/manifest'
import { accountScopedNames } from '@/api/services/launch/kits/names'
import {
  ROCKETFLARE_FALLBACK_INPUT,
  ROCKETFLARE_KIT_ID,
  rocketflareFallbackManifest,
} from '@/api/services/launch/kits/rocketflare-fallback'
import { launchVars } from '@/api/services/launch/kits/toml'
import { APP_ROLE, MIGRATOR_ROLE } from '@/api/services/launch/pipeline/provision-neon'
import {
  INSTALL_COMMAND,
  KIT_ALLOW_ROOT_ENV,
  KIT_BOOTSTRAP_SKIP_ENV,
  SESSION_WRANGLER_CONFIG,
} from '@/api/services/sessions/kit-dev'

const manifest = rocketflareFallbackManifest()

describe('the Rocketflare fallback manifest (Appendix A)', () => {
  it('parses through the contract, and is the schema Launch reads', () => {
    expect(kitManifestSchema.parse(manifest)).toEqual(manifest)
    expect(manifest.schema).toBe(KIT_MANIFEST_SCHEMA_VERSION)
    expect(manifest.kit.id).toBe(ROCKETFLARE_KIT_ID)
    // A fresh copy each call: a caller mutating one cannot change the next.
    manifest.kit.name = 'mutated'
    expect(rocketflareFallbackManifest().kit.name).toBe('Rocketflare')
    manifest.kit.name = 'Rocketflare'
  })

  it('names the tomls, the release and the health routes the adapter uses', () => {
    expect(manifest.worker.tomls).toEqual(WRANGLER_PATHS)
    expect(manifest.release).toMatchObject({
      workflow: rocketflareAdapter.release.workflowFile,
      environmentInput: rocketflareAdapter.release.environmentInput,
      deployerProtocol: 1,
    })
    expect(manifest.health).toEqual(rocketflareAdapter.health)
  })

  it('is the design’s Appendix A, verbatim', () => {
    const doc = readFileSync(
      new URL('../../../../docs/plans/multi-kit.md', import.meta.url),
      'utf8'
    )
    const appendix = doc.slice(doc.indexOf('## Appendix A'))
    const json = /```json\n([\s\S]*?)\n```/.exec(appendix)?.[1]
    expect(json).toBeDefined()
    expect(JSON.parse(json as string)).toEqual(
      JSON.parse(JSON.stringify(ROCKETFLARE_FALLBACK_INPUT))
    )
    expect(parseKitManifest(json as string)).toEqual(manifest)
  })

  it('names resources the way names.ts does, for both environments', () => {
    for (const env of ['production', 'staging'] as const) {
      const want = accountScopedNames('acme', env)
      expect(kitResourceName(manifest, 'acme', kvTitleSuffix(manifest, 'RATE_LIMIT_KV'), env)).toBe(
        want.kvTitle
      )
      expect(kitResourceName(manifest, 'acme', 'jobs', env)).toBe(want.queue)
      expect(kitResourceName(manifest, 'acme', 'files', env)).toBe(want.r2Bucket)
      expect(kitResourceName(manifest, 'acme', 'agent-run', env)).toBe(want.workflow)
    }
  })

  it('maps Launch’s vocabulary to the vars and secrets Launch writes today', () => {
    const p = manifest.launchProvides
    expect({
      issuer: p.oidc.issuer,
      clientId: p.oidc.clientId,
      clientSecret: p.oidc.clientSecret,
      callbackPath: '/auth/oidc/callback',
      signedOutPath: '/login?signedOut=1',
    }).toEqual(rocketflareAdapter.auth)
    const vars = launchVars({
      appUrl: 'https://acme.example.com',
      emailFrom: 'Acme <noreply@example.com>',
      kvIds: {},
      oidc: { issuer: 'https://launch.example.com', clientId: 'lc_x' },
    })
    const byKey = Object.fromEntries(vars.map(v => [v.key, v.value]))
    for (const [key, value] of Object.entries(p.vars)) expect(byKey[key]).toBe(value)
    expect(byKey[p.oidc.issuer]).toBe('https://launch.example.com')
    expect(byKey[p.oidc.clientId]).toBe('lc_x')
    expect(byKey[p.oidc.only as string]).toBe('true')
    expect(byKey[p.oidc.label as string]).toBe('Sign in with Launch')
    // Every Worker secret Launch sets is one the manifest names.
    const named = new Set([
      p.oidc.clientSecret,
      p.bootstrapAdmins,
      p.databaseUrl,
      p.emailApiKey,
      ...p.generated.map(g => g.name),
    ])
    expect([...ROCKETFLARE_WORKER_SECRETS].sort()).toEqual([...named].sort())
    expect(p.databaseDriver).toEqual({ name: 'DATABASE_DRIVER', value: 'neon' })
  })

  it('declares the optional config, the database roles and the CI contract Launch assumes', () => {
    expect(manifest.declaredConfig.optional).toEqual(KIT_OPTIONAL_CONFIG.map(i => i.key))
    expect(manifest.database.roles).toEqual({ migrator: MIGRATOR_ROLE, app: APP_ROLE })
    expect(manifest.database.extensions).toEqual(['vector'])
    expect(manifest.ci.requiredCheck).toBe(KIT_REQUIRED_CHECK)
    expect(manifest.ci.gateRun).toBe('pnpm gate {step}')
  })

  it('drives a session and an upgrade with the commands Launch runs today', () => {
    expect(manifest.session.install).toBe(INSTALL_COMMAND)
    expect(manifest.session.env).toEqual({
      skip: KIT_BOOTSTRAP_SKIP_ENV,
      allowRoot: KIT_ALLOW_ROOT_ENV,
    })
    expect(manifest.session.writes).toContain(SESSION_WRANGLER_CONFIG)
    expect(fillTemplate(manifest.session.bootstrap, { dbUrl: '"$LAUNCH_DB_URL"' })).toBe(
      'node scripts/bootstrap.mjs --db-url "$LAUNCH_DB_URL" --driver neon --offline --no-dev --no-open --no-plugins --yes'
    )
    expect(manifest.upgrade?.doneMarker).toBe(UPGRADE_RESULT_MARKER)
    expect(fillTemplate(manifest.upgrade?.command ?? '', { to: '0.18.0' })).toBe(
      'pnpm kit:upgrade --to 0.18.0 --apply'
    )
  })
})

describe('the contract', () => {
  it('derives a KV title suffix from the binding when the kit names none', () => {
    const bare = { worker: { ...manifest.worker, titles: undefined } }
    expect(kvTitleSuffix(bare, 'RATE_LIMIT_KV')).toBe('rate-limit-kv')
    expect(kvTitleSuffix(bare, 'CACHE')).toBe('cache')
    expect(kvTitleSuffix(manifest, 'RATE_LIMIT_KV')).toBe('rate-limit')
  })

  it('fills placeholders and refuses one Launch does not supply', () => {
    expect(fillTemplate('a {slug} b {display}', { slug: 'acme', display: 'Acme' })).toBe(
      'a acme b Acme'
    )
    expect(() => fillTemplate('{nope}', {})).toThrow(/Unknown placeholder \{nope\}/)
  })

  it('tolerates unknown fields, and refuses another schema version', () => {
    const text = JSON.stringify({ ...manifest, future: { x: 1 } })
    expect(parseKitManifest(text)).toMatchObject({ future: { x: 1 } })
    expect(() => parseKitManifest(JSON.stringify({ ...manifest, schema: 2 }))).toThrow()
    expect(() =>
      parseKitManifest(JSON.stringify({ ...manifest, scaffold: { appManifest: '../x' } }))
    ).toThrow()
  })

  it('names as provisionable exactly what the deploy gateway lets through', () => {
    const config = Object.fromEntries(PROVISIONABLE_BINDING_KINDS.map(k => [k, {}]))
    expect(unprovisionableKeys(config)).toEqual([])
    expect(unprovisionableKeys({ ...config, d1_databases: [], hyperdrive: [] })).toEqual([
      'd1_databases',
      'hyperdrive',
    ])
  })
})

describe('which manifest a kit has', () => {
  const reader =
    (files: Record<string, string>) =>
    async (path: string): Promise<string | null> =>
      files[path] ?? null
  const KIT_PROVENANCE = JSON.stringify({
    kit: { name: 'rocketflare', version: '0.17.8' },
    app: null,
  })

  it('its own launch.kit.json wins', async () => {
    const own = { ...manifest, kit: { ...manifest.kit, id: 'acme-kit', name: 'Acme kit' } }
    const resolved = await readKitManifest(
      reader({ 'launch.kit.json': JSON.stringify(own), '.rocketflare.json': KIT_PROVENANCE })
    )
    expect(resolved.source).toBe('repo')
    expect(resolved.manifest.kit.id).toBe('acme-kit')
  })

  it('a Rocketflare release with none gets the fallback; a COPY of it does not', async () => {
    expect(await readKitManifest(reader({ '.rocketflare.json': KIT_PROVENANCE }))).toEqual({
      manifest: rocketflareFallbackManifest(),
      source: 'fallback',
    })
    const copy = JSON.stringify({ kit: { name: 'rocketflare' }, app: { slug: 'acme' } })
    expect(isRocketflareKit(copy)).toBe(false)
    await expect(readKitManifest(reader({ '.rocketflare.json': copy }))).rejects.toMatchObject({
      code: 'kit_manifest_missing',
    })
  })

  it('a broken launch.kit.json is an error, never papered over by the fallback', async () => {
    const files = { '.rocketflare.json': KIT_PROVENANCE }
    for (const bad of ['{not json', JSON.stringify({ schema: 1 })]) {
      const err = await readKitManifest(reader({ ...files, 'launch.kit.json': bad })).catch(e => e)
      expect(err).toBeInstanceOf(KitManifestError)
      expect(err).toMatchObject({ code: 'kit_manifest_invalid' })
      expect(err.message).toMatch(/^launch\.kit\.json is invalid: /)
    }
  })

  it('the default kit repo is the one the fallback describes', () => {
    expect(DEFAULT_TEMPLATE_PIN.repo).toBe('rocketflare-dev/rocketflare')
  })
})
