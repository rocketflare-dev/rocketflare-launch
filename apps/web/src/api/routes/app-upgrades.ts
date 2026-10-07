/**
 * An app's kit upgrades under `/api/apps` (P6 slice 6c, the single-app half), mounted by
 * `routes/apps.ts` with `appsRouter.route('/', appUpgradesRouter)` BEFORE its own `/:slug` routes:
 *
 * - `POST /:id/upgrade` → 202 `startUpgradeResponseSchema` — the app's owners and admins (the
 *   `deployableApp` rule) who may start a session (`create Session`). Refused with 409
 *   `app_archived`, `app_has_no_repo`, `upgrade_no_pin_tag`, `upgrade_not_behind` or
 *   `upgrade_open`, and with every refusal a session start has (`session_limit`,
 *   `session_budget_exhausted`, `sessions_paused`…) unchanged. Audited `app.upgrade.started`.
 * - `GET /:id/upgrades` → `appUpgradeListResponseSchema` — any member who may read the app.
 *
 * The kit status itself ("Requires upgrade → X.Y.Z") rides the app summary and detail
 * (`services/launch/apps.ts`), computed on read against the template pin.
 */
import type { AppUpgradeListResponse, StartUpgradeResponse } from '@launch/shared/launch-upgrades'
import { guardPermission } from '../middleware/permissions'
import { getAppRow } from '../services/launch/apps'
import { auditActor } from '../services/launch/audit'
import { listAppUpgrades, startAppUpgrade, toAppUpgrade } from '../services/launch/upgrades'
import { uuidParam, withAuthAndDb } from '../utils/routes/route-helpers'
import { createRouter } from '../utils/routes/router'
import { deployableApp } from './app-deploys'

export const appUpgradesRouter = createRouter()

/**
 * Start a kit upgrade session for an app. Requires `mayDeployApp` (the app's owners and admins)
 * and `create Session`. 409 `app_archived`, `app_has_no_repo`, `upgrade_no_pin_tag`,
 * `upgrade_not_behind` or `upgrade_open`, plus any ordinary session-start refusal
 * (`session_limit`, `session_budget_exhausted`, `sessions_paused`…). Audits `app.upgrade.started`.
 */
appUpgradesRouter.post('/:id/upgrade', async c => {
  guardPermission(c, 'create', 'Session')
  const { db, cfg, tenantId, user, realtime, app } = await deployableApp(c)
  const { upgrade, session } = await startAppUpgrade(db, c.env, {
    tenantId,
    app,
    userId: user.id,
    actor: auditActor(c),
    realtime,
    cfg,
  })
  const body: StartUpgradeResponse = {
    upgradeId: upgrade.id,
    sessionId: session.id,
    upgrade: toAppUpgrade(upgrade),
  }
  return c.json(body, 202)
})

/** List an app's kit upgrade history. Requires `read App`. */
appUpgradesRouter.get('/:id/upgrades', async c => {
  guardPermission(c, 'read', 'App')
  const { db, tenantId } = withAuthAndDb(c)
  const app = await getAppRow(db, tenantId, uuidParam(c, 'id'))
  const body: AppUpgradeListResponse = {
    items: (await listAppUpgrades(db, tenantId, app.id)).map(toAppUpgrade),
  }
  return c.json(body)
})
