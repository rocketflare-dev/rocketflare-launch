/**
 * Shared config and grants — the services' shared vocabulary (Launch P5,
 * `docs/plans/p5-grants.md`): who is asking (`GrantViewer`, the approvals engine's viewer), what a
 * service runs with (`GrantDeps`), the push's inputs, the backing seam (plan §1.11), the one check
 * every writer makes before a row (`requireGrantPushWorkflow`, 503 `grants_not_configured`) and the
 * error the stubs throw.
 *
 * Slice 5a owns this file; 5b–5f import from it and never edit it — a slice that needs a change
 * here stops and reports.
 *
 * Who fills what (every other file under `services/grants/` is one slice's):
 *
 * | File | Slice | Exports |
 * |------|-------|---------|
 * | `access.ts` | 5b | `isResourceOwner`, `canSeeHolders`, `canManageResource` |
 * | `resources.ts` | 5b | `listResources`, `getResource`, `createResource`, `patchResource`, `archiveResource`, `loadResource` |
 * | `values.ts` | 5b | `setValues`, `activeVersion` |
 * | `sealed.ts` | 5a (done) | `sealValues`, `openValues` |
 * | `push.ts` | 5c | `startPush`, `retryPush`, `listPushes`, `getPush` |
 * | `backing.ts` | 5c | `WorkerSecretsBacking`, `LocalGrantBacking`, `grantBackingFor` |
 * | `revoke.ts` | 5c | `revokeGrant` |
 * | `sweep.ts` | 5c | `grantsSweep` (+ the cross-tenant scans 5a wrote) |
 * | `requests.ts` | 5d | `requestGrant`, `appConfigView`, `repushGrant` |
 * | `holders.ts` | 5d | `grantedKeys`, `pushedSince` |
 * | `detect.ts` | 5e | `scanAppConfig`, `scanShipConfig` |
 */

import type { AppEnvironmentName } from '@launch/shared/launch-apps'
import type { GrantBackend, GrantPushParams, GrantPushReason } from '@launch/shared/launch-grants'
import type { AppBindings } from '../../types'
import { ServiceUnavailableError } from '../../utils/core/errors'
import type { ApprovalDeps, ApprovalViewer } from '../approvals/types'
import type { WorkflowStarter } from '../launch/pipeline/create'

// ---- errors ------------------------------------------------------------------------------------

/**
 * A piece of P5 a later slice builds. Thrown by the 5a stubs so a call that arrives too early
 * fails by NAME rather than by `undefined is not a function` (the P3/P4 pattern).
 */
export class NotWiredError extends Error {
  constructor(what: string, slice: '5b' | '5c' | '5d' | '5e' | '5f') {
    super(`${what} is not wired yet (P5 slice ${slice}, docs/plans/p5-grants.md)`)
    this.name = 'NotWiredError'
  }
}

// ---- who is asking, and with what --------------------------------------------------------------

/**
 * The person asking — the approvals engine's viewer (`approvalViewerOf(auth)`), because the rights
 * are the same shape: role, admin-level, group ids. A resource's OWNERS are the members of its
 * owner group (`viewer.groupIds`), checked in the service, never through CASL (plan §1.3).
 */
export type GrantViewer = ApprovalViewer

/**
 * What a service runs with: the database (a route's, a step's, a cron's), the bindings (the
 * Workflow), config (the sealing key, `GRANT_BACKEND`), a logger, an optional realtime (absent in a
 * Workflow step and a cron — they nudge through `createStepRealtime()`), and for tests `fetch` and
 * `now`. The approvals engine's `ApprovalDeps`, so a kind's effect hands its deps straight on.
 */
export type GrantDeps = ApprovalDeps

// ---- pushes ------------------------------------------------------------------------------------

/**
 * `startPush` (5c): one `grant_pushes` row, then `GRANT_PUSH_WORKFLOW.create({ id: pushId })`.
 * `grantId` null = every live grant of the resource environment (`rotate`); a grant id = that one
 * grant (`grant`, `revoke`, `expire`, `repair`). `versionId` is the version to put (null for a
 * removal). `approvalId` makes a retried `applyAfter` idempotent (unique where set).
 */
export interface StartPushInput {
  tenantId: string
  resourceId: string
  environment: AppEnvironmentName
  reason: GrantPushReason
  grantId?: string | null
  versionId: string | null
  approvalId?: string | null
  startedByUserId?: string | null
}

export interface StartPushResult {
  pushId: string
  /** False when the approval's push already existed (a retried `applyAfter`). */
  created: boolean
}

/** The slice of the `GRANT_PUSH_WORKFLOW` binding a push uses — `RecordingWorkflow` satisfies it. */
export type GrantPushStarter = WorkflowStarter<GrantPushParams>

/**
 * The binding, or 503 `grants_not_configured`. Every writer calls this BEFORE its first row
 * (plan §2): a deployment that cannot push must not record a grant it can never deliver.
 */
export function requireGrantPushWorkflow(
  env: Partial<Pick<AppBindings, 'GRANT_PUSH_WORKFLOW'>>
): GrantPushStarter {
  const binding = (env as { GRANT_PUSH_WORKFLOW?: GrantPushStarter }).GRANT_PUSH_WORKFLOW
  if (!binding) {
    throw new ServiceUnavailableError(
      'Secrets are not configured: this Worker has no GRANT_PUSH_WORKFLOW binding',
      'grants_not_configured'
    )
  }
  return binding
}

// ---- the backing seam (plan §1.11, spec/12 #11) ------------------------------------------------

/** What a put did: the names set, and the plain vars of the live version it replaced. */
export interface GrantPutOutcome {
  names: string[]
  /**
   * The `plain_text` / `json` bindings of the serving version the put replaced with secrets
   * (Cloudflare's 10053 remedy, `backing.ts`) — empty when nothing clashed.
   */
  shadowedVars: string[]
}

/**
 * Where a push writes. `put` sets each entry as a Worker secret on `script` and returns the names
 * put; `putDetailed` is the same write that also says which plain vars it replaced (what the push
 * step calls); `remove` deletes each name (a 404 counts as done) and returns the names removed. A
 * value never leaves through a return, an error message or a log line — the implementation
 * registers every value for redaction first (the `putWorkerSecrets` pattern).
 */
export interface GrantBacking {
  readonly kind: GrantBackend
  put(script: string, entries: Readonly<Record<string, string>>): Promise<string[]>
  putDetailed(script: string, entries: Readonly<Record<string, string>>): Promise<GrantPutOutcome>
  remove(script: string, names: readonly string[]): Promise<string[]>
}
