/**
 * `sessions.expire` — the five-minute cron task (Launch P3, plan §3b): a SUSPENDED session nobody has
 * resumed within its policy's `suspendedExpiryHours` is ended, so its Neon branch (Neon caps
 * branches per project) and its place in the app's concurrency count are given back.
 *
 * The Workflow ends such a session itself — its `wait#N` times out on exactly that expiry — so this
 * is the BACKSTOP for an instance that is gone (retention, a `wrangler dev` restart): it asks with
 * `requested_action = 'end'` and wakes the session like any route would (`wakeSession` starts a
 * fresh instance when the old one is gone, and that instance's `claim` → `inspect` → `end` →
 * `cleanup` does the rest). Only when there is no `SESSION_WORKFLOW` at all does it clean up
 * inline: delete the branch, settle `ended`, audit `session.ended`.
 *
 * The same task then runs the reconcile sweep (`reconcile.ts` `reconcileStaleSessions`): a boot or
 * an end whose Workflow died, and a settled session whose cleanup never ran.
 *
 * Cross-tenant by design, like every cron: the scan reads each row's `tenant_id` and every write
 * is scoped by it.
 */
import { resolveSessionPolicy } from '@launch/shared/launch-sessions'
import { and, eq, isNull, sql } from 'drizzle-orm'
import type { AppConfig } from '../../../config'
import type { Database } from '../../../db/client'
import { apps, type SessionRow, sessions } from '../../../db/schema'
import type { ScheduledTask } from '../../scheduled'
import type { AppBindings } from '../../types'
import { recordAudit, SYSTEM_ACTOR } from '../launch/audit'
import { loadAppNeon } from './app-neon'
import { wakeOrRestart } from './lifecycle'
import { defaultSessionPorts, type SessionPorts, sandboxHostOf } from './ports'
import { reconcileStaleSessions } from './reconcile'

export interface ExpireResult {
  expired: number
  woken: number
  cleanedInline: number
}

/** Past its expiry: suspended longer than the policy allows. */
export function isExpired(
  session: Pick<SessionRow, 'status' | 'suspendedAt' | 'policy'>,
  now: Date
): boolean {
  if (session.status !== 'suspended' || !session.suspendedAt) return false
  const hours = resolveSessionPolicy(session.policy).suspendedExpiryHours
  return now.getTime() - session.suspendedAt.getTime() >= hours * 3_600_000
}

async function cleanUpInline(
  db: Database,
  ports: SessionPorts,
  session: SessionRow,
  now: Date
): Promise<void> {
  const tenantId = session.tenantId
  if (session.db) {
    const [app] = await db
      .select()
      .from(apps)
      .where(and(eq(apps.tenantId, tenantId), eq(apps.id, session.appId)))
    if (app) {
      const ref = {
        id: app.id,
        tenantId,
        slug: app.slug,
        repoOwner: app.repoOwner ?? '',
        repoName: app.repoName ?? '',
        defaultBranch: app.defaultBranch ?? 'main',
        ...(await loadAppNeon(db, tenantId, session.appId)),
        sessionDb: app.sessionDb ?? null,
      }
      const port = ports.sessionDb(db)
      // A ship's gate branches are children of the session's: they go first (Neon refuses a parent).
      await port.deleteGateBranches(ref, session.shortId)
      await port.deleteBranch(ref, session.db)
    }
  }
  // A warm-suspended session still has its container, and a cooled one its workspace backup.
  const sandbox = ports.sandbox(session.id)
  if (session.containerKeptAt) await sandbox.destroy().catch(() => {})
  if (session.workspaceBackup) await sandbox.deleteBackup(session.workspaceBackup).catch(() => {})
  const [ended] = await db
    .update(sessions)
    .set({
      status: 'ended',
      endedAt: now,
      dbUriSealed: null,
      githubTokenSealed: null,
      requestedAction: null,
      pendingMessage: null,
      containerKeptAt: null,
      workspaceBackup: null,
    })
    .where(
      and(
        eq(sessions.tenantId, tenantId),
        eq(sessions.id, session.id),
        eq(sessions.status, 'suspended')
      )
    )
    .returning({ id: sessions.id })
  if (ended) {
    await recordAudit(db, {
      ...SYSTEM_ACTOR,
      tenantId,
      action: 'session.ended',
      targetType: 'session',
      targetId: session.id,
      appId: session.appId,
      summary: { after: { status: 'ended', reason: 'expired' } },
    })
  }
}

/** One sweep. `ports` defaults to the deployment's (`defaultSessionPorts`). */
export async function expireSuspendedSessions(
  db: Database,
  env: AppBindings,
  cfg: AppConfig,
  opts: { now?: Date; ports?: SessionPorts } = {}
): Promise<ExpireResult> {
  const now = opts.now ?? new Date()
  const suspended = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.status, 'suspended'), sql`${sessions.suspendedAt} is not null`))
    .limit(500)
  const result: ExpireResult = { expired: 0, woken: 0, cleanedInline: 0 }
  for (const session of suspended.filter(s => isExpired(s, now))) {
    result.expired += 1
    const tenantId = session.tenantId
    const workflow = env.SESSION_WORKFLOW
    if (!workflow) {
      const ports = opts.ports ?? defaultSessionPorts(env, cfg, sandboxHostOf(session))
      await cleanUpInline(db, ports, session, now)
      result.cleanedInline += 1
      continue
    }
    const [asked] = await db
      .update(sessions)
      .set({ requestedAction: 'end' })
      .where(
        and(
          eq(sessions.tenantId, tenantId),
          eq(sessions.id, session.id),
          eq(sessions.status, 'suspended'),
          isNull(sessions.endedAt)
        )
      )
      .returning()
    if (!asked) continue
    await wakeOrRestart(db, workflow, asked)
    result.woken += 1
  }
  return result
}

export const expireSessions: ScheduledTask = {
  name: 'sessions.expire',
  async run({ env, config, db, logger }) {
    const result = await expireSuspendedSessions(db, env, config)
    if (result.expired > 0) logger.info(result, 'sessions.expire: ended expired suspended sessions')
    // The backstop for a boot or an end whose Workflow died, and a settled session never cleaned
    // up, when nobody has the page open (`reconcile.ts`).
    const reconciled = await reconcileStaleSessions(db, env, { logger })
    if (reconciled > 0) logger.info({ reconciled }, 'sessions.expire: settled stalled sessions')
  },
}
