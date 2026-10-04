/**
 * What the two OpenAI egress handlers share (§18.22-B): `openai.ts` (`api.openai.com`, Launch's
 * key) and `openai-auth.ts` (`auth.openai.com`, the device sign-in and a ChatGPT plan's token
 * refresh; the plan's `chatgpt.com` is reached directly, `registry.ts`) — their injectable dependencies here, and the pure forwarding
 * pieces (the 426 for a WebSocket, the path and model allow-lists, the 415 for a compressed body,
 * the usage meter) re-exported from `forward-openai.ts`, which the sandbox host bundles too, so
 * Launch's rules and the host's are one implementation.
 */
import type { AppConfig } from '../../../../config'
import type { DatabaseHandle } from '../../../../db/client'
import type { AppBindings } from '../../../types'
import type { ModelUpstream } from '../ports'

export {
  createResponsesUsageMeter,
  forwardHeaders,
  type MeteredResponse,
  meteredResponse,
  openAiError,
  type ResponsesCall,
  type ResponsesUsageMeter,
  readResponsesCall,
  refuseWebSocket,
  tokenUsageFromResponses,
} from './forward-openai'

/** Everything an OpenAI handler reaches, injectable so a test drives it with fakes. */
export interface OpenAiEgressDeps {
  upstream: ModelUpstream
  openDb: (env: AppBindings, cfg: AppConfig) => DatabaseHandle
  now: () => Date
}
