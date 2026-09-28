/**
 * Who may sign in to an app through Launch (spec/05), and the request-access queue — from P4 the
 * `app.access` approvals (see "Access requests" below). Every query here names the tenant: the authorize endpoint passes the CLIENT's
 * tenant (taken from the `oidc_clients` row), the `/api/app-access` routes the session's.
 *
 * The policy, in order:
 *
 * 1. The person must be a member of the client's organisation, and that organisation must not be
 *    suspended. Nothing below can override this — not a grant, not ownership.
 * 2. **The app's owners are always allowed** — a named owner (`app_owners`) or a member of the
 *    app's owner group. Restricting an app can never lock its owners out of it.
 * 3. `company`: every member.
 * 4. `restricted`: a user grant naming them, or a group grant for a group they are in.
 */
import type {
  AppAccessGrant,
  AppAccessRequest,
  AppAccessRequestStatus,
  AppAccessStanding,
  CreateAppAccessGrant,
  OidcAccessPolicy,
} from '@launch/shared/launch-oidc'
import { and, asc, desc, eq, inArray, or } from 'drizzle-orm'
import type { Database } from '../../../db/client'
import {
  type AppRow,
  type ApprovalRequestRow,
  appOwners,
  approvalDecisions,
  approvalRequests,
  apps,
  groupMembers,
  groups,
  type OidcClientRow,
  oidcClientGrants,
  oidcClients,
  tenants,
  tenantUsers,
  users,
} from '../../../db/schema'
import { ConflictError, NotFoundError } from '../../utils/core/errors'

export type AccessReason =
  | 'not_member'
  | 'tenant_suspended'
  | 'owner'
  | 'company'
  | 'user_grant'
  | 'group_grant'
  | 'not_granted'

