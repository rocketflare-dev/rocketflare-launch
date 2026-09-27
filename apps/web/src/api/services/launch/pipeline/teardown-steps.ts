/**
 * The step bodies of `AppTeardownWorkflow` (Launch P2, plan §3 2c "Teardown"): archiving an app
 * removes exactly what its launch created, in the reverse order, by RECORDED id — never a lookup
 * by name (spec/06).
 *
 * - **The inventory** is gathered from the `external_ids` of EVERY `create` run's rows (a failed
 *   launch recorded some; a retried one recorded the rest) plus, for a created app, what its
 *   `app_environments` rows hold. An IMPORTED app's resources were never Launch's to delete, so
 *   its vendor steps are recorded `skipped` and only sign-in is disabled.
 * - **Order**: routes → queue consumers → Workers (`force`) → workflows → queues → R2 (emptied
 *   first) → KV → Resend keys → the Neon project → the OIDC client (disabled, not deleted, so its
 *   audit trail keeps a subject) → the repository (archived; deleted only when asked) → `archived`.
 * - **A 404 is success**: the thing is already gone, which is what teardown wanted — so a
 *   half-created app, or a teardown retried after a partial run, finishes cleanly.
 * - A vendor that is not configured is only an error when there is something of its to delete.
 */
import type { AppTeardownParams } from '@launch/shared/launch-pipeline'
import { and, eq, isNull } from 'drizzle-orm'
import type { Database } from '../../../../db/client'
import { appEnvironments, appOperations, apps, oidcClients } from '../../../../db/schema'
import { recordAudit, SYSTEM_ACTOR } from '../audit'
import { archiveRepo, deleteRepo, isGitHubNotFound } from '../github-app'
import { isNeonNotFound } from '../neon'
import { isResendNotFound } from '../resend'
import { cloudflareClient, neonClient, resendClient } from './context'
import type { PipelineDeps } from './launch-steps'
import { runStep, type StepKey, skipStep } from './operations'
import { deleteIfPresent } from './provision-cloudflare'
import { orgToken } from './provision-github'

export function teardownKey(params: AppTeardownParams, step: string): StepKey {
  return {
    tenantId: params.tenantId,
    appId: params.appId,
    runId: params.runId,
    kind: 'teardown',
    step,
  }
}

/** Everything the app's launches created, deduplicated. */
export interface LaunchInventory {
  imported: boolean
  zoneId: string | null
  routes: string[]
  consumers: { queueId: string; consumerId: string }[]
  scripts: string[]
  workflows: string[]
  queues: string[]
  r2: string[]
  kv: string[]
  resendKeys: string[]
  neonProjects: string[]
  repo: { owner: string; name: string } | null
}

const RESOURCE_KEY =
  /^(route|script|workflow|queue|r2|kv|resendKey|consumer)\.(?:staging|production)(?:\.|$)/

const uniq = <T>(items: T[]) => [...new Set(items)]

