/**
 * `/api/approval-policies` (Launch P4, plan §1.5 / §4b) — who approves which kind, at tenant,
 * group or app scope. `manage ApprovalPolicy` (the organisation's admins) at EVERY scope: an app
 * owner loosening their own production gate would defeat it. Behind `authMiddleware`, NOT
 * `/api/admin/*`: that prefix is `globalAdminMiddleware`'s (platform staff), and these are an
 * organisation's own settings, which its admins and the CLI's Bearer key must reach. Slice 4b
 * builds it over `services/approvals/policy.ts`:
 *
 * - `GET /?kind=&scopeType=&scopeId=` → `approvalPolicyListResponseSchema` (rows + code defaults);
 * - `PUT /` `putApprovalPolicySchema` → `approvalPolicyRowSchema` (upsert on `(kind, scopeType,
 *   scopeId)`; a group or app scope must be this tenant's — 404 otherwise), audited
 *   `approval.policy.set`;
 * - `DELETE /:id` → 204, audited `approval.policy.removed`.
 *
 * From 4a it registers nothing: an unmatched path under `/api` is the catch-all's JSON 404.
 */
import { createRouter } from '../utils/routes/router'

export const adminApprovalPoliciesRouter = createRouter()
