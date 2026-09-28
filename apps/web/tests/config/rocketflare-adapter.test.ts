/**
 * The Rocketflare adapter v1 (Launch P2, slice 2b) against the kit's REAL 0.15 tomls
 * (`tests/fixtures/rocketflare-0.15/`, byte copies of the tag), renamed by the kit's own rename
 * replacements the way the scaffold job leaves them: what they declare, what `writeConfig` writes
 * into them, the placeholder script built from them, and the scaffold check.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { describe, expect, it } from 'vitest'
import { ROCKETFLARE_CONTRACT_VERSION as IMPORT_CONTRACT_VERSION } from '@/api/services/launch/import'
import {
  ROCKETFLARE_CONTRACT_VERSION,
  rocketflareAdapter,
  scaffoldProblems,
} from '@/api/services/launch/rocketflare/adapter'
import { accountScopedNames, appResourceNames } from '@/api/services/launch/rocketflare/names'
import { placeholderScript } from '@/api/services/launch/rocketflare/placeholder-worker'
import {
  type ConfigValues,
  patchToml,
  resources,
  TomlPatchError,
  tomlPlaceholders,
  writeConfig,
} from '@/api/services/launch/rocketflare/toml'
import { applyReplacements, deriveNames } from '../../../../scripts/lib/rename-lib.mjs'

const FIXTURES = path.resolve(__dirname, '../fixtures/rocketflare-0.15')
const fixture = (file: string) => readFileSync(path.join(FIXTURES, file), 'utf8')

const SLUG = 'shop'
const DOMAIN = 'clewro.com'
const names = deriveNames(SLUG, 'Shop', { domain: DOMAIN })
/** The file as `node scripts/rename.mjs shop "Shop" --domain clewro.com` leaves it. */
const renamed = (file: string) => applyReplacements(fixture(file), names).text

const kit = {
  production: renamed('wrangler.toml'),
  staging: renamed('wrangler.staging.toml'),
}
/** `.rocketflare.json` with the kit commit recorded and the app block stamped (the scaffold job). */
function scaffoldedManifest(over: Record<string, unknown> = {}): string {
  const manifest = JSON.parse(fixture('.rocketflare.json'))
  manifest.kit.commit = 'c7fd5dfbf9cfbc197c60f1993f18d524ec28bd66'
  manifest.app = { slug: SLUG, display: 'Shop', domain: DOMAIN }
  return JSON.stringify({ ...manifest, ...over }, null, 2)
}

const values = (env: 'production' | 'staging'): ConfigValues => ({
  appUrl: appResourceNames(SLUG, env, DOMAIN).url,
  emailFrom: 'Shop <noreply@notifications.clewro.com>',
  kvIds: { RATE_LIMIT_KV: env === 'staging' ? 'b'.repeat(32) : 'a'.repeat(32) },
  oidc: { issuer: 'https://launch.clewro.com', clientId: `app_${env}` },
})

type Doc = Record<string, unknown>
const parsed = (text: string) => parseToml(text) as Doc
const vars = (doc: Doc) => doc.vars as Record<string, string>

describe('names', () => {
  it('computes every name of plan §1 per environment', () => {
    expect(appResourceNames('shop', 'production', 'clewro.com')).toEqual({
      workerName: 'shop',
      kvTitle: 'shop-rate-limit',
      queue: 'shop-jobs',
      r2Bucket: 'shop-files',
      workflow: 'shop-agent-run',
      resendKeyName: 'shop',
      host: 'shop.clewro.com',
      url: 'https://shop.clewro.com',
    })
    expect(appResourceNames('shop', 'staging', 'Clewro.com.')).toEqual({
      workerName: 'shop-staging',
      kvTitle: 'shop-rate-limit-staging',
      queue: 'shop-jobs-staging',
      r2Bucket: 'shop-files-staging',
      workflow: 'shop-agent-run-staging',
      resendKeyName: 'shop-staging',
      host: 'shop-staging.clewro.com',
      url: 'https://shop-staging.clewro.com',
    })
  })

  it('agree with what the kit rename writes into the tomls', () => {
    for (const env of ['production', 'staging'] as const) {
      const declared = resources(kit[env])
      const want = accountScopedNames(SLUG, env)
      expect(declared.workerName).toBe(want.workerName)
      expect(declared.queues).toEqual([{ binding: 'JOBS_QUEUE', queue: want.queue }])
      expect(declared.r2).toEqual([{ binding: 'FILES', bucketName: want.r2Bucket }])
      expect(declared.workflows).toEqual([
        { binding: 'AGENT_RUN_WORKFLOW', name: want.workflow, className: 'AgentRunWorkflow' },
      ])
    }
  })
})

