/**
 * Re-scanning an app's declared config under `/api/apps` (Launch P5, plan §1.14, §4 5e), mounted by
 * `routes/apps.ts` before its own `/:slug` routes, behind the `/api/apps` mount's `authMiddleware`,
 * over `services/grants/detect.ts`:
 *
 * - `POST /:id/config/scan` → 200 `appConfigSchema` (the app's owners and admins,
 *   `deployableApp`): read the repo's default branch, match, record, notify; a scan failure is
 *   recorded on the scan row (`scan.error`) and still answers the config view.
 *
 * The answer is `appConfigView` (5d's), the same body `GET /:id/config` gives, so the page swaps it
 * in without a second read. A file of its own (the plan put the handler in `app-config.ts`) so 5d
 * and 5e never edit one file.
 */
import { appConfigSchema } from '@launch/shared/launch-grants'
import { approvalViewerOf } from '../services/approvals/types'
import { scanAppConfig } from '../services/grants/detect'
import { appConfigView } from '../services/grants/requests'
import { createRouter } from '../utils/routes/router'
import { deployableApp } from './app-deploys'
import { approvalDepsOf } from './approvals'

export const appConfigScanRouter = createRouter()

appConfigScanRouter.post('/:id/config/scan', async c => {
  const ctx = await deployableApp(c)
  await scanAppConfig(approvalDepsOf(c), {
    tenantId: ctx.tenantId,
    appId: ctx.app.id,
    ref: null,
    trigger: 'rescan',
  })
  const viewer = approvalViewerOf({ ...ctx.auth, tenantId: ctx.tenantId })
  return c.json(appConfigSchema.parse(await appConfigView(ctx.db, viewer, ctx.app.id)))
})
