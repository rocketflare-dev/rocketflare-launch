/**
 * The OpenAI model proxy (§18.22-B) — `SessionSandbox.outboundByHost['api.openai.com']`, running
 * IN LAUNCH'S WORKER for every request a Codex session on LAUNCH'S account makes. The sandbox
 * holds only `CODEX_API_KEY=launch-session-placeholder`; this handler, like `anthropic.ts`:
 *
 * 1. answers a WebSocket upgrade with 426, so Codex streams over HTTP (`openai-common.ts`);
 * 2. finds the session from `ctx.containerId` (`sessionForSandbox`, pre-tenant) — unknown, not a
 *    live session, not Codex, or not on Launch's account → 403;
 * 3. allows `GET /v1/models` (Codex's model discovery: keyed, free, not metered) and
 *    `POST /v1/responses` (and its `/compact`) for the policy's model only → 403 otherwise;
 * 4. checks the budget (`budget.ts`) — over is an OpenAI-shaped 403 and NO upstream call;
 * 5. swaps in Launch's key (`resolveOpenAiKey`: the `openai_api_key` credential, else
 *    `cfg.OPENAI_API_KEY`) as `Authorization: Bearer` — the sandbox's own header (the placeholder)
 *    is dropped first — and sends it to `https://api.openai.com`, path and query from the request;
 * 6. meters the answer as it streams back (`response.completed`) and records one `ai_usage` row,
 *    provider `openai`, plus the session's running totals, in one transaction
 *    (`recordSessionUsage`).
 *
 * Every refusal is OpenAI's error shape, so Codex reports it as it would the API's. No response,
 * log line or error message carries the key or the placeholder.
 */
import { resolveSessionPolicy } from '@launch/shared/launch-sessions'
import { loadConfig } from '../../../../config'
import { openDatabase } from '../../../../db/client'
import type { SessionRow } from '../../../../db/schema'
import type { AppBindings } from '../../../types'
import { loggerFor } from '../../../utils/core/logger'
import { checkBudget } from '../budget'
import { resolveOpenAiKey } from '../model-key'
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

/** Where a keyed request goes; the path and query come from the sandbox's request. */
export const OPENAI_UPSTREAM_ORIGIN = 'https://api.openai.com'

/** The model calls a Codex session may make on Launch's key. */
export const OPENAI_MODEL_PATHS = ['/v1/responses', '/v1/responses/compact'] as const
/** Codex's model discovery: keyed, not metered. */
export const OPENAI_MODELS_PATH = '/v1/models'

const defaultDeps = (): OpenAiEgressDeps => ({
  upstream: { fetch: req => fetch(req) },
  openDb: (env, cfg) => openDatabase({ ...cfg, HYPERDRIVE: env.HYPERDRIVE }),
  now: () => new Date(),
})

export async function handleOpenAi(
  req: Request,
  env: AppBindings,
  ctx: EgressContext,
  overrides: Partial<OpenAiEgressDeps> = {}
): Promise<Response> {
  const upgrade = refuseWebSocket(req)
  if (upgrade) return upgrade
  const deps = { ...defaultDeps(), ...overrides }
  const cfg = loadConfig(env)
  const logger = loggerFor(cfg, { handler: 'egress', host: 'api.openai.com' })
  const url = new URL(req.url)
  const handle = deps.openDb(env, cfg)
  let session: SessionRow
  let apiKey: string
  let call: ResponsesCall | null = null
  try {
    const found = await sessionForSandbox(handle.db, ctx.containerId)
    if (!found)
      return openAiError(403, 'permission_error', 'This sandbox is not a live Launch session')
    if (found.runtime !== 'codex' || found.credentialSource !== 'platform') {
      return openAiError(
        403,
        'permission_error',
        'This Launch session does not use Launch’s OpenAI key'
      )
    }
    session = found

    const isModels = req.method === 'GET' && url.pathname === OPENAI_MODELS_PATH
    if (!isModels) {
      if (
        req.method !== 'POST' ||
        !(OPENAI_MODEL_PATHS as readonly string[]).includes(url.pathname)
      ) {
        return openAiError(
          403,
          'permission_error',
          `Launch sessions may only call POST ${OPENAI_MODEL_PATHS.join(' and ')} and GET ${OPENAI_MODELS_PATH}`
        )
      }
      const read = await readResponsesCall(req, resolveSessionPolicy(session.policy).model)
      if (read instanceof Response) return read
      call = read

      const verdict = await checkBudget(handle.db, session, deps.now())
      if (!verdict.ok) {
        return openAiError(
          403,
          'permission_error',
          verdict.scope === 'session'
            ? 'This Launch session has reached its budget. Ask an app owner to extend it.'
            : "This app's coding sessions have reached their monthly budget."
        )
      }
    }

    const key = await resolveOpenAiKey(handle.db, cfg)
    if (!key) return openAiError(503, 'api_error', 'Launch has no OpenAI key configured')
    apiKey = key.apiKey
  } finally {
    await handle.close()
  }

  const headers = forwardHeaders(req, { dropAuth: true })
  headers.set('authorization', `Bearer ${apiKey}`)
  const upstreamReq = call
    ? new Request(`${OPENAI_UPSTREAM_ORIGIN}${call.path}${call.search}`, {
        method: 'POST',
        headers,
        body: call.body,
      })
    : new Request(`${OPENAI_UPSTREAM_ORIGIN}${url.pathname}${url.search}`, {
        method: 'GET',
        headers,
      })

  let res: Response
  try {
    res = await deps.upstream.fetch(upstreamReq)
  } catch (err) {
    logger.warn({ err, sessionId: session.id }, 'openai proxy: upstream unreachable')
    return openAiError(502, 'api_error', 'Launch could not reach the OpenAI API')
  }
  if (!call) return res

  const model = call.model
  return meteredResponse(res, async metered => {
    const recordHandle = deps.openDb(env, cfg)
    try {
      await recordSessionUsage(recordHandle.db, session, metered.model ?? model, metered.usage, {
        provider: 'openai',
      })
    } catch (err) {
      logger.error({ err, sessionId: session.id }, 'openai proxy: could not record usage')
    } finally {
      await recordHandle.close()
    }
  })
}
