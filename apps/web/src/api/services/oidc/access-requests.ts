/**
 * Asking for access to an app (spec/05, Launch P4 plan §4c): `POST /api/app-access/requests`'s
 * service. From P4 an access request is an `app.access` approval, so asking opens (or joins) one
 * through the engine, which snapshots the policy, audits `approval.requested` and tells the app's
 * owners; it is decided in the approvals inbox, whose handler adds the grant
 * (`services/approvals/kinds/app-access.ts`).
 *
 * Its own file, apart from `policy.ts`, because it imports the ENGINE and the engine's kinds import
 * `policy.ts`: keeping `policy.ts` a leaf is what stops `KIND_HANDLERS` meeting a half-evaluated
 * handler at import time.
 */
import type { AppAccessRequest, AppAccessStanding } from '@launch/shared/launch-oidc'
import type { MembershipRole } from '@launch/shared/tenants'
import type { OidcClientRow } from '../../../db/schema'
import { open as openApproval } from '../approvals/engine'
import type { ApprovalDeps } from '../approvals/types'
import type { AuditActor } from '../launch/audit'
import { evaluateAccess, toRequests } from './policy'

/** Who is asking for access — the signed-in person, with their role for a policy's auto-approve. */
export interface AccessRequester {
  userId: string
  email: string
  role: MembershipRole | null
}

/**
 * Ask for access. A no-op for someone the policy already admits (`allowed`, no request); otherwise
 * the person's open `app.access` request for this app, new (`created`) or the one already waiting.
 * A policy that auto-approves the person answers `allowed` — the grant is already in.
 */
export async function requestAccess(
  deps: ApprovalDeps,
  input: {
    client: OidcClientRow
    requester: AccessRequester
    message?: string
    actor?: AuditActor
  }
): Promise<{ standing: AppAccessStanding; request: AppAccessRequest | null; created: boolean }> {
  const { client, requester } = input
  const { db } = deps
  if ((await evaluateAccess(db, { client, userId: requester.userId })).allowed) {
    return { standing: 'allowed', request: null, created: false }
  }
  const message = input.message || null
  const opened = await openApproval(deps, {
    tenantId: client.tenantId,
    kind: 'app.access',
    subject: { type: 'user', id: requester.userId },
    appId: client.appId,
    requester,
    reason: message,
    context: { kind: 'app.access', userId: requester.userId, message },
    actor: input.actor,
  })
  const [request] = await toRequests(db, client.tenantId, [opened.request])
  const standing: AppAccessStanding = opened.request.status === 'approved' ? 'allowed' : 'pending'
  return { standing, request: request ?? null, created: opened.created }
}
