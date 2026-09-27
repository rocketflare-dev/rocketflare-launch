/**
 * `/api/app-access` (spec/05) — who may sign in to an app through Launch: request access
 * (`POST /requests`), and, for the app's owners and admins, the access policy, the grants and the
 * request queue (`GET|POST /:appId/{policy,grants,requests/:id/decide}`). The P1 stand-in for the
 * P4 approvals.
 *
 * STUB (slice 1a): mounted behind `authMiddleware`, no routes yet — every path answers a JSON 404.
 * Slice 1b owns this file.
 */
import { createRouter } from '../utils/routes/router'

export const appAccessRouter = createRouter()
