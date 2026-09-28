/**
 * `app.create` (Launch P4, plan §4c): a member below `launch_settings.app_create_role` ASKS to
 * create an app. `POST /api/apps` writes the app `requested` and opens this; `defaultPolicy`
 * overlays `autoApproveRole` with the setting (`?? 'admin'`), so an admin is auto-approved and
 * `applyAfter` starts `APP_LAUNCH_WORKFLOW` exactly as P2 did; a rejection or expiry archives the
 * app (`app.create.rejected`).
 *
 * Slice 4c owns this file; 4a registered it in `kinds/index.ts` with a default policy and a
 * title, and effects that throw `NotWiredError`.
 */
import { DEFAULT_APPROVAL_POLICIES } from '@launch/shared/launch-approvals'
import { type KindHandler, NotWiredError } from '../types'

export const appCreateHandler: KindHandler<'app.create'> = {
  kind: 'app.create',
  async defaultPolicy() {
    return DEFAULT_APPROVAL_POLICIES['app.create']
  },
  describe(request) {
    return `Create app ${request.context.kind === 'app.create' ? request.context.slug : request.subjectId}`
  },
  async applyInTx() {
    throw new NotWiredError('app.create applyInTx', '4c')
  },
  async applyAfter() {
    throw new NotWiredError('app.create applyAfter', '4c')
  },
}
