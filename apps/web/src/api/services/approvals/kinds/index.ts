/**
 * The kind registry (Launch P4, plan §1.2): one `KindHandler` per BUILT kind, keyed so that a
 * kind with no handler is a type error rather than a runtime `undefined`. The engine dispatches
 * through `kindHandler(kind)` and never names a kind itself.
 *
 * Each handler file is owned by one slice (4c: `app-create`, `app-access`, `session-budget`; 4d:
 * `deploy-production`); 4a registered them all here so nobody else edits this file. The three
 * kinds spec/08 names but P4 does not build (`grant.request`, `config.change`, `app.teardown`)
 * have no handler, and asking for one is `approval_kind_not_built`.
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
import { sessionBudgetHandler } from './session-budget'

export const KIND_HANDLERS: { readonly [K in BuiltApprovalKind]: KindHandler<K> } = {
  'app.create': appCreateHandler,
  'app.access': appAccessHandler,
  'deploy.production': deployProductionHandler,
  'session.budget': sessionBudgetHandler,
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
