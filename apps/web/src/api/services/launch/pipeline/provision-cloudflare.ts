/**
 * The app's Cloudflare resources (Launch P2, plan §3 2c steps 5 and 8), per environment:
 *
 * - **Storage** (`cloudflare`): every KV namespace, queue and R2 bucket the scaffolded toml
 *   declares (D36: the kit's bindings, not a fixed set — Rocketflare's are one of each), each
 *   RECORDED the moment Cloudflare returns its id. A queue or bucket takes the name the toml gives
 *   it (the kit's init wrote it by the naming rule, and `scaffold.verify` checked it); a KV
 *   namespace has none in the toml, so it is created under its title (`names.ts` `kvTitleOf`). A
 *   retry that meets a name conflict adopts the existing resource only when no other app of the
 *   tenant records that id — the name is the app's (slugs are globally unique), but an id another
 *   app holds is never taken over.
 * - **Placeholders** (`placeholders`): the placeholder Worker script (its PUT applies the toml's
 *   Durable Object migrations, which a version upload cannot), `workers.dev` off, the Workflows and
 *   queue consumers the Versions API never creates, and the `<host>/*` route.
 *
 * External id keys are `<kind>.<environment>[.<name>]` — `teardown-steps.ts` gathers them back by
 * the same prefixes, from every create run of the app. The FIRST resource of each kind keeps the
 * key it had before D36 (`kv.<env>` + `kvTitle.<env>`, `queue.<env>` + `queueName.<env>`,
 * `r2.<env>`); any further one is keyed by its binding (KV) or name (`kv.<env>.<binding>`,
 * `queue.<env>.<name>`, `r2.<env>.<name>`) — {@link storageKeys}.
 */
import type { AppEnvironmentName } from '@launch/shared/launch-apps'
import { parse as parseToml } from 'smol-toml'
import {
  CloudflareApiError,
  type CloudflareClient,
  type CloudflareQueue,
  type CloudflareQueueConsumerSettings,
  isCloudflareNotFound,
} from '../cloudflare'
import type { WranglerEnvironment } from '../kits/app-manifest'
import type { TomlResources } from '../kits/toml'
import type { StepContext } from './operations'
import type { AppResourceNames, PlaceholderScript } from './ports'

export interface CloudflareTarget {
  client: CloudflareClient
  accountId: string
  zoneId: string | null
}

/** "Is this id already some OTHER app's?" — answered from the registry by the caller. */
export type ClaimedElsewhere = (kind: 'kv' | 'queue' | 'r2', id: string) => Promise<boolean>

/** What one environment's toml asks Launch to create: KV (by binding, with its title), queues, buckets. */
export interface StoragePlan {
  kv: Array<{ binding: string; title: string }>
  queues: string[]
  r2: string[]
}

/** What exists for one environment, as recorded. */
export interface EnvironmentStorage {
  kv: Array<{ binding: string; title: string; id: string }>
  queues: Array<{ name: string; id: string }>
  r2: string[]
}

export const idKey = (kind: string, env: AppEnvironmentName, name?: string) =>
  name ? `${kind}.${env}.${name}` : `${kind}.${env}`

/**
 * The plan for one toml: each KV binding with the title `kvTitle` gives it, each queue a producer
 * or consumer names (once), each bucket.
 */
export function storagePlan(
  declared: Pick<TomlResources, 'kv' | 'queues' | 'queueConsumers' | 'r2'>,
  kvTitle: (binding: string) => string
): StoragePlan {
  const uniq = (list: string[]) => [...new Set(list)]
  return {
    kv: declared.kv.map(k => ({ binding: k.binding, title: kvTitle(k.binding) })),
    queues: uniq([
      ...declared.queues.map(q => q.queue),
      ...declared.queueConsumers.map(q => q.queue),
    ]),
    r2: uniq(declared.r2.map(b => b.bucketName)),
  }
}

/** The external-id keys of the `index`th resource of a kind (see the header). */
export function storageKeys(env: AppEnvironmentName, index: number, name: string) {
  const at = (kind: string) => (index === 0 ? idKey(kind, env) : idKey(kind, env, name))
  return {
    kv: at('kv'),
    kvTitle: at('kvTitle'),
    queue: at('queue'),
    queueName: at('queueName'),
    r2: at('r2'),
  }
}