describe('the contract version', () => {
  it('lives on the adapter and is re-exported where the import records it', () => {
    expect(ROCKETFLARE_CONTRACT_VERSION).toBe('1')
    expect(IMPORT_CONTRACT_VERSION).toBe(ROCKETFLARE_CONTRACT_VERSION)
    expect(rocketflareAdapter.contractVersion).toBe('1')
    expect(rocketflareAdapter.scaffold.workflowFile).toBe('launch-scaffold.yml')
  })
})

describe('resources', () => {
  it('reads everything the pipeline creates, registers and routes', () => {
    const declared = resources(kit.staging)
    expect(declared).toMatchObject({
      workerName: 'shop-staging',
      compatibilityDate: '2026-06-01',
      compatibilityFlags: ['nodejs_compat'],
      kv: [{ binding: 'RATE_LIMIT_KV', id: null, placeholder: '<KV_RATE_LIMIT_STAGING_ID>' }],
      queueConsumers: [
        {
          queue: 'shop-jobs-staging',
          settings: { batch_size: 10, max_wait_time_ms: 5000, max_retries: 3, retry_delay: 60 },
        },
      ],
      durableObjects: [{ binding: 'NOTIFICATIONS_HUB', className: 'NotificationsHub' }],
      migrations: [{ tag: 'v1', newClasses: ['NotificationsHub'] }],
      doMigrationTag: 'v1',
      crons: ['0 4 * * *'],
      unsupported: [],
    })
    expect(declared.vars.APP_ENV).toBe('staging')
  })

  it('names a binding kind Launch cannot provision', () => {
    const withD1 = `${kit.production}\n[[d1_databases]]\nbinding = "DB"\ndatabase_id = "x"\n`
    expect(resources(withD1).unsupported).toEqual(['d1_databases'])
  })
})

