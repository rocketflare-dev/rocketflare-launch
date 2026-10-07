/**
 * `/api/approval-policies` (Launch P4, plan §1.5 / §4b) — who approves which kind, at tenant,
 * group or app scope. `manage ApprovalPolicy` (the organisation's admins) at EVERY scope: an app
 * owner loosening their own production gate would defeat it. Behind `authMiddleware`, NOT
 * `/api/admin/*`: that prefix is `globalAdminMiddleware`'s (platform staff), and these are an
 * organisation's own settings, which its admins and the CLI's Bearer key must reach. Over
 * `services/approvals/policy.ts`:
 *
 * - `GET /?kind=&scopeType=&scopeId=` → `approvalPolicyListResponseSchema` (rows + code defaults);
 * - `PUT /` `putApprovalPolicySchema` → `approvalPolicyRowSchema` (upsert on `(kind, scopeType,
 *   scopeId)`; a group or app scope must be this tenant's — 404 otherwise), audited
 *   `approval.policy.set`;
 * - `DELETE /:id` → 204, audited `approval.policy.removed`.
 *
 * A policy change never touches a request in flight: each request snapshotted its policy at open.
 */
import {
  type ApprovalPolicyListResponse,
  approvalPolicyListQuerySchema,
  putApprovalPolicySchema,
} from '@launch/shared/launch-approvals'
import { guardPermission } from '../middleware/permissions'
import { listPolicies, putPolicy, removePolicy } from '../services/approvals/policy'
import { auditActor, recordAudit } from '../services/launch/audit'
import { uuidParam, withAuthAndDb } from '../utils/routes/route-helpers'
import { createRouter } from '../utils/routes/router'
import { validate } from '../utils/routes/validate'

export const adminApprovalPoliciesRouter = createRouter()

/**
 * List approval policies for a kind, scope and scope id, filled in with code defaults. Requires
 * `manage ApprovalPolicy` (the organisation's admins).
 */
adminApprovalPoliciesRouter.get('/', validate('query', approvalPolicyListQuerySchema), async c => {
  guardPermission(c, 'manage', 'ApprovalPolicy')
  const { db, tenantId } = withAuthAndDb(c)
  const body: ApprovalPolicyListResponse = await listPolicies(db, tenantId, c.req.valid('query'))
  return c.json(body)
})

/**
 * Upsert an approval policy on `(kind, scopeType, scopeId)`. Requires `manage ApprovalPolicy`. A
 * group or app scope must belong to this organisation (404 otherwise). Audits `approval.policy.set`.
 */
adminApprovalPoliciesRouter.put('/', validate('json', putApprovalPolicySchema), async c => {
  guardPermission(c, 'manage', 'ApprovalPolicy')
  const { db, tenantId, user } = withAuthAndDb(c)
  const input = c.req.valid('json')
  const { row, before } = await putPolicy(db, tenantId, input, user.id)
  const { id: _id, createdAt: _c, updatedAt: _u, updatedByUserId: _by, ...after } = row
  await recordAudit(db, {
    tenantId,
    ...auditActor(c),
    action: 'approval.policy.set',
    targetType: 'approval_policy',
    targetId: row.id,
    appId: row.scopeType === 'app' ? row.scopeId : null,
    summary: { ...(before ? { before } : {}), after },
  })
  return c.json(row)
})

/** Remove an approval policy by id. Requires `manage ApprovalPolicy`. Audits `approval.policy.removed`. */
adminApprovalPoliciesRouter.delete('/:id', async c => {
  guardPermission(c, 'manage', 'ApprovalPolicy')
  const { db, tenantId } = withAuthAndDb(c)
  const removed = await removePolicy(db, tenantId, uuidParam(c, 'id'))
  await recordAudit(db, {
    tenantId,
    ...auditActor(c),
    action: 'approval.policy.removed',
    targetType: 'approval_policy',
    targetId: removed.id,
    appId: removed.scopeType === 'app' ? removed.scopeId : null,
    summary: {
      before: { kind: removed.kind, scopeType: removed.scopeType, scopeId: removed.scopeId },
    },
  })
  return c.body(null, 204)
})