export interface AccessDecision {
  allowed: boolean
  reason: AccessReason
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Is `userId` a member of `tenantId`, and is that organisation active? */
async function membership(db: Database, tenantId: string, userId: string) {
  const [row] = await db
    .select({ status: tenants.status })
    .from(tenantUsers)
    .innerJoin(tenants, eq(tenants.id, tenantUsers.tenantId))
    .where(and(eq(tenantUsers.tenantId, tenantId), eq(tenantUsers.userId, userId)))
  return row ?? null
}

/** A named owner of the app, or a member of its owner group. */
export async function isAppOwner(
  db: Database,
  tenantId: string,
  app: Pick<AppRow, 'id' | 'ownerGroupId'>,
  userId: string,
  groupIds: readonly string[]
): Promise<boolean> {
  if (app.ownerGroupId && groupIds.includes(app.ownerGroupId)) return true
  const [row] = await db
    .select({ userId: appOwners.userId })
    .from(appOwners)
    .where(
      and(
        eq(appOwners.tenantId, tenantId),
        eq(appOwners.appId, app.id),
        eq(appOwners.userId, userId)
      )
    )
  return Boolean(row)
}

/** The group ids `userId` belongs to in `tenantId` — the policy's view, fresh from the database. */
export async function memberGroupIds(
  db: Database,
  tenantId: string,
  userId: string
): Promise<string[]> {
  const rows = await db
    .select({ groupId: groupMembers.groupId })
    .from(groupMembers)
    .where(and(eq(groupMembers.tenantId, tenantId), eq(groupMembers.userId, userId)))
  return rows.map(r => r.groupId)
}

/** The whole policy for one person and one client. */
export async function evaluateAccess(
  db: Database,
  input: {
    client: Pick<OidcClientRow, 'id' | 'tenantId' | 'appId' | 'accessPolicy'>
    userId: string
    /** The person's groups in the CLIENT's tenant; read from the database when omitted. */
    groupIds?: readonly string[]
  }
): Promise<AccessDecision> {
  const { client, userId } = input
  const tenantId = client.tenantId
  const member = await membership(db, tenantId, userId)
  if (!member) return { allowed: false, reason: 'not_member' }
  if (member.status === 'suspended') return { allowed: false, reason: 'tenant_suspended' }

  const groupIds = input.groupIds ?? (await memberGroupIds(db, tenantId, userId))
  const [app] = await db
    .select({ id: apps.id, ownerGroupId: apps.ownerGroupId })
    .from(apps)
    .where(and(eq(apps.tenantId, tenantId), eq(apps.id, client.appId)))
  if (app && (await isAppOwner(db, tenantId, app, userId, groupIds))) {
    return { allowed: true, reason: 'owner' }
  }
  if (client.accessPolicy === 'company') return { allowed: true, reason: 'company' }

  const grantees = [eq(oidcClientGrants.userId, userId)]
  if (groupIds.length > 0) grantees.push(inArray(oidcClientGrants.groupId, [...groupIds]))
  const grants = await db
    .select({ userId: oidcClientGrants.userId })
    .from(oidcClientGrants)
    .where(
      and(
        eq(oidcClientGrants.tenantId, tenantId),
        eq(oidcClientGrants.clientId, client.id),
        or(...grantees)
      )
    )
  if (grants.some(g => g.userId === userId)) return { allowed: true, reason: 'user_grant' }
  if (grants.length > 0) return { allowed: true, reason: 'group_grant' }
  return { allowed: false, reason: 'not_granted' }
}

// ---- Lookups for `/api/app-access` ------------------------------------------------------------

/** An app of this tenant by id or by slug; 404 otherwise. */
export async function findAppByRef(db: Database, tenantId: string, ref: string): Promise<AppRow> {
  const [row] = await db
    .select()
    .from(apps)
    .where(
      and(eq(apps.tenantId, tenantId), UUID_RE.test(ref) ? eq(apps.id, ref) : eq(apps.slug, ref))
    )
  if (!row) throw new NotFoundError('App not found')
  return row
}

/** The app's OIDC client in this tenant, or null before one is registered. */
export async function clientForApp(
  db: Database,
  tenantId: string,
  appId: string
): Promise<OidcClientRow | null> {
  const [row] = await db
    .select()
    .from(oidcClients)
    .where(and(eq(oidcClients.tenantId, tenantId), eq(oidcClients.appId, appId)))
  return row ?? null
}

/** A client's app by the public `client_id`, within the caller's tenant; 404 otherwise. */
export async function findClientAppInTenant(
  db: Database,
  tenantId: string,
  clientId: string
): Promise<{ client: OidcClientRow; app: AppRow }> {
  const [row] = await db
    .select({ client: oidcClients, app: apps })
    .from(oidcClients)
    .innerJoin(apps, eq(apps.id, oidcClients.appId))
    .where(and(eq(oidcClients.tenantId, tenantId), eq(oidcClients.clientId, clientId)))
  if (!row) throw new NotFoundError('App not found')
  return row
}

export function requireClient(client: OidcClientRow | null): OidcClientRow {
  if (!client) {
    throw new ConflictError(
      'This app has no OIDC client yet — register one from the app page first',
      'oidc_client_missing'
    )
  }
  return client
}

/** Set the policy; returns the previous one (for the audit summary). */
export async function setAccessPolicy(
  db: Database,
  client: Pick<OidcClientRow, 'id' | 'tenantId' | 'accessPolicy'>,
  accessPolicy: OidcAccessPolicy
): Promise<OidcAccessPolicy> {
  await db
    .update(oidcClients)
    .set({ accessPolicy, updatedAt: new Date() })
    .where(and(eq(oidcClients.tenantId, client.tenantId), eq(oidcClients.id, client.id)))
  return client.accessPolicy
}

// ---- Grants --------------------------------------------------------------------------------

export async function listGrants(
  db: Database,
  client: Pick<OidcClientRow, 'id' | 'tenantId'>
): Promise<AppAccessGrant[]> {
  const rows = await db
    .select({
      id: oidcClientGrants.id,
      groupId: oidcClientGrants.groupId,
      userId: oidcClientGrants.userId,
      groupName: groups.name,
      userName: users.name,
      userEmail: users.email,
      createdAt: oidcClientGrants.createdAt,
    })
    .from(oidcClientGrants)
    .leftJoin(groups, eq(groups.id, oidcClientGrants.groupId))
    .leftJoin(users, eq(users.id, oidcClientGrants.userId))
    .where(
      and(eq(oidcClientGrants.tenantId, client.tenantId), eq(oidcClientGrants.clientId, client.id))
    )
    .orderBy(desc(oidcClientGrants.createdAt))
  return rows.map(r => ({
    id: r.id,
    kind: r.groupId ? 'group' : 'user',
    groupId: r.groupId,
    userId: r.userId,
    name: (r.groupId ? r.groupName : r.userName) ?? 'Unknown',
    email: r.groupId ? null : (r.userEmail ?? null),
    createdAt: r.createdAt,
  }))
}

/** Resolve a grant request to a group or a member of THIS tenant; 404 for anyone else's. */
async function resolveGrantee(
  db: Database,
  tenantId: string,
  input: CreateAppAccessGrant
): Promise<{ groupId: string | null; userId: string | null; label: string }> {
  if ('groupId' in input) {
    const [group] = await db
      .select({ id: groups.id, name: groups.name })
      .from(groups)
      .where(and(eq(groups.tenantId, tenantId), eq(groups.id, input.groupId)))
    if (!group) throw new NotFoundError('Group not found')
    return { groupId: group.id, userId: null, label: group.name }
  }
  const [member] = await db
    .select({ id: users.id, email: users.email })
    .from(tenantUsers)
    .innerJoin(users, eq(users.id, tenantUsers.userId))
    .where(
      and(
        eq(tenantUsers.tenantId, tenantId),
        'userId' in input ? eq(users.id, input.userId) : eq(users.email, input.email)
      )
    )
  if (!member) throw new NotFoundError('No member of this organisation matches')
  return { groupId: null, userId: member.id, label: member.email }
}

/**
 * Add a grant (idempotent: granting twice is one row). Returns what was granted, for the audit.
 * `createdByUserId` is null for a grant the system made (an auto-approved `app.access` request).
 */
export async function addGrant(
  db: Database,
  client: Pick<OidcClientRow, 'id' | 'tenantId'>,
  input: CreateAppAccessGrant,
  createdByUserId: string | null
) {
  const grantee = await resolveGrantee(db, client.tenantId, input)
  await db
    .insert(oidcClientGrants)
    .values({
      tenantId: client.tenantId,
      clientId: client.id,
      groupId: grantee.groupId,
      userId: grantee.userId,
      createdByUserId,
    })
    .onConflictDoNothing()
  return grantee
}

/** Remove one grant; 404 when it is not this client's. */
export async function removeGrant(
  db: Database,
  client: Pick<OidcClientRow, 'id' | 'tenantId'>,
  grantId: string
) {
  const [row] = await db
    .delete(oidcClientGrants)
    .where(
      and(
        eq(oidcClientGrants.tenantId, client.tenantId),
        eq(oidcClientGrants.clientId, client.id),
        eq(oidcClientGrants.id, grantId)
      )
    )
    .returning()
  if (!row) throw new NotFoundError('Grant not found')
  return row
}

// ---- Access requests -----------------------------------------------------------------------
//
// From P4 an access request IS an `app.access` approval request (`approval_requests`, subject the
// person), and the P4 migration moved P1's pending rows across with their ids. Asking goes through
// the approvals engine (`requestAccess` in `access-requests.ts` → `engine.open`); DECIDING is the
// engine's too, in the approvals inbox (`POST /api/approvals/:id/decide`), whose `app.access`
// handler adds the grant (`services/approvals/kinds/app-access.ts`). What stays here is the
// P1-shaped view of those rows that the request-access page and the app's Access page read.
// This file must NOT import the engine: the engine's kinds import it (`addGrant`, and
// `isAppOwner` through `launch/apps.ts`), and `KIND_HANDLERS` is built at module scope — a cycle
// through here would leave a handler `undefined` at import time.

/** P1's three statuses from the engine's five: an expired or cancelled request reads as rejected. */
function toAccessStatus(status: ApprovalRequestRow['status']): AppAccessRequestStatus {
  if (status === 'pending' || status === 'approved') return status
  return 'rejected'
}

/** The engine statuses a P1 status filter means. */
function fromAccessStatus(status: AppAccessRequestStatus): ApprovalRequestRow['status'][] {
  if (status === 'rejected') return ['rejected', 'expired', 'cancelled']
  return [status]
}

/** Every `app.access` request of one app in this tenant. */
function accessRequestsOf(tenantId: string, appId: string) {
  return and(
    eq(approvalRequests.tenantId, tenantId),
    eq(approvalRequests.kind, 'app.access'),
    eq(approvalRequests.appId, appId),
    eq(approvalRequests.subjectType, 'user')
  )
}

export async function toRequests(
  db: Database,
  tenantId: string,
  rows: ApprovalRequestRow[]
): Promise<AppAccessRequest[]> {
  if (rows.length === 0) return []
  const people = await db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(tenantUsers)
    .innerJoin(users, eq(users.id, tenantUsers.userId))
    .where(
      and(
        eq(tenantUsers.tenantId, tenantId),
        inArray(
          users.id,
          rows.map(r => r.subjectId)
        )
      )
    )
  const byId = new Map(people.map(p => [p.id, p]))
  // The decider is the latest decision on the request (P1 had exactly one).
  const decisions = await db
    .select({ requestId: approvalDecisions.requestId, userId: approvalDecisions.userId })
    .from(approvalDecisions)
    .where(
      and(
        eq(approvalDecisions.tenantId, tenantId),
        inArray(
          approvalDecisions.requestId,
          rows.map(r => r.id)
        )
      )
    )
    .orderBy(asc(approvalDecisions.at))
  const decidedBy = new Map(decisions.map(d => [d.requestId, d.userId]))
  return rows.map(r => ({
    id: r.id,
    appId: r.appId ?? '',
    userId: r.subjectId,
    userEmail: byId.get(r.subjectId)?.email ?? '',
    userName: byId.get(r.subjectId)?.name ?? 'Former member',
    message: r.reason,
    status: toAccessStatus(r.status),
    decidedByUserId: decidedBy.get(r.id) ?? null,
    decidedAt: r.decidedAt,
    createdAt: r.createdAt,
  }))
}

/** The person's latest request for an app, if any. */
async function latestRequest(db: Database, tenantId: string, appId: string, userId: string) {
  const [row] = await db
    .select()
    .from(approvalRequests)
    .where(and(accessRequestsOf(tenantId, appId), eq(approvalRequests.subjectId, userId)))
    .orderBy(desc(approvalRequests.createdAt))
    .limit(1)
  return row ?? null
}

/** Allowed, pending, rejected or none — what the request-access page shows. */
export async function standingOf(
  db: Database,
  client: OidcClientRow,
  userId: string
): Promise<AppAccessStanding> {
  const decision = await evaluateAccess(db, { client, userId })
  if (decision.allowed) return 'allowed'
  const latest = await latestRequest(db, client.tenantId, client.appId, userId)
  if (!latest) return 'none'
  const status = toAccessStatus(latest.status)
  return status === 'approved' ? 'none' : status
}

/**
 * An app's `app.access` requests for its Access page, newest first — read straight from
 * `approval_requests` rather than through `engine.list` (the caller's inbox): the page belongs to
 * the app's owners and admins, which the route checks, and shows every request, decided or not.
 */
export async function listRequests(
  db: Database,
  tenantId: string,
  appId: string,
  status?: AppAccessRequestStatus
): Promise<AppAccessRequest[]> {
  const rows = await db
    .select()
    .from(approvalRequests)
    .where(
      and(
        accessRequestsOf(tenantId, appId),
        status ? inArray(approvalRequests.status, fromAccessStatus(status)) : undefined
      )
    )
    .orderBy(desc(approvalRequests.createdAt))
    .limit(200)
  return toRequests(db, tenantId, rows)
}
