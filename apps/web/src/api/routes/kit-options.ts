/**
 * `/api/kits` (D36 K5) — the kits a new app may be cut from, for Create app's picker and
 * `launch apps kits`. Any member who may read apps (`read App`: every member may ASK to create
 * one). Only the verified kits and the default (`kits/options.ts`), and only what choosing needs —
 * the catalogue itself (pins, problems, manifests) stays behind `/api/platform/kits`.
 *
 *   GET /    the offered kits, the default first
 */
import type { KitOptionsResponse } from '@launch/shared/kits'
import { guardPermission } from '../middleware/permissions'
import { listKitOptions } from '../services/launch/kits/options'
import { withAuthAndDb } from '../utils/routes/route-helpers'
import { createRouter } from '../utils/routes/router'

export const kitOptionsRouter = createRouter()

/** List the kits a new app may be created from (verified ones and the default), default first. */
kitOptionsRouter.get('/', async c => {
  guardPermission(c, 'read', 'App')
  const { db } = withAuthAndDb(c)
  const body: KitOptionsResponse = { kits: await listKitOptions(db) }
  return c.json(body)
})