describe('writeConfig', () => {
  const written = {
    production: writeConfig(kit.production, 'production', values('production')),
    staging: writeConfig(kit.staging, 'staging', values('staging')),
  }

  it('fills every placeholder and writes plan §0.4’s vars', () => {
    for (const env of ['production', 'staging'] as const) {
      expect(tomlPlaceholders(written[env])).toEqual([])
      const doc = parsed(written[env])
      expect(vars(doc)).toMatchObject({
        APP_ENV: env,
        APP_URL: appResourceNames(SLUG, env, DOMAIN).url,
        EMAIL_FROM: 'Shop <noreply@notifications.clewro.com>',
        TENANCY_MODE: 'single',
        SIGNUP_MODE: 'open',
        OIDC_ISSUER: 'https://launch.clewro.com',
        OIDC_CLIENT_ID: `app_${env}`,
        AUTH_OIDC_ONLY: 'true',
        DATABASE_DRIVER: 'neon',
      })
      expect(doc.workers_dev).toBe(false)
      expect(doc.routes).toBeUndefined()
      expect(doc.hyperdrive).toBeUndefined()
      expect(doc.kv_namespaces).toEqual([
        { binding: 'RATE_LIMIT_KV', id: values(env).kvIds.RATE_LIMIT_KV },
      ])
    }
    // The kit's comments survive: the patch is byte-level, not a re-serialisation.
    expect(written.production).toContain('# Background jobs (D7)')
    expect(written.staging).not.toContain('workers_dev = true')
    expect(written.staging).not.toContain('# Fallback host')
  })

  it('keeps the kit’s parity rules: same keys, bindings and classes; differing scoped names', () => {
    const prod = parsed(written.production)
    const staging = parsed(written.staging)
    expect(Object.keys(vars(staging)).sort()).toEqual(Object.keys(vars(prod)).sort())
    for (const key of [
      'main',
      'compatibility_date',
      'compatibility_flags',
      'placement',
      'observability',
      'assets',
      'triggers',
      'migrations',
      'ai',
      'durable_objects',
      'workers_dev',
    ]) {
      expect(staging[key], key).toEqual(prod[key])
    }
    expect(staging.name).toBe(`${prod.name}-staging`)
  })

  it('staging and production differ ONLY in account-scoped names, ids and URLs', () => {
    /** Each document with its per-environment values blanked out. */
    const normalise = (text: string) => {
      const doc = parsed(text)
      const v = vars(doc)
      for (const key of ['APP_ENV', 'APP_URL', 'OIDC_CLIENT_ID']) v[key] = '*'
      doc.name = '*'
      for (const kv of doc.kv_namespaces as Doc[]) kv.id = '*'
      const queues = doc.queues as { producers: Doc[]; consumers: Doc[] }
      for (const q of [...queues.producers, ...queues.consumers]) q.queue = '*'
      for (const r2 of doc.r2_buckets as Doc[]) r2.bucket_name = '*'
      for (const wf of doc.workflows as Doc[]) wf.name = '*'
      return doc
    }
    expect(normalise(written.staging)).toEqual(normalise(written.production))
  })

  it('is idempotent, and never overwrites a different real id', () => {
    expect(writeConfig(written.staging, 'staging', values('staging'))).toBe(written.staging)
    expect(() =>
      writeConfig(written.staging, 'staging', {
        ...values('staging'),
        kvIds: { RATE_LIMIT_KV: 'c'.repeat(32) },
      })
    ).toThrow(TomlPatchError)
  })

  it('refuses to leave a placeholder behind', () => {
    expect(() => writeConfig(kit.staging, 'staging', { ...values('staging'), kvIds: {} })).toThrow(
      /no KV namespace id for RATE_LIMIT_KV/
    )
    const withD1 = kit.production.replace(
      '[[kv_namespaces]]',
      '[[d1_databases]]\nbinding = "DB"\ndatabase_id = "<D1_ID>"\n\n[[kv_namespaces]]'
    )
    expect(() => writeConfig(withD1, 'production', values('production'))).toThrow(
      /still has <D1_ID>/
    )
  })

  it('escapes a display name that would break the TOML string', () => {
    const out = writeConfig(kit.production, 'production', {
      ...values('production'),
      emailFrom: 'The "Best" Shop <noreply@x.com>',
    })
    expect(vars(parsed(out)).EMAIL_FROM).toBe('The "Best" Shop <noreply@x.com>')
  })
})

describe('the ported patcher', () => {
  it('writes a plugin’s crons and prefixes even when a comment already quotes them', () => {
    // The kit's tomls mention "/cubejs-api", "/mcp" and "15 * * * *" in comments; the kit's own
    // appendToArray (0.15) counted those as present and never wrote them.
    const out = patchToml(kit.production, {
      crons: ['15 * * * *'],
      workerFirstPrefixes: ['/cubejs-api', '/mcp'],
    })
    const doc = parsed(out)
    expect((doc.triggers as Doc).crons).toEqual(['0 4 * * *', '15 * * * *'])
    expect((doc.assets as Doc).run_worker_first).toEqual([
      '/api',
      '/api/*',
      '/auth',
      '/auth/*',
      '/ws',
      '/ws/*',
      '/cubejs-api',
      '/cubejs-api/*',
      '/mcp',
      '/mcp/*',
    ])
    expect(patchToml(out, { crons: ['15 * * * *'] })).toBe(out)
  })
})

