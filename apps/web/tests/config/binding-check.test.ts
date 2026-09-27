/**
 * `checkBindings` (Launch P2, the deploy gateway) — what a build may bind, from a table. Every row
 * is one wrangler config fragment on top of a valid staging config, against one environment's
 * recorded resources, and the exact refusal lines it must produce (`[]` = allowed). The kit's own
 * staging toml, as `write_config` leaves it, must pass whole; spike S5's `wrangler.evil.toml`
 * (another app's KV) must not.
 */

import type { AppEnvironmentResources } from '@launch/shared/launch-apps'
import { parse } from 'smol-toml'
import { describe, expect, it } from 'vitest'
import { checkBindings } from '@/api/services/launch/deploy/binding-check'
import { repoFixture } from '../helpers/launch-apps'

const WORKER = 'shop-staging'

const RESOURCES: AppEnvironmentResources = {
  kv: [{ binding: 'RATE_LIMIT_KV', id: 'kv-own', title: 'shop-rate-limit-staging' }],
  queues: [{ binding: 'JOBS_QUEUE', queue: 'shop-jobs-staging', id: 'q-own' }],
  r2: [{ binding: 'FILES', bucketName: 'shop-files-staging' }],
  workflows: [
    {
      binding: 'AGENT_RUN_WORKFLOW',
      name: 'shop-agent-run-staging',
      className: 'AgentRunWorkflow',
    },
  ],
  doMigrationTag: 'v1',
}

/** The kit 0.15 staging toml's shape, renamed to `shop` and pointed at the recorded ids. */
const BASE = `
name = "shop-staging"
main = "src/worker.ts"
compatibility_date = "2026-06-01"
compatibility_flags = ["nodejs_compat"]
workers_dev = false

[vars]
APP_ENV = "staging"
RELEASE_VERSION = "dev"

[placement]
mode = "smart"

[observability.logs]
enabled = true

[assets]
directory = "./dist/ui"
binding = "ASSETS"
not_found_handling = "single-page-application"
run_worker_first = ["/api", "/api/*"]

[[kv_namespaces]]
binding = "RATE_LIMIT_KV"
id = "kv-own"

[triggers]
crons = ["0 4 * * *"]

[[queues.producers]]
binding = "JOBS_QUEUE"
queue = "shop-jobs-staging"

[[queues.consumers]]
queue = "shop-jobs-staging"
max_batch_size = 10

[[durable_objects.bindings]]
name = "NOTIFICATIONS_HUB"
class_name = "NotificationsHub"

[[migrations]]
tag = "v1"
new_classes = ["NotificationsHub"]

[[r2_buckets]]
binding = "FILES"
bucket_name = "shop-files-staging"

[ai]
binding = "AI"
remote = true

[[workflows]]
name = "shop-agent-run-staging"
binding = "AGENT_RUN_WORKFLOW"
class_name = "AgentRunWorkflow"
`

/** `extra` appended as tables, or — a bare `key = …` — prepended as top-level keys. */
function check(extra: string, base = BASE) {
  const text = extra.startsWith('[') || !extra ? `${base}\n${extra}` : `${extra}\n${base}`
  return checkBindings(parse(text) as Record<string, unknown>, {
    workerName: WORKER,
    resources: RESOURCES,
  })
}