/** What `cloudflare` recorded for `plan` in `ids` (missing ones left out). */
export function recordedStorage(
  ids: Record<string, string | undefined>,
  env: AppEnvironmentName,
  plan: StoragePlan
): EnvironmentStorage {
  return {
    kv: plan.kv.flatMap(({ binding }, i) => {
      const keys = storageKeys(env, i, binding)
      const id = ids[keys.kv]
      return id ? [{ binding, id, title: ids[keys.kvTitle] ?? '' }] : []
    }),
    queues: plan.queues.flatMap((name, i) => {
      const keys = storageKeys(env, i, name)
      const id = ids[keys.queue]
      return id && (ids[keys.queueName] ?? name) === name ? [{ name, id }] : []
    }),
    r2: plan.r2.filter((name, i) => ids[storageKeys(env, i, name).r2] === name),
  }
}

function isConflict(err: unknown): boolean {
  if (!(err instanceof CloudflareApiError)) return false
  return err.status === 409 || /already exists|already taken/i.test(err.message)
}

async function adopt(
  claimedElsewhere: ClaimedElsewhere,
  kind: 'kv' | 'queue' | 'r2',
  name: string,
  id: string | null
): Promise<string> {
  if (!id) throw new Error(`Cloudflare says ${kind} ${name} exists, but it cannot be found`)
  if (await claimedElsewhere(kind, id)) {
    throw new Error(`${kind} ${name} (${id}) already belongs to another app`)
  }
  return id
}

/**
 * Every KV namespace, queue and bucket of `plan` for one environment, each recorded as soon as it
 * exists — KV first, then queues, then buckets, in the toml's order.
 */
export async function provisionStorage(
  cf: CloudflareTarget,
  ctx: StepContext,
  env: AppEnvironmentName,
  plan: StoragePlan,
  claimedElsewhere: ClaimedElsewhere
): Promise<EnvironmentStorage> {
  const { client, accountId } = cf
  const made: Record<string, string> = { ...ctx.prior }
  const record = async (ids: Record<string, string>) => {
    Object.assign(made, ids)
    await ctx.record(ids)
  }

  for (const [i, { binding, title }] of plan.kv.entries()) {
    const keys = storageKeys(env, i, binding)
    if (ctx.prior[keys.kv]) continue
    let kvId: string
    try {
      kvId = (await client.createKvNamespace(accountId, title)).id
    } catch (err) {
      if (!isConflict(err) && !/10014/.test(String((err as Error).message))) throw err
      const found = await client.findKvByTitle(accountId, title)
      kvId = await adopt(claimedElsewhere, 'kv', title, found?.id ?? null)
    }
    await record({ [keys.kv]: kvId, [keys.kvTitle]: title })
  }

  for (const [i, name] of plan.queues.entries()) {
    const keys = storageKeys(env, i, name)
    if (ctx.prior[keys.queue]) continue
    let queueId: string
    try {
      queueId = (await client.createQueue(accountId, name)).queue_id
    } catch (err) {
      if (!isConflict(err)) throw err
      const list = await client.get<CloudflareQueue[]>(
        `/accounts/${encodeURIComponent(accountId)}/queues?per_page=100`
      )
      const found = list.find(q => q.queue_name === name)
      queueId = await adopt(claimedElsewhere, 'queue', name, found?.queue_id ?? null)
    }
    await record({ [keys.queue]: queueId, [keys.queueName]: name })
  }

  for (const [i, name] of plan.r2.entries()) {
    const keys = storageKeys(env, i, name)
    if (ctx.prior[keys.r2]) continue
    try {
      await client.createR2Bucket(accountId, name)
    } catch (err) {
      if (!isConflict(err)) throw err
      await adopt(claimedElsewhere, 'r2', name, name)
    }
    await record({ [keys.r2]: name })
  }

  return recordedStorage(made, env, plan)
}

