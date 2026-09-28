/**
 * `GRANT_PUSH` — starting, retrying and reading pushes (Launch P5, plan §1.10, §1.12, §4 5c). The
 * Workflow's step bodies live here too (`workflows/grant-push.ts` is the thin class):
 *
 * - `startPush`: `requireGrantPushWorkflow` first, then one `grant_pushes` row (409
 *   `push_in_progress` on the active index; an `approvalId` that already has a push returns it,
 *   `created: false`), then `GRANT_PUSH_WORKFLOW.create({ id: pushId, params: { tenantId, pushId } })`.
 *   Audited `grant.push.started`;
 * - `retryPush`: a `partial` / `failed` push starts again as `<pushId>-rN` — succeeded targets and
 *   grants already holding a newer version are skipped (`POST …/pushes/:pushId/retry`);
 * - `listPushes`, `getPush`: `GET /api/shared-resources/:id/pushes[/:pushId]` (owners and admins).
 *
 * Values are decrypted INSIDE a step (`sealed.openValues`), registered for redaction, never
 * returned. The script is `app_environments.worker_name` (missing → a failed target,
 * `app_has_no_worker`). Each settled target nudges `entity.changed { entity: 'grant_push' }`.
 *
 * **Slice 5c owns this file.** From 5a each throws `NotWiredError`.
 */
import type {
  GrantPush,
  GrantPushListQuery,
  GrantPushListResponse,
} from '@launch/shared/launch-grants'
import type { Database } from '../../../db/client'
import type { AuditActor } from '../launch/audit'
import {
  type GrantDeps,
  type GrantViewer,
  NotWiredError,
  type StartPushInput,
  type StartPushResult,
} from './types'

export async function startPush(
  _deps: GrantDeps,
  _input: StartPushInput
): Promise<StartPushResult> {
  throw new NotWiredError('grants/push.startPush', '5c')
}

export async function retryPush(
  _deps: GrantDeps,
  _viewer: GrantViewer,
  _resourceId: string,
  _pushId: string,
  _actor: AuditActor
): Promise<GrantPush> {
  throw new NotWiredError('grants/push.retryPush', '5c')
}

export async function listPushes(
  _db: Database,
  _viewer: GrantViewer,
  _resourceId: string,
  _query: GrantPushListQuery
): Promise<GrantPushListResponse> {
  throw new NotWiredError('grants/push.listPushes', '5c')
}

export async function getPush(
  _db: Database,
  _viewer: GrantViewer,
  _resourceId: string,
  _pushId: string
): Promise<GrantPush> {
  throw new NotWiredError('grants/push.getPush', '5c')
}
