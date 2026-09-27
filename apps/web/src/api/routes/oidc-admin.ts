/**
 * `/api/admin/oidc` (spec/05) — the issuer's signing keys: list them, and `POST /rotate`. Mounted
 * under `/api/admin`, so `globalAdminMiddleware` already applies: the key set is issuer-wide,
 * not an organisation's.
 *
 * STUB (slice 1a): mounted and guarded, no routes yet — every path answers a JSON 404. Slice 1b
 * owns this file.
 */
import { createRouter } from '../utils/routes/router'

export const oidcAdminRouter = createRouter()
