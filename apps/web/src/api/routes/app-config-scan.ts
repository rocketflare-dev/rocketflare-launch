/**
 * Re-scanning an app's declared config under `/api/apps` (Launch P5, plan §1.14, §4 5e), mounted by
 * `routes/apps.ts` before its own `/:slug` routes, behind the `/api/apps` mount's `authMiddleware`.
 * Slice 5e builds it over `services/grants/detect.ts`:
 *
 * - `POST /:id/config/scan` → 200 `appConfigSchema` (the app's owners and admins): read the repo's
 *   default branch, match, record, notify; a scan failure is recorded on the scan row and still
 *   answers the config view.
 *
 * A file of its own (the plan put the handler in `app-config.ts`) so 5d and 5e never edit one file.
 * From 5a it registers nothing.
 */
import { createRouter } from '../utils/routes/router'

export const appConfigScanRouter = createRouter()
