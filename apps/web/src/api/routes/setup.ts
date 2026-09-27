/**
 * `/api/admin/setup` (spec/03, spec/04) — the setup wizard's API: every step's status (never a
 * credential value), the platform settings, and put / check / delete for each sealed credential.
 * Mounted under `/api/admin`, so `globalAdminMiddleware` already applies.
 *
 * STUB (slice 1a): mounted and guarded, no routes yet — every path answers a JSON 404. Slice 1c
 * owns this file.
 */
import { createRouter } from '../utils/routes/router'

export const setupRouter = createRouter()
