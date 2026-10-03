/**
 * `auth.openai.com` (§18.22-B) — `SessionSandbox.outboundByHost['auth.openai.com']`, for two kinds
 * of container and nothing else:
 *
 * - **A Codex LOGIN sandbox** (`loginForSandbox`: an active `agent_logins` row for `codex`): the
 *   device-code sign-in, passed through untouched — `POST /api/accounts/deviceauth/usercode`, the
 *   `POST /api/accounts/deviceauth/token` poll, and the `POST /oauth/token` exchange. Launch never
 *   runs the exchange; it lets Codex's own reach OpenAI.
 * - **A Codex SESSION on a ChatGPT plan whose turn holds the credential's claim**
 *   (`claimedCodexSession`): `POST /oauth/token` with `grant_type: refresh_token` only — Codex
 *   refreshing its access token (when it is within 5 minutes of expiry, or after a 401). The answer
 *   ROTATES the refresh token, so on a 200 the new tokens are written into the stored `auth.json`
 *   AT ONCE (`resealIfVersion`, a compare-and-set on `version`) — before the response even reaches
 *   Codex — so a container that dies mid-turn cannot take the only valid refresh token with it. A
 *   refusal that means the plan is signed out (`refresh_token_expired`, `refresh_token_reused`,
 *   `refresh_token_invalidated`, a 400 `invalid_grant`, a 401 — Codex 0.160's own "permanent" rule)
 *   marks the credential `needs_login`, and the person reconnects in Profile.
 *
 * Everything else is a 403. The bodies pass through to Codex unchanged; none of them is logged.
 */
import { AGENT_LOGIN_ACTIVE_STATUSES } from '@launch/shared/launch-agents'
import { type AppConfig, loadConfig } from '../../../../config'
import type { Database } from '../../../../db/client'
import { openDatabase } from '../../../../db/client'
import type { AppBindings } from '../../../types'
import { loggerFor } from '../../../utils/core/logger'
import { getById, markNeedsLogin, openSecret, resealIfVersion } from '../credentials/store'
import { parseCodexAuthJson, withRefreshedTokens } from '../runtimes/codex/auth-json'
import { claimedCodexSession } from './chatgpt'
import type { EgressContext } from './forward-git'
import {
  CODEX_REFRESH_PATH,
  isCodexSignInRequest,
  openAiAuthRequest,
  readCodexRefresh,
} from './forward-openai'
import { type OpenAiEgressDeps, openAiError, refuseWebSocket } from './openai-common'
import { loginForSandbox } from './sandbox-lookup'

/** The paths and the upstream: `forward-openai.ts`, shared with the sandbox host. */
export {
  CODEX_LOGIN_AUTH_PATHS,
  CODEX_REFRESH_PATH,
  OPENAI_AUTH_UPSTREAM_ORIGIN,
} from './forward-openai'

/** The refusal codes that mean the plan is signed out (Codex 0.160 `classify_refresh_token_failure`). */
export const SIGNED_OUT_REFRESH_CODES = [
  'refresh_token_expired',
  'refresh_token_reused',
  'refresh_token_invalidated',
] as const

const defaultDeps = (): OpenAiEgressDeps => ({
  upstream: { fetch: req => fetch(req) },
  openDb: (env, cfg) => openDatabase({ ...cfg, HYPERDRIVE: env.HYPERDRIVE }),
  now: () => new Date(),
})

/** The error code a refresh refusal carries — `{ error: { code } }`, `{ error: "…" }` or `{ code }`. */
export function refreshErrorCode(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  const error = b.error
  if (error && typeof error === 'object') {
    const code = (error as Record<string, unknown>).code
    if (typeof code === 'string') return code.toLowerCase()
  }
  if (typeof error === 'string') return error.toLowerCase()
  return typeof b.code === 'string' ? b.code.toLowerCase() : null
}

