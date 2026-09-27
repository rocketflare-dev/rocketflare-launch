/**
 * Launch as the company's OIDC issuer (spec/05) — the PUBLIC protocol surface every app calls.
 * Mounted outside `/api` with no `authMiddleware`: `/.well-known/*` is anonymous by definition,
 * `/oidc/authorize` reads the session cookie itself (like `/auth/cli`), and `/oidc/token` /
 * `/oidc/userinfo` authenticate the CLIENT or the access token, not a Launch session.
 *
 * STUB (slice 1a): the routers exist so `api/index.ts`, `API_PREFIXES` and both tomls'
 * `run_worker_first` are wired once. Until slice 1b fills them, every path beneath the two prefixes
 * falls through to the catch-all and answers a JSON 404 — never `index.html`.
 *
 * 1b owns this file: `GET /.well-known/openid-configuration`, `GET /.well-known/jwks.json`,
 * `GET /oidc/authorize`, `POST /oidc/token`, `GET|POST /oidc/userinfo`, `GET /oidc/logout`.
 */
import { createRouter } from '../utils/routes/router'

/** `/oidc/*` — authorize, token, userinfo, logout. */
export const oidcRouter = createRouter()

/** `/.well-known/*` — discovery and the JWKS. */
export const wellKnownRouter = createRouter()
