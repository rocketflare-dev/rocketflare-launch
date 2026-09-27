/**
 * The binding check (Launch P2, spec/08 "Launch deploys, so Launch is the gate") — the reason CI
 * holds no Cloudflare token. A token that can deploy a Worker can bind ANY resource in the account
 * into it (spike S1: another app's KV, R2, queue, Worker, Launch's own Hyperdrive), so the deploy
 * gateway parses the build's wrangler config ITSELF and lets through only what the registry
 * recorded for this app and environment. Ported from the S5 spike's `checkBindings` and widened
 * to what a kit app declares.
 *
 * Pure: config in, verdict out, no I/O — `tests/config/binding-check.test.ts` drives it from a
 * table. The caller refuses the upload when `refused` is non-empty, BEFORE any credential exists.
 *
 * **Allowed**, each against `app_environments.resources` (ids recorded when created, never looked
 * up by name):
 *
 * - `name` equal to the environment's `worker_name`;
 * - `kv_namespaces` whose `id` is recorded;
 * - `queues.producers` and `queues.consumers` naming a recorded queue;
 * - `r2_buckets` whose `bucket_name` is recorded;
 * - `durable_objects.bindings` with no `script_name`, or this Worker's own;
 * - `workflows` whose `name` is recorded, with no `script_name` or this Worker's own;
 * - `ai`, `assets`, `[vars]`, and the settings that bind nothing (`compatibility_*`, `placement`,
 *   `observability`, `limits`, `triggers`, the build options).
 *
 * **Refused**, everything else — any binding kind not above (`services`, `hyperdrive`,
 * `d1_databases`, `vectorize`, …, and any top-level key this module does not know, because an
 * unknown key may be a binding kind Cloudflare added), any `route`/`routes` (a custom domain is a
 * route; Launch owns the app's hostnames), and a `[[migrations]]` tag newer than the one the
 * placeholder applied (the Versions API cannot apply a Durable Object migration).
 *
 * Each refusal is one line the job's log shows: `"<kind> <binding>=<value>"`, or `"<kind> <value>"`
 * for what has no binding name (`name`, `routes`, `migrations`, a consumer).
 */
import type { AppEnvironmentResources } from '@launch/shared/launch-apps'

/** A Cloudflare metadata binding (`{ type, name, … }`), exactly as a version upload takes it. */
export type WorkerBinding = { type: string; name: string } & Record<string, unknown>

/** The Workflows a build binds, as the gateway re-registers them at `activate`. */
export interface CheckedWorkflow {
  name: string
  binding: string
  className: string
}

export interface BindingCheckResult {
  /** The metadata bindings to upload (vars as `plain_text`/`json`, never a `secret_text`). */
  bindings: WorkerBinding[]
  /** One line per refusal; empty = the build may be uploaded. */
  refused: string[]
  /** `[triggers] crons`, applied at `activate`. */
  crons: string[]
  workflows: CheckedWorkflow[]
  /** The newest `[[migrations]]` tag the build carries, if any. */
  migrationTag: string | null
}

export interface BindingCheckTarget {
  /** The environment's `worker_name`. */
  workerName: string
  resources: AppEnvironmentResources
}

/** The binding kinds this check lets through (each checked below) — everything else is refused. */
const ALLOWED_BINDING_KEYS = new Set([
  'kv_namespaces',
  'queues',
  'r2_buckets',
  'durable_objects',
  'migrations',
  'workflows',
  'ai',
  'assets',
  'vars',
])

/**
 * Top-level keys that bind nothing: identity, compatibility, build options and script settings.
 * A key in neither set is refused, so a binding kind Cloudflare adds later is refused until
 * someone decides it here.
 */
const INERT_KEYS = new Set([
  '$schema',
  'name',
  'main',
  'account_id',
  'compatibility_date',
  'compatibility_flags',
  'workers_dev',
  'preview_urls',
  'placement',
  'observability',
  'limits',
  'triggers',
  'logpush',
  'keep_vars',
  'minify',
  'no_bundle',
  'rules',
  'build',
  'base_dir',
  'find_additional_modules',
  'preserve_file_names',
  'upload_source_maps',
  'send_metrics',
  'dev',
  'alias',
  'define',
  'tsconfig',
  'usage_model',
  // Named environments are never applied: the gateway reads only the top level of the toml the
  // job sent, which for the kit is the whole file (one toml per environment).
  'env',
])

