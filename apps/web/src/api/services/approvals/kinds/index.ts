/**
 * The kind registry (Launch P4, plan §1.2): one `KindHandler` per BUILT kind, keyed so that a
 * kind with no handler is a type error rather than a runtime `undefined`. The engine dispatches
 * through `kindHandler(kind)` and never names a kind itself.
 *
 * Each handler file is owned by one slice (4c: `app-create`, `app-access`, `session-budget`; 4d:
 * `deploy-production`; P5's 5d: `grant-request`; issue #5's S2: `session-merge`); the foundations
 * slices (4a, 5a, i5 S1) registered them all here so nobody else edits this file. The two kinds
 * spec/08 names but nothing builds yet
 * (`config.change`, `app.teardown`) have no handler, and asking for one is
 * `approval_kind_not_built`.
 */
import {
  APPROVAL_ERROR_CODES,
  type ApprovalKind,
  type BuiltApprovalKind,
  isBuiltApprovalKind,
} from '@launch/shared/launch-approvals'
import { ConflictError } from '../../../utils/core/errors'
import type { KindHandler } from '../types'
import { appAccessHandler } from './app-access'
import { appCreateHandler } from './app-create'
import { deployProductionHandler } from './deploy-production'
import { grantRequestHandler } from './grant-request'
import { sessionBudgetHandler } from './session-budget'
import { sessionMergeHandler } from './session-merge'

export const KIND_HANDLERS: { readonly [K in BuiltApprovalKind]: KindHandler<K> } = {
  'app.create': appCreateHandler,
  'app.access': appAccessHandler,
  'deploy.production': deployProductionHandler,
  'session.budget': sessionBudgetHandler,
  'grant.request': grantRequestHandler,
  'session.merge': sessionMergeHandler,
}

/** The handler for `kind`; 409 `approval_kind_not_built` for a named-but-unbuilt kind. */
export function kindHandler(kind: ApprovalKind): KindHandler {
  if (!isBuiltApprovalKind(kind)) {
    throw new ConflictError(
      `Approvals of kind ${kind} are not built yet`,
      APPROVAL_ERROR_CODES.kindNotBuilt
    )
  }
  return KIND_HANDLERS[kind] as unknown as KindHandler
}
