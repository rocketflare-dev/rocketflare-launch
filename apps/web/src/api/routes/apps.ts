/**
 * `/api/apps` (spec/06) — the registry: the catalogue, one app's detail, import from a repo,
 * an on-demand health check and the app's OIDC client. Members read (`read App`); admins manage.
 *
 * STUB (slice 1a): mounted behind `authMiddleware`, no routes yet — every path answers a JSON 404.
 * Slice 1d owns this file.
 */
import { createRouter } from '../utils/routes/router'

export const appsRouter = createRouter()
