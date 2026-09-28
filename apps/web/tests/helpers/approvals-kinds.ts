/**
 * Test conveniences for the REAL kinds on the real engine (Launch P4, slice 4c): a person as the
 * engine sees them (their groups read now, so an owner group counts), "decide as X" — the call
 * `POST /api/approvals/:id/decide` makes — and "expire it now", the sweep's. The engine's own
 * helpers (fake kinds, the fixture) are `tests/helpers/approvals.ts`.
 */
import type { ApprovalDetail } from '@launch/shared/launch-approvals'
import { and, eq } from 'drizzle-orm'
import { decide, expire } from '@/api/services/approvals/engine'
import type { ApprovalDeps, ApprovalViewer } from '@/api/services/approvals/types'
import { SYSTEM_ACTOR } from '@/api/services/launch/audit'
import type { Database } from '@/db/client'
import { approvalRequests, groupMembers, tenantUsers, users } from '@/db/schema'
import { createTestEnv, type TestEnv } from '../mocks/bindings'
import { approvalDeps } from './approvals'

/** The deps a route would hand the engine, over the test database and a test env. */
export function testApprovalDeps(db: Database, env: TestEnv = createTestEnv()): ApprovalDeps {
  return approvalDeps(db, env)
}

/** `userId` as the engine sees them in `tenantId`: email, role, admin-ness and groups, read now. */
export async function viewerFor(
  db: Database,
  tenantId: string,
  userId: string
): Promise<ApprovalViewer> {
  const [person] = await db
    .select({ email: users.email, role: tenantUsers.role, isGlobalAdmin: users.isGlobalAdmin })
    .from(users)
    .leftJoin(
      tenantUsers,
      and(eq(tenantUsers.userId, users.id), eq(tenantUsers.tenantId, tenantId))
    )
    .where(eq(users.id, userId))
  if (!person) throw new Error(`viewerFor: no user ${userId}`)
  const groups = await db
    .select({ id: groupMembers.groupId })
    .from(groupMembers)
    .where(and(eq(groupMembers.tenantId, tenantId), eq(groupMembers.userId, userId)))
  const role = person.role ?? null
  return {
    tenantId,
    userId,
    email: person.email,
    role,
    isAdmin: person.isGlobalAdmin || role === 'owner' || role === 'admin' || role === 'support',
    groupIds: groups.map(g => g.id),
  }
}

/** Decide `requestId` as `userId` — what `POST /api/approvals/:id/decide` does. */
export async function decideAs(
  deps: ApprovalDeps,
  tenantId: string,
  userId: string,
  requestId: string,
  decision: 'approve' | 'reject'
): Promise<ApprovalDetail> {
  const viewer = await viewerFor(deps.db, tenantId, userId)
  return decide(deps, {
    requestId,
    viewer,
    decision,
    actor: { ...SYSTEM_ACTOR, actorType: 'user', actorUserId: userId, actorEmail: viewer.email },
  })
}

/** Make `requestId` due and expire it — what the `approvals.sweep` cron does once it is due. */
export async function expireNow(deps: ApprovalDeps, tenantId: string, requestId: string) {
  await deps.db
    .update(approvalRequests)
    .set({ expiresAt: new Date(Date.now() - 60_000) })
    .where(and(eq(approvalRequests.tenantId, tenantId), eq(approvalRequests.id, requestId)))
  return expire(deps, { tenantId, requestId })
}
