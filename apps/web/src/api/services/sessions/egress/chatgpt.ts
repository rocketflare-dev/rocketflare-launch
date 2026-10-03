/**
 * The ChatGPT-plan model egress (§18.22-B) — `SessionSandbox.outboundByHost['chatgpt.com']`, for a
 * Codex session on a PERSON's plan. Codex itself holds the plan's tokens for the turn (the leased
 * `auth.json`, `runtimes/codex/credentials.ts`) and sends `Authorization: Bearer <access token>` and
 * `ChatGPT-Account-ID`; this handler passes them through, but only:
 *
 * - after a WebSocket upgrade was answered 426 (Codex then streams over HTTP);
 * - for a live Codex session on a personal account whose turn HOLDS the credential's claim right
 *   now (`claimed_by_session_id`, unexpired) — a container outside a turn has no business here;
 * - to `GET /backend-api/codex/models` and `POST /backend-api/codex/responses` (and its
 *   `/compact`), the latter for the policy's model only. Everything else is a 403 —
 *   `/backend-api/codex/analytics-events/*` included (Codex's `config.toml` turns analytics off;
 *   this is the boundary if it did not).
 *
 * Usage is metered from the stream like Launch's own key, as `billing: 'subscription'`: tokens
 * recorded, cost null, no money budget (the person's plan pays). A 401 is passed back untouched —
 * Codex refreshes its token through `auth.openai.com` (`openai-auth.ts`) and retries.
 */
import { resolveSessionPolicy } from '@launch/shared/launch-sessions'
import { loadConfig } from '../../../../config'
import { openDatabase } from '../../../../db/client'
import type { SessionRow } from '../../../../db/schema'
import type { AppBindings } from '../../../types'
import { loggerFor } from '../../../utils/core/logger'
import { getById } from '../credentials/store'
import { recordSessionUsage } from './anthropic'
import type { EgressContext } from './forward-git'
import {
  forwardHeaders,
  meteredResponse,
  type OpenAiEgressDeps,
  openAiError,
  type ResponsesCall,
  readResponsesCall,
  refuseWebSocket,
} from './openai-common'
import { sessionForSandbox } from './sandbox-lookup'

export const CHATGPT_UPSTREAM_ORIGIN = 'https://chatgpt.com'
export const CHATGPT_MODEL_PATHS = [
  '/backend-api/codex/responses',
  '/backend-api/codex/responses/compact',
] as const
export const CHATGPT_MODELS_PATH = '/backend-api/codex/models'

const defaultDeps = (): OpenAiEgressDeps => ({
  upstream: { fetch: req => fetch(req) },
  openDb: (env, cfg) => openDatabase({ ...cfg, HYPERDRIVE: env.HYPERDRIVE }),
  now: () => new Date(),
})

/**
 * The session a request from `containerId` belongs to, if it is a Codex session on a personal
 * account whose turn holds the credential's claim right now; else the refusal. Shared with
 * `openai-auth.ts` (the token refresh needs the same proof).
 */
export async function claimedCodexSession(
  db: Parameters<typeof sessionForSandbox>[0],
  containerId: string,
  now: Date
): Promise<{ session: SessionRow; credentialId: string } | Response> {
  const session = await sessionForSandbox(db, containerId)
  if (!session)
    return openAiError(403, 'permission_error', 'This sandbox is not a live Launch session')
  if (
    session.runtime !== 'codex' ||
    session.credentialSource !== 'user' ||
    !session.agentCredentialId
  ) {
    return openAiError(403, 'permission_error', 'This Launch session does not use a ChatGPT plan')
  }
  const credential = await getById(db, session.tenantId, session.agentCredentialId)
  const held =
    credential &&
    credential.claimedBySessionId === session.id &&
    credential.claimExpiresAt !== null &&
    credential.claimExpiresAt.getTime() > now.getTime()
  if (!credential || !held) {
    return openAiError(403, 'permission_error', 'No turn of this session is using the ChatGPT plan')
  }
  return { session, credentialId: credential.id }
}

export async function handleChatGpt(
  req: Request,
  env: AppBindings,
  ctx: EgressContext,
  overrides: Partial<OpenAiEgressDeps> = {}
): Promise<Response> {
  const upgrade = refuseWebSocket(req)
  if (upgrade) return upgrade
  const deps = { ...defaultDeps(), ...overrides }
  const cfg = loadConfig(env)
  const logger = loggerFor(cfg, { handler: 'egress', host: 'chatgpt.com' })
  const url = new URL(req.url)

  const isModels = req.method === 'GET' && url.pathname === CHATGPT_MODELS_PATH
  const isModelCall =
    req.method === 'POST' && (CHATGPT_MODEL_PATHS as readonly string[]).includes(url.pathname)
  if (!isModels && !isModelCall) {
    return openAiError(403, 'permission_error', `Launch sessions may not call ${url.pathname}`)
  }

  const handle = deps.openDb(env, cfg)
  let session: SessionRow
  let call: ResponsesCall | null = null
  try {
    const found = await claimedCodexSession(handle.db, ctx.containerId, deps.now())
    if (found instanceof Response) return found
    session = found.session
    if (isModelCall) {
      const read = await readResponsesCall(req, resolveSessionPolicy(session.policy).model)
      if (read instanceof Response) return read
      call = read
    }
  } finally {
    await handle.close()
  }

  // The plan's own token and account id, as Codex sent them — this host is the person's account.
  const headers = forwardHeaders(req, { dropAuth: false })
  const upstreamReq = call
    ? new Request(`${CHATGPT_UPSTREAM_ORIGIN}${call.path}${call.search}`, {
        method: 'POST',
        headers,
        body: call.body,
      })
    : new Request(`${CHATGPT_UPSTREAM_ORIGIN}${url.pathname}${url.search}`, {
        method: 'GET',
        headers,
      })

  let res: Response
  try {
    res = await deps.upstream.fetch(upstreamReq)
  } catch (err) {
    logger.warn({ err, sessionId: session.id }, 'chatgpt egress: upstream unreachable')
    return openAiError(502, 'api_error', 'Launch could not reach ChatGPT')
  }
  if (!call) return res

  const model = call.model
  return meteredResponse(res, async metered => {
    const recordHandle = deps.openDb(env, cfg)
    try {
      await recordSessionUsage(recordHandle.db, session, metered.model ?? model, metered.usage, {
        provider: 'openai',
        billing: 'subscription',
      })
    } catch (err) {
      logger.error({ err, sessionId: session.id }, 'chatgpt egress: could not record usage')
    } finally {
      await recordHandle.close()
    }
  })
}
