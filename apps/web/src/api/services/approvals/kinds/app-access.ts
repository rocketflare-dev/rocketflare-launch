/**
 * `app.access` (Launch P4, plan §4c): a member the app's sign-in policy refused asks its owners.
 * The subject is the PERSON (`user`, their id) and the app is `app_id`; the P1 migrated rows are
 * requests of this kind with the same ids. `requestAccess` (`services/oidc/policy.ts`) opens it.
 *
 * - `applyInTx` adds the user grant on the app's OIDC client (`addGrant`, idempotent) and audits
 *   `app.access.policy_changed` with the approval id — the same action a hand-made grant writes,
 *   because it changes who may sign in in the same way. A client deleted since, or a person who
 *   has left the organisation, leaves nothing to grant: the approval still stands (throwing would
 *   roll the decision back and leave a request nobody can ever settle).
 * - No vendor effect: `applyAfter` is a no-op, so the engine's `applied_at` is set at once.
 * - No `onClosed`: a rejected or expired request only closes; the person may ask again.
 */
import { DEFAULT_APPROVAL_POLICIES } from '@launch/shared/launch-approvals'
import { NotFoundError } from '../../../utils/core/errors'
import { recordAudit } from '../../launch/audit'
import { addGrant, clientForApp } from '../../oidc/policy'
import type { KindHandler } from '../types'
import { deciderActor } from './decider'

export const appAccessHandler: KindHandler<'app.access'> = {
  kind: 'app.access',
  async defaultPolicy() {
    return DEFAULT_APPROVAL_POLICIES['app.access']
  },
  describe(request) {
    const message = request.context.kind === 'app.access' ? request.context.message : null
    return message ? `Access to sign in: “${message.slice(0, 80)}”` : 'Access to sign in'
  },
  async applyInTx(tx, request, deps) {
    const userId =
      request.context.kind === 'app.access' ? request.context.userId : request.subjectId
    const client = request.appId ? await clientForApp(tx, request.tenantId, request.appId) : null
    if (!client) {
      deps.logger.warn({ approvalId: request.id }, 'app.access approved, but the app has no client')
      return
    }
    const actor = await deciderActor(tx, request, 'approve')
    let grantee: Awaited<ReturnType<typeof addGrant>>
    try {
      grantee = await addGrant(tx, client, { userId }, actor.actorUserId)
    } catch (err) {
      if (!(err instanceof NotFoundError)) throw err
      deps.logger.warn({ approvalId: request.id }, 'app.access approved for a former member')
      return
    }
    await recordAudit(tx, {
      tenantId: request.tenantId,
      ...actor,
      action: 'app.access.policy_changed',
      targetType: 'oidc_client',
      targetId: client.clientId,
      appId: client.appId,
      approvalId: request.id,
      summary: { after: { grantAdded: 'user', userId: grantee.userId, email: grantee.label } },
    })
  },
  async applyAfter() {
    // A grant is a database effect only (`applyInTx`); nothing to do after commit.
  },
}