/** Refused outright, with the field that best names what the binding points at. */
const REFUSED_KINDS: Record<string, string[]> = {
  services: ['service'],
  hyperdrive: ['id'],
  d1_databases: ['database_id', 'database_name'],
  vectorize: ['index_name'],
  analytics_engine_datasets: ['dataset'],
  send_email: ['destination_address'],
  secrets_store_secrets: ['store_id', 'secret_name'],
  dispatch_namespaces: ['namespace'],
  mtls_certificates: ['certificate_id'],
  browser: [],
  tail_consumers: ['service'],
  unsafe: [],
  version_metadata: [],
  images: [],
  pipelines: ['pipeline'],
  route: [],
  routes: [],
}

type Table = Record<string, unknown>

const isTable = (v: unknown): v is Table => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

/** An array of tables, a single table, or nothing — how wrangler lets most sections be written. */
function entries(v: unknown): Table[] {
  if (Array.isArray(v)) return v.filter(isTable)
  if (isTable(v)) return [v]
  return []
}

/** `"<kind> <binding>=<value>"`, or `"<kind> <value>"` when there is no binding name. */
function refusal(kind: string, binding: string | undefined, value: unknown): string {
  const shown =
    typeof value === 'string' ? value : value === undefined ? '?' : JSON.stringify(value)
  return binding ? `${kind} ${binding}=${shown}` : `${kind} ${shown}`
}

/** Every binding of a refused kind, however the section is shaped. */
function refuseKind(kind: string, value: unknown, fields: string[]): string[] {
  if (kind === 'route' || kind === 'routes') {
    const list = Array.isArray(value) ? value : [value]
    return list.map(r => refusal(kind, undefined, isTable(r) ? (r.pattern ?? r) : r))
  }
  const list = isTable(value) && Array.isArray(value.bindings) ? value.bindings : value
  const items = entries(list)
  if (items.length === 0) return [refusal(kind, undefined, value)]
  return items.map(item => {
    const binding = str(item.binding) ?? str(item.name)
    const field = fields.find(f => item[f] !== undefined)
    return refusal(kind, binding, field ? item[field] : binding ? undefined : item)
  })
}

/**
 * The tags of `[[migrations]]` after the one the placeholder applied (`recorded`). With nothing
 * recorded, every tag is new.
 */
function newerMigrationTags(tags: string[], recorded: string | undefined): string[] {
  if (tags.length === 0) return []
  const at = recorded ? tags.indexOf(recorded) : -1
  return at === -1 ? tags : tags.slice(at + 1)
}

/** `[vars]` as metadata bindings. `RELEASE_VERSION` is the deployer's to set (DEPLOYER.md). */
function varBindings(vars: unknown): WorkerBinding[] {
  if (!isTable(vars)) return []
  const out: WorkerBinding[] = []
  for (const [name, value] of Object.entries(vars)) {
    if (name === 'RELEASE_VERSION') continue
    out.push(
      typeof value === 'string'
        ? { type: 'plain_text', name, text: value }
        : { type: 'json', name, json: value }
    )
  }
  return out
}

/**
 * Check a parsed wrangler config against what the registry recorded for one environment. See the
 * header for the rules; the result lists every refusal, not just the first.
 */
