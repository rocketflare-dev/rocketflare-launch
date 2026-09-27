/**
 * The app's Cloudflare resources (Launch P2, plan §3 2c steps 5 and 8), per environment:
 *
 * - **Storage** (`cloudflare`): the rate-limit KV namespace, the jobs queue and the files R2
 *   bucket, each named by `names.ts` and RECORDED the moment Cloudflare returns its id. A retry
 *   that meets a name conflict adopts the existing resource only when no other app of the tenant
 *   records that id — the name is the app's (slugs are globally unique), but an id another app
 *   holds is never taken over.
 * - **Placeholders** (`placeholders`): the placeholder Worker script (its PUT applies the toml's
 *   Durable Object migrations, which a version upload cannot), `workers.dev` off, the Workflows and
 *   queue consumers the Versions API never creates, and the `<host>/*` route.
 *
 * External id keys are `<kind>.<environment>[.<name>]` — `teardown-steps.ts` gathers them back by
 * the same prefixes, from every create run of the app.
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
import type { WranglerEnvironment } from '../rocketflare-manifest'
import type { StepContext } from './operations'
import type { AppResourceNames, PlaceholderScript } from './ports'

export interface CloudflareTarget {
  client: CloudflareClient
  accountId: string
  zoneId: string | null
}

/** "Is this id already some OTHER app's?" — answered from the registry by the caller. */
export type ClaimedElsewhere = (kind: 'kv' | 'queue' | 'r2', id: string) => Promise<boolean>

export interface EnvironmentStorage {
  kvId: string
  kvTitle: string
  queueId: string
  queueName: string
  r2Bucket: string
}

export const idKey = (kind: string, env: AppEnvironmentName, name?: string) =>
  name ? `${kind}.${env}.${name}` : `${kind}.${env}`

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

/** KV + queue + R2 for one environment, each recorded as soon as it exists. */
export async function provisionStorage(
  cf: CloudflareTarget,
  ctx: StepContext,
  env: AppEnvironmentName,
  names: AppResourceNames,
  claimedElsewhere: ClaimedElsewhere
): Promise<EnvironmentStorage> {
  const { client, accountId } = cf

  let kvId = ctx.prior[idKey('kv', env)]
  if (!kvId) {
    try {
      kvId = (await client.createKvNamespace(accountId, names.kvTitle)).id
    } catch (err) {
      if (!isConflict(err) && !/10014/.test(String((err as Error).message))) throw err
      const found = await client.findKvByTitle(accountId, names.kvTitle)
      kvId = await adopt(claimedElsewhere, 'kv', names.kvTitle, found?.id ?? null)
    }
    await ctx.record({ [idKey('kv', env)]: kvId, [idKey('kvTitle', env)]: names.kvTitle })
  }

  let queueId = ctx.prior[idKey('queue', env)]
  if (!queueId) {
    try {
      queueId = (await client.createQueue(accountId, names.queue)).queue_id
    } catch (err) {
      if (!isConflict(err)) throw err
      const list = await client.get<CloudflareQueue[]>(
        `/accounts/${encodeURIComponent(accountId)}/queues?per_page=100`
      )
      const found = list.find(q => q.queue_name === names.queue)
      queueId = await adopt(claimedElsewhere, 'queue', names.queue, found?.queue_id ?? null)
    }
    await ctx.record({ [idKey('queue', env)]: queueId, [idKey('queueName', env)]: names.queue })
  }

  if (!ctx.prior[idKey('r2', env)]) {
    try {
      await client.createR2Bucket(accountId, names.r2Bucket)
    } catch (err) {
      if (!isConflict(err)) throw err
      await adopt(claimedElsewhere, 'r2', names.r2Bucket, names.r2Bucket)
    }
    await ctx.record({ [idKey('r2', env)]: names.r2Bucket })
  }

  return {
    kvId,
    kvTitle: names.kvTitle,
    queueId,
    queueName: names.queue,
    r2Bucket: names.r2Bucket,
  }
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