/** Does this refusal mean the person must sign in again? */
export function refreshSignedOut(status: number, body: unknown): boolean {
  const code = refreshErrorCode(body)
  if (code && (SIGNED_OUT_REFRESH_CODES as readonly string[]).includes(code)) return true
  if (status === 401) return true
  return status === 400 && code === 'invalid_grant'
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * Write the rotated tokens into the stored `auth.json`, compare-and-set on `version`; a lost race
 * re-reads once (a write that already carries this refresh token is the same rotation).
 */
export async function captureRotatedTokens(
  db: Database,
  cfg: AppConfig,
  input: { tenantId: string; credentialId: string; rotated: Record<string, unknown>; now: Date }
): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const row = await getById(db, input.tenantId, input.credentialId)
    if (!row) return false
    const stored = parseCodexAuthJson(await openSecret(cfg, row))
    if (!stored) return false
    if (
      typeof input.rotated.refresh_token === 'string' &&
      stored.tokens.refresh_token === input.rotated.refresh_token
    ) {
      return true
    }
    const next = withRefreshedTokens(stored, input.rotated, input.now)
    const won = await resealIfVersion(db, cfg, {
      tenantId: input.tenantId,
      id: row.id,
      expectedVersion: row.version,
      secret: JSON.stringify(next, null, 2),
      now: input.now,
    })
    if (won) return true
  }
  return false
}

export async function handleOpenAiAuth(
  req: Request,
  env: AppBindings,
  ctx: EgressContext,
  overrides: Partial<OpenAiEgressDeps> = {}
): Promise<Response> {
  const upgrade = refuseWebSocket(req)
  if (upgrade) return upgrade
  const deps = { ...defaultDeps(), ...overrides }
  const cfg = loadConfig(env)
  const logger = loggerFor(cfg, { handler: 'egress', host: 'auth.openai.com' })
  const url = new URL(req.url)
  if (req.method !== 'POST') {
    return openAiError(403, 'permission_error', `Launch sessions may not call ${url.pathname}`)
  }

  const handle = deps.openDb(env, cfg)
  try {
    // 1. A Codex login sandbox: the device flow, untouched.
    const login = await loginForSandbox(handle.db, ctx.containerId)
    if (login) {
      const active = (AGENT_LOGIN_ACTIVE_STATUSES as readonly string[]).includes(login.status)
      if (login.runtime !== 'codex' || !active || !isCodexSignInRequest(req)) {
        return openAiError(403, 'permission_error', `Launch sign-ins may not call ${url.pathname}`)
      }
      const body = await req.text()
      try {
        return await deps.upstream.fetch(openAiAuthRequest(req, body))
      } catch (err) {
        logger.warn({ err, loginId: login.id }, 'openai auth: upstream unreachable (login)')
        return openAiError(502, 'api_error', 'Launch could not reach OpenAI sign-in')
      }
    }

    // 2. A Codex session on a ChatGPT plan, mid-turn: the token refresh only.
    if (url.pathname !== CODEX_REFRESH_PATH) {
      return openAiError(403, 'permission_error', `Launch sessions may not call ${url.pathname}`)
    }
    const found = await claimedCodexSession(handle.db, ctx.containerId, deps.now())
    if (found instanceof Response) return found
    const body = await readCodexRefresh(req)
    if (body instanceof Response) return body

    let res: Response
    try {
      res = await deps.upstream.fetch(openAiAuthRequest(req, body))
    } catch (err) {
      logger.warn({ err, sessionId: found.session.id }, 'openai auth: upstream unreachable')
      return openAiError(502, 'api_error', 'Launch could not reach OpenAI sign-in')
    }

    const text = await res.text()
    const answer = parseJson(text)
    const { tenantId } = found.session
    if (res.ok && answer && typeof answer === 'object') {
      const captured = await captureRotatedTokens(handle.db, cfg, {
        tenantId,
        credentialId: found.credentialId,
        rotated: answer as Record<string, unknown>,
        now: deps.now(),
      }).catch(err => {
        logger.error(
          { err, sessionId: found.session.id },
          'openai auth: could not store the refresh'
        )
        return false
      })
      if (!captured) {
        logger.warn(
          { sessionId: found.session.id },
          'openai auth: the refreshed tokens were not stored'
        )
      }
    } else if (refreshSignedOut(res.status, answer)) {
      await markNeedsLogin(handle.db, tenantId, found.credentialId, deps.now()).catch(err =>
        logger.error(
          { err, sessionId: found.session.id },
          'openai auth: could not mark needs_login'
        )
      )
    }
    // The body was read (and decoded) here: its length and encoding headers no longer describe it.
    const headers = new Headers(res.headers)
    headers.delete('content-length')
    headers.delete('content-encoding')
    return new Response(text, { status: res.status, statusText: res.statusText, headers })
  } finally {
    await handle.close()
  }
}