/** The ids recorded by every create run, plus the environment rows of a created app. */
export async function gatherLaunchIds(
  db: Database,
  tenantId: string,
  appId: string
): Promise<LaunchInventory> {
  const [app] = await db
    .select()
    .from(apps)
    .where(and(eq(apps.tenantId, tenantId), eq(apps.id, appId)))
  if (!app) throw new Error(`App ${appId} no longer exists`)
  const inv: LaunchInventory = {
    imported: app.source !== 'created',
    zoneId: null,
    routes: [],
    consumers: [],
    scripts: [],
    workflows: [],
    queues: [],
    r2: [],
    kv: [],
    resendKeys: [],
    neonProjects: [],
    repo: null,
  }
  if (inv.imported) return inv

  const rows = await db
    .select({ externalIds: appOperations.externalIds })
    .from(appOperations)
    .where(
      and(
        eq(appOperations.tenantId, tenantId),
        eq(appOperations.appId, appId),
        eq(appOperations.kind, 'create')
      )
    )
  for (const { externalIds } of rows) {
    for (const [key, value] of Object.entries(externalIds ?? {})) {
      if (!value) continue
      // Only `<kind>.<environment>[.<name>]` keys name a resource (`idKey`); anything else a step
      // recorded (`dispatchedAt`, a runner's ids) is left alone.
      const kind = RESOURCE_KEY.exec(key)?.[1] ?? null
      if (key === 'zoneId') inv.zoneId = value
      else if (key === 'neonProjectId') inv.neonProjects.push(value)
      else if (key === 'repo' && value.includes('/')) {
        const [owner = '', name = ''] = value.split('/')
        inv.repo = { owner, name }
      } else if (kind === 'route') inv.routes.push(value)
      else if (kind === 'script') inv.scripts.push(value)
      else if (kind === 'workflow') inv.workflows.push(value)
      else if (kind === 'queue') inv.queues.push(value)
      else if (kind === 'r2') inv.r2.push(value)
      else if (kind === 'kv') inv.kv.push(value)
      else if (kind === 'resendKey') inv.resendKeys.push(value)
      else if (kind === 'consumer') {
        const [queueId = '', consumerId = ''] = value.split('/')
        if (queueId && consumerId) inv.consumers.push({ queueId, consumerId })
      }
    }
  }

  const envs = await db
    .select()
    .from(appEnvironments)
    .where(and(eq(appEnvironments.tenantId, tenantId), eq(appEnvironments.appId, appId)))
  for (const env of envs) {
    inv.routes.push(...(env.routeIds ?? []))
    const res = env.resources ?? {}
    for (const c of res.queueConsumers ?? []) {
      inv.consumers.push({ queueId: c.queueId, consumerId: c.consumerId })
    }
    inv.kv.push(...(res.kv ?? []).map(k => k.id))
    inv.queues.push(...(res.queues ?? []).flatMap(q => (q.id ? [q.id] : [])))
    inv.r2.push(...(res.r2 ?? []).map(b => b.bucketName))
    inv.workflows.push(...(res.workflows ?? []).map(w => w.name))
    if (env.resendKeyId) inv.resendKeys.push(env.resendKeyId)
    if (env.neon?.projectId) inv.neonProjects.push(env.neon.projectId)
  }
  if (!inv.repo && app.repoOwner && app.repoName) {
    inv.repo = { owner: app.repoOwner, name: app.repoName }
  }

  const seen = new Set<string>()
  inv.consumers = inv.consumers.filter(c => {
    const k = `${c.queueId}/${c.consumerId}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  for (const list of [
    'routes',
    'scripts',
    'workflows',
    'queues',
    'r2',
    'kv',
    'resendKeys',
    'neonProjects',
  ] as const) {
    inv[list] = uniq(inv[list])
  }
  return inv
}

type Deletion = (d: PipelineDeps, inv: LaunchInventory) => Promise<Record<string, string>>

async function eachDeleted<T>(items: readonly T[], fn: (item: T) => Promise<unknown>) {
  let deleted = 0
  let gone = 0
  for (const item of items) {
    if ((await fn(item)) === 'gone') gone++
    else deleted++
  }
  return { deleted: String(deleted), alreadyGone: String(gone) }
}

async function ignore404(fn: () => Promise<unknown>, notFound: (err: unknown) => boolean) {
  try {
    await fn()
    return 'deleted' as const
  } catch (err) {
    if (notFound(err)) return 'gone' as const
    throw err
  }
}

/** The Cloudflare-side deletions, in order. Each is one teardown row. */
export const CLOUDFLARE_DELETIONS: Record<
  'routes' | 'queue_consumers' | 'workers' | 'workflows' | 'queues' | 'r2' | 'kv',
  Deletion
> = {
  routes: async (d, inv) => {
    if (inv.routes.length === 0) return { deleted: '0' }
    const cf = cloudflareClient(await d.vendors())
    const zoneId = inv.zoneId ?? cf.zoneId
    if (!zoneId) throw new Error('No zone id recorded or configured for the routes')
    return eachDeleted(inv.routes, id =>
      deleteIfPresent(() => cf.client.deleteWorkerRoute(zoneId, id))
    )
  },
  queue_consumers: async (d, inv) => {
    if (inv.consumers.length === 0) return { deleted: '0' }
    const cf = cloudflareClient(await d.vendors())
    return eachDeleted(inv.consumers, c =>
      deleteIfPresent(() => cf.client.deleteQueueConsumer(cf.accountId, c.queueId, c.consumerId))
    )
  },
  workers: async (d, inv) => {
    if (inv.scripts.length === 0) return { deleted: '0' }
    const cf = cloudflareClient(await d.vendors())
    return eachDeleted(inv.scripts, name =>
      deleteIfPresent(() => cf.client.deleteWorkerScript(cf.accountId, name, true))
    )
  },
  workflows: async (d, inv) => {
    if (inv.workflows.length === 0) return { deleted: '0' }
    const cf = cloudflareClient(await d.vendors())
    return eachDeleted(inv.workflows, name =>
      deleteIfPresent(() => cf.client.deleteWorkflow(cf.accountId, name))
    )
  },
  queues: async (d, inv) => {
    if (inv.queues.length === 0) return { deleted: '0' }
    const cf = cloudflareClient(await d.vendors())
    return eachDeleted(inv.queues, id =>
      deleteIfPresent(() => cf.client.deleteQueue(cf.accountId, id))
    )
  },
  r2: async (d, inv) => {
    if (inv.r2.length === 0) return { deleted: '0' }
    const cf = cloudflareClient(await d.vendors())
    return eachDeleted(inv.r2, name =>
      deleteIfPresent(() => cf.client.emptyAndDeleteR2Bucket(cf.accountId, name))
    )
  },
  kv: async (d, inv) => {
    if (inv.kv.length === 0) return { deleted: '0' }
    const cf = cloudflareClient(await d.vendors())
    return eachDeleted(inv.kv, id =>
      deleteIfPresent(() => cf.client.deleteKvNamespace(cf.accountId, id))
    )
  },
}

export const emailDeletion: Deletion = async (d, inv) => {
  if (inv.resendKeys.length === 0) return { deleted: '0' }
  const resend = resendClient(await d.vendors())
  return eachDeleted(inv.resendKeys, id =>
    ignore404(() => resend.client.deleteApiKey(id), isResendNotFound)
  )
}

export const neonDeletion: Deletion = async (d, inv) => {
  if (inv.neonProjects.length === 0) return { deleted: '0' }
  const neon = neonClient(await d.vendors(), { sleep: d.sleep })
  return eachDeleted(inv.neonProjects, id =>
    ignore404(() => neon.client.deleteProject(id), isNeonNotFound)
  )
}

/** Run one teardown row: skipped for an imported app's vendor steps, else the deletion. */
export function deletionStep(
  d: PipelineDeps,
  params: AppTeardownParams,
  step: string,
  deletion: Deletion
): Promise<unknown> {
  return (async () => {
    const inv = await gatherLaunchIds(d.db, params.tenantId, params.appId)
    if (inv.imported) {
      await skipStep(d.db, teardownKey(params, step), 'An imported app: Launch did not create it')
      return { skipped: true }
    }
    return runStep(d.db, teardownKey(params, step), () => deletion(d, inv))
  })()
}

/** Sign-in off: the client is DISABLED (kept for its audit trail), never deleted. */
export function oidcClientTeardownStep(d: PipelineDeps, params: AppTeardownParams) {
  return runStep(d.db, teardownKey(params, 'oidc_client'), async () => {
    const disabled = await d.db
      .update(oidcClients)
      .set({ disabledAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(oidcClients.tenantId, params.tenantId),
          eq(oidcClients.appId, params.appId),
          isNull(oidcClients.disabledAt)
        )
      )
      .returning({ id: oidcClients.id, clientId: oidcClients.clientId })
    for (const row of disabled) {
      await recordAudit(d.db, {
        tenantId: params.tenantId,
        ...SYSTEM_ACTOR,
        action: 'oidc_client.disabled',
        targetType: 'OidcClient',
        targetId: row.id,
        appId: params.appId,
        summary: { after: { clientId: row.clientId, reason: 'app archived' } },
      })
    }
    return { disabled: String(disabled.length) }
  })
}

/** The repository: archived (read-only, kept), or deleted when the person asked for that. */
export function repoTeardownStep(d: PipelineDeps, params: AppTeardownParams) {
  return (async () => {
    const inv = await gatherLaunchIds(d.db, params.tenantId, params.appId)
    const key = teardownKey(params, 'repo')
    if (inv.imported) {
      await skipStep(d.db, key, 'An imported app: its repository is left as it is')
      return { skipped: true }
    }
    return runStep(d.db, key, async (ctx): Promise<Record<string, string>> => {
      const repo = inv.repo
      if (!repo) return { repo: 'none' }
      const { token } = await orgToken(
        await d.vendors(),
        { administration: 'write', metadata: 'read' },
        ctx
      )
      const outcome = await ignore404(
        () =>
          params.deleteRepo
            ? deleteRepo(token, repo.owner, repo.name)
            : archiveRepo(token, repo.owner, repo.name),
        isGitHubNotFound
      )
      return {
        repo: `${repo.owner}/${repo.name}`,
        action: outcome === 'gone' ? 'gone' : params.deleteRepo ? 'deleted' : 'archived',
      }
    })
  })()
}

/** The end: status `archived`, `archived_at`, audit `app.archived`. */
export function archivedStep(d: PipelineDeps, params: AppTeardownParams) {
  return runStep(d.db, teardownKey(params, 'archived'), async () => {
    const now = new Date()
    await d.db.transaction(async tx => {
      await tx
        .update(apps)
        .set({ status: 'archived', archivedAt: now, updatedAt: now })
        .where(and(eq(apps.tenantId, params.tenantId), eq(apps.id, params.appId)))
      await recordAudit(tx, {
        tenantId: params.tenantId,
        ...SYSTEM_ACTOR,
        action: 'app.archived',
        targetType: 'App',
        targetId: params.appId,
        appId: params.appId,
        summary: { after: { runId: params.runId, deleteRepo: params.deleteRepo } },
      })
    })
    return { status: 'archived' }
  })
}

/** The teardown's uncaught failure: audited; the app keeps its status so it can be retried. */
export async function teardownFailedStep(d: PipelineDeps, params: AppTeardownParams) {
  const [failed] = await d.db
    .select({ step: appOperations.step, error: appOperations.error })
    .from(appOperations)
    .where(
      and(
        eq(appOperations.tenantId, params.tenantId),
        eq(appOperations.runId, params.runId),
        eq(appOperations.status, 'failed')
      )
    )
    .limit(1)
  await recordAudit(d.db, {
    tenantId: params.tenantId,
    ...SYSTEM_ACTOR,
    action: 'app.teardown_failed',
    targetType: 'App',
    targetId: params.appId,
    appId: params.appId,
    summary: {
      after: {
        runId: params.runId,
        error: failed ? `${failed.step}: ${failed.error ?? 'failed'}` : 'The teardown stopped',
      },
    },
  })
}