describe('placeholderScript', () => {
  it('carries the toml’s DO migration (v1 NotificationsHub) and a stub for every class', () => {
    const script = placeholderScript(written())
    expect(script.metadata).toMatchObject({
      main_module: 'placeholder.js',
      compatibility_date: '2026-06-01',
      compatibility_flags: ['nodejs_compat'],
      migrations: { new_tag: 'v1', steps: [{ new_classes: ['NotificationsHub'] }] },
      bindings: [
        {
          type: 'durable_object_namespace',
          name: 'NOTIFICATIONS_HUB',
          class_name: 'NotificationsHub',
        },
      ],
    })
    expect(script.metadata.migrations).not.toHaveProperty('old_tag')
    expect(script.migrationTag).toBe('v1')
    expect(script.durableObjectClasses).toEqual(['NotificationsHub'])
    expect(script.workflowClasses).toEqual(['AgentRunWorkflow'])
    const source = String(script.modules[0]?.content)
    expect(source).toContain('export class NotificationsHub extends DurableObject')
    expect(source).toContain('export class AgentRunWorkflow extends WorkflowEntrypoint')
    expect(source).toContain('status: 503')
    // Cloudflare refuses a queue consumer on a script with no queue handler (11001).
    expect(source).toContain('async queue(batch)')
    expect(source).toContain('batch.retryAll(')
    expect(source).toContain('async scheduled()')
  })

  it('sends nothing for a tag the script already has, and only what is newer otherwise', () => {
    expect(placeholderScript(written(), { appliedTag: 'v1' }).metadata).not.toHaveProperty(
      'migrations'
    )
    const v2 = `${written()}\n[[migrations]]\ntag = "v2"\nnew_sqlite_classes = ["Later"]\n`
    const script = placeholderScript(v2, { appliedTag: 'v1' })
    expect(script.metadata.migrations).toEqual({
      old_tag: 'v1',
      new_tag: 'v2',
      steps: [{ new_sqlite_classes: ['Later'] }],
    })
    expect(script.durableObjectClasses).toEqual(['NotificationsHub', 'Later'])
    expect(() => placeholderScript(written(), { appliedTag: 'v9' })).toThrow(/v9/)
  })

  function written() {
    return writeConfig(kit.staging, 'staging', values('staging'))
  }
})

describe('scaffoldProblems', () => {
  const files = { manifest: scaffoldedManifest(), ...kit }
  const expected = { slug: SLUG, tag: '0.15.0', commit: 'c7fd5dfbf9cfbc197c60f1993f18d524ec28bd66' }

  it('accepts the kit renamed to the app', () => {
    expect(scaffoldProblems(files, expected)).toEqual([])
    // …with a plugin's own account-scoped resources, as long as they are the app's.
    const withPlugin = patchToml(kit.staging, {
      bindings: [{ type: 'queue', binding: 'X_QUEUE', name: 'shop-x-staging', consumer: true }],
    })
    expect(scaffoldProblems({ ...files, staging: withPlugin }, expected)).toEqual([])
  })

  it('names every way the scaffold is not the app Launch asked for', () => {
    expect(scaffoldProblems(files, { ...expected, slug: 'other' })).toEqual(
      expect.arrayContaining([
        '.rocketflare.json names the app shop, not other',
        'apps/web/wrangler.toml: name is shop, not other',
        'apps/web/wrangler.staging.toml: JOBS_QUEUE is shop-jobs-staging, not other-jobs-staging',
      ])
    )
    expect(scaffoldProblems(files, { ...expected, tag: '0.16.0' })).toEqual([
      '.rocketflare.json says kit 0.15.0, not 0.16.0',
    ])
    expect(scaffoldProblems(files, { ...expected, commit: 'f'.repeat(40) })).toHaveLength(1)
    // The unrenamed kit is not a scaffold at all.
    const unrenamed = {
      manifest: fixture('.rocketflare.json'),
      production: fixture('wrangler.toml'),
      staging: fixture('wrangler.staging.toml'),
    }
    expect(scaffoldProblems(unrenamed, expected).length).toBeGreaterThan(5)
    expect(scaffoldProblems({ ...files, manifest: 'nope' }, expected)).toEqual([
      '.rocketflare.json is not valid JSON',
    ])
    const foreign = patchToml(kit.staging, {
      bindings: [{ type: 'r2', binding: 'OTHER', name: 'someone-elses-bucket' }],
    })
    expect(scaffoldProblems({ ...files, staging: foreign }, expected)).toEqual([
      "apps/web/wrangler.staging.toml: someone-elses-bucket is not one of shop-staging's names",
    ])
  })
})