/** One `[[queues.consumers]]` block of a toml, as the consumer API wants it. */
export interface TomlQueueConsumer {
  queue: string
  settings: CloudflareQueueConsumerSettings
  deadLetterQueue?: string
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** The toml's queue consumers (wrangler's keys → the API's). */
export function tomlQueueConsumers(tomlText: string): TomlQueueConsumer[] {
  const doc = parseToml(tomlText) as { queues?: { consumers?: unknown } }
  const list = Array.isArray(doc.queues?.consumers) ? doc.queues.consumers : []
  return list.flatMap(raw => {
    const t = raw as Record<string, unknown>
    if (typeof t.queue !== 'string') return []
    const timeout = num(t.max_batch_timeout)
    const settings: CloudflareQueueConsumerSettings = {
      batch_size: num(t.max_batch_size),
      max_retries: num(t.max_retries),
      max_wait_time_ms: timeout === undefined ? undefined : timeout * 1000,
      retry_delay: num(t.retry_delay),
    }
    return [
      {
        queue: t.queue,
        settings: Object.fromEntries(
          Object.entries(settings).filter(([, v]) => v !== undefined)
        ) as CloudflareQueueConsumerSettings,
        ...(typeof t.dead_letter_queue === 'string'
          ? { deadLetterQueue: t.dead_letter_queue }
          : {}),
      },
    ]
  })
}

export interface PlaceholderResult {
  routeId: string
  queueConsumers: { queue: string; queueId: string; consumerId: string; scriptName: string }[]
  workflows: string[]
  migrationTag: string | null
}

/**
 * The placeholder Worker for one environment and everything that attaches to it. `queueIds` maps
 * the queue NAMES this app created to their ids — a consumer on any other queue is refused.
 */
export async function putPlaceholder(
  cf: CloudflareTarget,
  ctx: StepContext,
  input: {
    env: AppEnvironmentName
    names: AppResourceNames
    tomlText: string
    toml: WranglerEnvironment
    script: PlaceholderScript
    queueIds: Record<string, string>
  }
): Promise<PlaceholderResult> {
  const { client, accountId } = cf
  const { env, names } = input
  if (!cf.zoneId) {
    throw new Error('The Cloudflare credential has no zone id — run its check in Setup')
  }
  const zoneId = cf.zoneId
  if (input.toml.workerName !== names.workerName) {
    throw new Error(
      `The ${env} toml names Worker ${input.toml.workerName}, expected ${names.workerName}`
    )
  }

  await client.putWorkerScript(
    accountId,
    names.workerName,
    input.script.metadata,
    input.script.modules
  )
  // The tag is recorded with the script: a retry must not send an applied migration again.
  await ctx.record({
    [idKey('script', env)]: names.workerName,
    ...(input.script.migrationTag
      ? { [idKey('migrationTag', env)]: input.script.migrationTag }
      : {}),
  })
  await client.setWorkersDevSubdomain(accountId, names.workerName, false)

  const workflows: string[] = []
  for (const wf of input.toml.resources.workflows ?? []) {
    await client.putWorkflow(accountId, wf.name, {
      scriptName: names.workerName,
      className: wf.className,
    })
    workflows.push(wf.name)
    await ctx.record({ [idKey('workflow', env, wf.name)]: wf.name })
  }

  const queueConsumers: PlaceholderResult['queueConsumers'] = []
  for (const consumer of tomlQueueConsumers(input.tomlText)) {
    const queueId = input.queueIds[consumer.queue]
    if (!queueId) {
      throw new Error(
        `The ${env} toml consumes queue ${consumer.queue}, which this app does not own`
      )
    }
    const made = await client.putQueueConsumer(accountId, queueId, {
      scriptName: names.workerName,
      settings: consumer.settings,
      deadLetterQueue: consumer.deadLetterQueue,
    })
    queueConsumers.push({
      queue: consumer.queue,
      queueId,
      consumerId: made.consumer_id,
      scriptName: names.workerName,
    })
    await ctx.record({
      [idKey('consumer', env, consumer.queue)]: `${queueId}/${made.consumer_id}`,
    })
  }

  const pattern = `${names.host}/*`
  let routeId = ctx.prior[idKey('route', env)]
  if (!routeId) {
    try {
      routeId = (await client.createWorkerRoute(zoneId, pattern, names.workerName)).id
    } catch (err) {
      if (!isConflict(err)) throw err
      const existing = (await client.listWorkerRoutes(zoneId)).find(r => r.pattern === pattern)
      if (!existing || existing.script !== names.workerName) {
        throw new Error(`The route ${pattern} already exists for another Worker`)
      }
      routeId = existing.id
    }
    await ctx.record({ [idKey('route', env)]: routeId, zoneId })
  }

  return { routeId, queueConsumers, workflows, migrationTag: input.script.migrationTag }
}

/** Run a delete; a 404 means it is already gone, which is what teardown wanted. */
export async function deleteIfPresent(fn: () => Promise<unknown>): Promise<'deleted' | 'gone'> {
  try {
    await fn()
    return 'deleted'
  } catch (err) {
    if (isCloudflareNotFound(err)) return 'gone'
    throw err
  }
}