describe('checkBindings', () => {
  it('passes the kit staging config and maps every binding for the version upload', () => {
    const result = check('')
    expect(result.refused).toEqual([])
    expect(result.bindings.map(b => `${b.type}:${b.name}`)).toEqual([
      'kv_namespace:RATE_LIMIT_KV',
      'queue:JOBS_QUEUE',
      'r2_bucket:FILES',
      'durable_object_namespace:NOTIFICATIONS_HUB',
      'workflow:AGENT_RUN_WORKFLOW',
      'ai:AI',
      'assets:ASSETS',
      'plain_text:APP_ENV',
    ])
    expect(result.bindings.find(b => b.name === 'RATE_LIMIT_KV')).toEqual({
      type: 'kv_namespace',
      name: 'RATE_LIMIT_KV',
      namespace_id: 'kv-own',
    })
    // RELEASE_VERSION is the deployer's to set, never the toml's.
    expect(result.bindings.some(b => b.name === 'RELEASE_VERSION')).toBe(false)
    expect(result.crons).toEqual(['0 4 * * *'])
    expect(result.workflows).toEqual([
      {
        name: 'shop-agent-run-staging',
        binding: 'AGENT_RUN_WORKFLOW',
        className: 'AgentRunWorkflow',
      },
    ])
    expect(result.migrationTag).toBe('v1')
  })

  const rows: Array<[string, string, string[]]> = [
    // Another app's resources — the S1 attack, kind by kind.
    [
      'another app’s KV',
      '[[kv_namespaces]]\nbinding = "B_KV"\nid = "kv-other"',
      ['kv_namespaces B_KV=kv-other'],
    ],
    ['a KV with no id', '[[kv_namespaces]]\nbinding = "B_KV"', ['kv_namespaces B_KV=?']],
    [
      'another app’s R2',
      '[[r2_buckets]]\nbinding = "B_FILES"\nbucket_name = "bank-files"',
      ['r2_buckets B_FILES=bank-files'],
    ],
    [
      'a recorded bucket in a jurisdiction',
      '[[r2_buckets]]\nbinding = "EU"\nbucket_name = "shop-files-staging"\njurisdiction = "eu"',
      ['r2_buckets EU=shop-files-staging'],
    ],
    [
      'another app’s queue',
      '[[queues.producers]]\nbinding = "B_JOBS"\nqueue = "bank-jobs"',
      ['queues B_JOBS=bank-jobs'],
    ],
    [
      'consuming another app’s queue',
      '[[queues.consumers]]\nqueue = "bank-jobs"',
      ['queues.consumers bank-jobs'],
    ],
    [
      'a foreign dead-letter queue',
      '[[queues.consumers]]\nqueue = "shop-jobs-staging"\ndead_letter_queue = "bank-dlq"',
      ['queues.consumers shop-jobs-staging=dead_letter_queue bank-dlq'],
    ],
    [
      'another app’s workflow',
      '[[workflows]]\nname = "bank-agent-run"\nbinding = "B_RUN"\nclass_name = "AgentRunWorkflow"',
      ['workflows B_RUN=bank-agent-run'],
    ],
    [
      'a recorded workflow in another script',
      '[[workflows]]\nname = "shop-agent-run-staging"\nbinding = "X"\nclass_name = "AgentRunWorkflow"\nscript_name = "bank"',
      ['workflows X=shop-agent-run-staging@bank'],
    ],
    [
      'another script’s Durable Object',
      '[[durable_objects.bindings]]\nname = "B_HUB"\nclass_name = "NotificationsHub"\nscript_name = "bank"',
      ['durable_objects B_HUB=bank'],
    ],
    // Its own Durable Object named explicitly is fine.
    [
      'its own Durable Object by script name',
      '[[durable_objects.bindings]]\nname = "OWN"\nclass_name = "NotificationsHub"\nscript_name = "shop-staging"',
      [],
    ],
    // Kinds that are never allowed.
    [
      'a service binding',
      '[[services]]\nbinding = "BANK"\nservice = "bank"',
      ['services BANK=bank'],
    ],
    [
      'Hyperdrive (Launch’s own registry)',
      '[[hyperdrive]]\nbinding = "DB"\nid = "hd-launch"',
      ['hyperdrive DB=hd-launch'],
    ],
    ['D1', '[[d1_databases]]\nbinding = "D1"\ndatabase_id = "d1-x"', ['d1_databases D1=d1-x']],
    ['Vectorize', '[[vectorize]]\nbinding = "V"\nindex_name = "idx"', ['vectorize V=idx']],
    [
      'Analytics Engine',
      '[[analytics_engine_datasets]]\nbinding = "AE"\ndataset = "ds"',
      ['analytics_engine_datasets AE=ds'],
    ],
    [
      'send_email',
      '[[send_email]]\nname = "MAIL"\ndestination_address = "a@b.c"',
      ['send_email MAIL=a@b.c'],
    ],
    [
      'Secrets Store',
      '[[secrets_store_secrets]]\nbinding = "S"\nstore_id = "st"\nsecret_name = "x"',
      ['secrets_store_secrets S=st'],
    ],
    [
      'a dispatch namespace',
      '[[dispatch_namespaces]]\nbinding = "D"\nnamespace = "ns"',
      ['dispatch_namespaces D=ns'],
    ],
    [
      'an mTLS certificate',
      '[[mtls_certificates]]\nbinding = "M"\ncertificate_id = "c"',
      ['mtls_certificates M=c'],
    ],
    ['Browser Rendering', '[browser]\nbinding = "B"', ['browser B=?']],
    ['a tail consumer', '[[tail_consumers]]\nservice = "bank"', ['tail_consumers bank']],
    [
      'a key this check does not know',
      '[[shiny_new_binding]]\nbinding = "N"\nid = "n"',
      ['shiny_new_binding N=?'],
    ],
    // Hostnames are Launch's.
    [
      'a route',
      'routes = [{ pattern = "bank.clewro.com/*", zone_name = "clewro.com" }]',
      ['routes bank.clewro.com/*'],
    ],
    [
      'a custom domain',
      'routes = [{ pattern = "evil.example.com", custom_domain = true }]',
      ['routes evil.example.com'],
    ],
    ['a single route', 'route = "bank.clewro.com/*"', ['route bank.clewro.com/*']],
    // A Durable Object migration the placeholder never applied.
    [
      'a newer migration tag',
      '[[migrations]]\ntag = "v2"\nnew_sqlite_classes = ["Other"]',
      ['migrations tag=v2'],
    ],
  ]

  it.each(rows)('%s', (_label, extra, refused) => {
    expect(check(extra).refused).toEqual(refused)
  })

  it('refuses another Worker’s name', () => {
    const result = check('', BASE.replace('name = "shop-staging"', 'name = "bank-staging"'))
    expect(result.refused).toEqual(['name bank-staging'])
  })

  it('refuses every migration when none was recorded', () => {
    const result = checkBindings(parse(BASE) as Record<string, unknown>, {
      workerName: WORKER,
      resources: { ...RESOURCES, doMigrationTag: undefined },
    })
    expect(result.refused).toEqual(['migrations tag=v1'])
  })

  it('lists every refusal, not just the first', () => {
    const result = check(
      '[[services]]\nbinding = "A"\nservice = "a"\n[[hyperdrive]]\nbinding = "B"\nid = "b"'
    )
    expect(result.refused).toEqual(['services A=a', 'hyperdrive B=b'])
  })

  it('refuses spike S5’s wrangler.evil.toml (another app’s KV)', () => {
    const evil = parse(repoFixture('spikes/s5-deploy-via-launch/app-repo/wrangler.evil.toml'))
    const result = checkBindings(evil as Record<string, unknown>, {
      workerName: 'rfspike-app-staging',
      resources: { kv: [{ binding: 'RATE_LIMIT_KV', id: 'rfspike-own-kv' }] },
    })
    expect(result.refused).toEqual(['kv_namespaces RATE_LIMIT_KV=708597ddb2ab4ec3a05028334b9e9624'])
  })

  it('maps non-string vars to json bindings', () => {
    const result = check(
      '',
      BASE.replace('APP_ENV = "staging"', 'APP_ENV = "staging"\nLIMITS = { a = 1 }')
    )
    expect(result.bindings.find(b => b.name === 'LIMITS')).toEqual({
      type: 'json',
      name: 'LIMITS',
      json: { a: 1 },
    })
  })
})
