/**
 * Launch P4 approvals test helpers: fake kind handlers, a people-and-app fixture, and the engine's
 * dependencies built from a test env.
 *
 * `installFakeKinds()` swaps every entry of `KIND_HANDLERS` for a recording fake (the kinds
 * themselves are 4c/4d's, and the engine must be provable without them) and returns `restore`.
 * The registry is a module singleton, so a file that installs fakes is `// @vitest-isolate` and
 * restores in `afterAll` — the `AGENTS` swap in `agent-interrupts.test.ts` is the precedent.
 * Each fake keeps the real handler's `defaultPolicy` (so `app.create` auto-approves admins as
 * the code default says) and records every effect by request id.
 */
import { BUILT_APPROVAL_KINDS, type BuiltApprovalKind } from '@launch/shared/launch-approvals'
import { and, eq } from 'drizzle-orm'
import { vi } from 'vitest'
import { KIND_HANDLERS } from '@/api/services/approvals/kinds'
import type {
  ApprovalClosedStatus,
  ApprovalDeps,
  ApprovalViewer,
  KindHandler,
  OpenApprovalInput,
} from '@/api/services/approvals/types'
import type { AuditActor } from '@/api/services/launch/audit'
import type { Logger } from '@/api/utils/core/logger'
import { loadConfig } from '@/config'
import type { Database } from '@/db/client'
import { type ApprovalRequestRow, tenantUsers } from '@/db/schema'
import type { TestEnv } from '../mocks/bindings'
import { createTestTenantWithUser, createTestUser, linkUserToTenant } from './auth'
import { seedApp } from './launch-apps'
import { addTestAppOwner } from './oidc'

export interface FakeKinds {
  /** `applyInTx` calls, by request id (inside the decide transaction). */
  inTx: string[]
  /** Every `applyAfter` ATTEMPT, by request id. */
  attempts: string[]
  /** Successful `applyAfter`s, by request id. */
  applied: string[]
  closed: Array<{ id: string; status: ApprovalClosedStatus }>
  /** Request ids whose `applyAfter` throws until removed. */
  failApplyAfter: Set<string>
  /** Request ids whose `applyInTx` throws (the decision must roll back). */
  failApplyInTx: Set<string>
  /** Extra approvers by SUBJECT id (known before the request exists). */
  extra: Map<string, string[]>
  restore(): void
}

export function installFakeKinds(): FakeKinds {
  const registry = KIND_HANDLERS as unknown as Record<BuiltApprovalKind, KindHandler>
  const originals = { ...registry }
  const fake: FakeKinds = {
    inTx: [],
    attempts: [],
    applied: [],
    closed: [],
    failApplyAfter: new Set(),
    failApplyInTx: new Set(),
    extra: new Map(),
    restore: () => Object.assign(registry, originals),
  }
  for (const kind of BUILT_APPROVAL_KINDS) {
    registry[kind] = {
      kind,
      defaultPolicy: (db, tenantId) => originals[kind].defaultPolicy(db, tenantId),
      describe: (request: ApprovalRequestRow) => `Fake ${kind} for ${request.subjectId}`,
      async eligibleExtra(_db, request) {
        return fake.extra.get(request.subjectId) ?? []
      },
      async applyInTx(_tx, request) {
        if (fake.failApplyInTx.has(request.id)) throw new Error('applyInTx refused')
        fake.inTx.push(request.id)
      },
      async applyAfter(request) {
        fake.attempts.push(request.id)
        if (fake.failApplyAfter.has(request.id)) throw new Error('the vendor is down')
        fake.applied.push(request.id)
      },
      async onClosed(request, status) {
        fake.closed.push({ id: request.id, status })
      },
    } as KindHandler
  }
  return fake
}

export function fakeLogger() {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => log }
  return log as unknown as Logger & typeof log
}

/** The engine's dependencies over a test env; `now` is settable for expiry and retry tests. */
export function approvalDeps(db: Database, env: TestEnv, now?: () => Date): ApprovalDeps {
  return {
    db,
    env,
    cfg: loadConfig(env),
    logger: fakeLogger(),
    realtime: { env, defer: fn => void fn() },
    ...(now ? { now } : {}),
  }
}

export function actorOf(user: { id: string; email: string }): AuditActor {
  return {
    actorType: 'user',
    actorUserId: user.id,
    actorEmail: user.email,
    ip: null,
    userAgent: null,
    requestId: null,
  }
}

export async function viewerOf(
  db: Database,
  tenantId: string,
  user: { id: string; email: string; isGlobalAdmin?: boolean },
  groupIds: string[] = []
): Promise<ApprovalViewer> {
  const [membership] = await db
    .select({ role: tenantUsers.role })
    .from(tenantUsers)
    .where(and(eq(tenantUsers.tenantId, tenantId), eq(tenantUsers.userId, user.id)))
  const role = membership?.role ?? null
  return {
    tenantId,
    userId: user.id,
    email: user.email,
    role,
    isAdmin:
      Boolean(user.isGlobalAdmin) || role === 'owner' || role === 'admin' || role === 'support',
    groupIds,
  }
}

/**
 * One organisation: `admin` (its owner), `alice` and `bob` (members who own `app`), `carol` (a
 * member with no part in it).
 */
export async function approvalsFixture(db: Database) {
  const { tenant, user: admin } = await createTestTenantWithUser(db, 'owner')
  const people = await Promise.all([createTestUser(db), createTestUser(db), createTestUser(db)])
  const [alice, bob, carol] = people as [(typeof people)[0], (typeof people)[0], (typeof people)[0]]
  for (const person of people) await linkUserToTenant(db, person.id, tenant.id, 'member')
  const { app } = await seedApp(db, tenant.id, { environments: {} })
  await addTestAppOwner(db, tenant.id, app.id, alice.id)
  await addTestAppOwner(db, tenant.id, app.id, bob.id)
  return { tenant, admin, alice, bob, carol, app }
}

/** An `app.access` open for `requester` (subject: the person), with the code-default policy. */
export function accessOpen(
  tenantId: string,
  appId: string,
  requester: { id: string; email: string },
  overrides: Partial<OpenApprovalInput<'app.access'>> = {}
): OpenApprovalInput<'app.access'> {
  return {
    tenantId,
    kind: 'app.access',
    subject: { type: 'user', id: requester.id },
    appId,
    requester: { userId: requester.id, email: requester.email, role: 'member' },
    reason: 'Please let me in',
    context: { kind: 'app.access', userId: requester.id, message: 'Please let me in' },
    ...overrides,
  }
}

/** A `deploy.production` open on a fresh release id (owners + admins, not self, by default). */
export function productionOpen(
  tenantId: string,
  appId: string,
  requester: { id: string; email: string },
  overrides: Partial<OpenApprovalInput<'deploy.production'>> = {}
): OpenApprovalInput<'deploy.production'> {
  return {
    tenantId,
    kind: 'deploy.production',
    subject: { type: 'release', id: crypto.randomUUID() },
    appId,
    requester: { userId: requester.id, email: requester.email, role: 'member' },
    reason: null,
    context: {
      kind: 'deploy.production',
      environment: 'production',
      version: '0.1.1',
      tag: '0.1.1',
      sha: 'a'.repeat(40),
      ref: 'refs/tags/0.1.1',
      compareUrl: null,
      prs: [],
      stagingHealth: 'up',
      stagingVersion: '0.1.1',
    },
    ...overrides,
  }
}