export function checkBindings(config: Table, target: BindingCheckTarget): BindingCheckResult {
  const { workerName, resources } = target
  const refused: string[] = []
  const bindings: WorkerBinding[] = []
  const workflows: CheckedWorkflow[] = []

  if (config.name !== workerName) refused.push(refusal('name', undefined, config.name))

  for (const [key, value] of Object.entries(config)) {
    if (ALLOWED_BINDING_KEYS.has(key) || INERT_KEYS.has(key)) continue
    refused.push(...refuseKind(key, value, REFUSED_KINDS[key] ?? []))
  }

  // KV — by recorded namespace id; the binding name is the app's own business.
  const kvIds = new Set((resources.kv ?? []).map(k => k.id))
  for (const kv of entries(config.kv_namespaces)) {
    const binding = str(kv.binding) ?? '?'
    const id = str(kv.id)
    if (id && kvIds.has(id))
      bindings.push({ type: 'kv_namespace', name: binding, namespace_id: id })
    else refused.push(refusal('kv_namespaces', binding, kv.id))
  }

  // Queues — producers bind, consumers are registered by Launch; both must name a recorded queue.
  const queueNames = new Set((resources.queues ?? []).map(q => q.queue))
  const queues = isTable(config.queues) ? config.queues : {}
  for (const [key, value] of Object.entries(queues)) {
    if (key !== 'producers' && key !== 'consumers')
      refused.push(refusal(`queues.${key}`, undefined, value))
  }
  for (const producer of entries(queues.producers)) {
    const binding = str(producer.binding) ?? '?'
    const queue = str(producer.queue)
    if (queue && queueNames.has(queue)) {
      bindings.push({
        type: 'queue',
        name: binding,
        queue_name: queue,
        ...(producer.delivery_delay !== undefined
          ? { delivery_delay: producer.delivery_delay }
          : {}),
      })
    } else refused.push(refusal('queues', binding, producer.queue))
  }
  for (const consumer of entries(queues.consumers)) {
    const queue = str(consumer.queue)
    if (!queue || !queueNames.has(queue))
      refused.push(refusal('queues.consumers', undefined, consumer.queue))
    if (consumer.dead_letter_queue !== undefined) {
      const dlq = str(consumer.dead_letter_queue)
      if (!dlq || !queueNames.has(dlq)) {
        refused.push(refusal('queues.consumers', queue, `dead_letter_queue ${dlq ?? '?'}`))
      }
    }
  }

  // R2 — by recorded bucket name.
  const buckets = new Set((resources.r2 ?? []).map(b => b.bucketName))
  for (const r2 of entries(config.r2_buckets)) {
    const binding = str(r2.binding) ?? '?'
    const bucket = str(r2.bucket_name)
    if (bucket && buckets.has(bucket) && r2.jurisdiction === undefined) {
      bindings.push({ type: 'r2_bucket', name: binding, bucket_name: bucket })
    } else refused.push(refusal('r2_buckets', binding, r2.bucket_name))
  }

  // Durable Objects — only this Worker's own classes; another script's namespace is its data.
  const durableObjects = isTable(config.durable_objects) ? config.durable_objects : {}
  for (const d of entries(durableObjects.bindings)) {
    const name = str(d.name) ?? '?'
    const className = str(d.class_name)
    const script = d.script_name
    if (
      className &&
      (script === undefined || script === workerName) &&
      d.environment === undefined
    ) {
      bindings.push({ type: 'durable_object_namespace', name, class_name: className })
    } else refused.push(refusal('durable_objects', name, script ?? d.environment ?? className))
  }

  // Durable Object migrations — only those the placeholder already applied.
  const tags = entries(config.migrations)
    .map(m => str(m.tag))
    .filter((t): t is string => Boolean(t))
  for (const tag of newerMigrationTags(tags, resources.doMigrationTag)) {
    refused.push(refusal('migrations', undefined, `tag=${tag}`))
  }

  // Workflows — a recorded name, running this Worker's own class.
  const workflowNames = new Set((resources.workflows ?? []).map(w => w.name))
  for (const w of entries(config.workflows)) {
    const binding = str(w.binding) ?? '?'
    const name = str(w.name)
    const className = str(w.class_name)
    const script = w.script_name
    if (
      name &&
      className &&
      workflowNames.has(name) &&
      (script === undefined || script === workerName)
    ) {
      bindings.push({ type: 'workflow', name: binding, workflow_name: name, class_name: className })
      workflows.push({ name, binding, className })
    } else {
      refused.push(
        refusal(
          'workflows',
          binding,
          script && script !== workerName ? `${name}@${String(script)}` : w.name
        )
      )
    }
  }

  if (isTable(config.ai)) {
    const binding = str(config.ai.binding)
    if (binding) bindings.push({ type: 'ai', name: binding })
    else refused.push(refusal('ai', undefined, config.ai))
  }
  if (isTable(config.assets) && str(config.assets.binding)) {
    bindings.push({ type: 'assets', name: config.assets.binding as string })
  }
  bindings.push(...varBindings(config.vars))

  const triggers = isTable(config.triggers) ? config.triggers : {}
  const crons = Array.isArray(triggers.crons)
    ? triggers.crons.filter((c): c is string => typeof c === 'string')
    : []

  return { bindings, refused, crons, workflows, migrationTag: tags.at(-1) ?? null }
}
