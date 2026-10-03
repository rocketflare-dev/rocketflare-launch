/**
 * `SESSION_OUTBOUND_HANDLERS` — every host a session (or login) sandbox's outbound traffic is
 * handed to IN LAUNCH'S WORKER (`SessionSandbox.outboundByHost`, §18.22). One table, so the hosts a
 * container may reach through Launch are enumerable in one place:
 *
 * | host               | handler                          | owner                       |
 * |--------------------|----------------------------------|-----------------------------|
 * | `api.anthropic.com`| the model proxy (`anthropic.ts`) | P3 (Stream A adds the OAuth swap and the login passthrough inside it) |
 * | `github.com`       | the git proxy (`github.ts`)      | P3                          |
 *
 * **Codex's hosts are staged, not registered.** `CODEX_OUTBOUND_HANDLERS` answers `api.openai.com`,
 * `chatgpt.com` and `auth.openai.com` with a 403 (`refuse.ts`), and `CODEX_EGRESS_HOSTS` is what
 * joins `SESSION_BASE_ALLOWED_HOSTS` — but both go live TOGETHER, in Stream B, when the real
 * handlers (`openai.ts`, `chatgpt.ts`, `openai-auth.ts`) replace the refusals: a host on the
 * allow-list with no handler would pass straight through, and registering refusals now would
 * change the handler set every existing session runs with for no behaviour. Until then a Codex
 * session cannot exist (`SESSION_RUNTIMES` defaults to `claude_code`, and Codex's turn stubs throw).
 *
 * Under `SESSION_EGRESS=allowlist` a host must ALSO be on `SESSION_BASE_ALLOWED_HOSTS` for its
 * handler to run at all (S7). A handler identifies the sandbox by `ctx.containerId`
 * (`sandbox-lookup.ts`), never by anything the sandbox sends.
 */
import type { AppBindings } from '../../../types'
import { handleAnthropic } from './anthropic'
import type { EgressContext } from './forward-git'
import { handleGitHub } from './github'
import { OPENAI_EGRESS_HOSTS, refuseHost } from './refuse'

export type SessionOutboundHandler = (
  req: Request,
  env: unknown,
  ctx: EgressContext
) => Promise<Response>

/** What `SessionSandbox.outboundByHost` is. */
export const SESSION_OUTBOUND_HANDLERS: Record<string, SessionOutboundHandler> = {
  'api.anthropic.com': (req, env, ctx) => handleAnthropic(req, env as AppBindings, ctx),
  'github.com': (req, env, ctx) => handleGitHub(req, env as AppBindings, ctx),
}

/** The hosts Codex reaches — joining the allow-list with their handlers, in Stream B. */
export const CODEX_EGRESS_HOSTS: readonly string[] = OPENAI_EGRESS_HOSTS

/** Codex's hosts, refused until Stream B replaces each entry with its real handler. */
export const CODEX_OUTBOUND_HANDLERS: Record<string, SessionOutboundHandler> = Object.fromEntries(
  OPENAI_EGRESS_HOSTS.map(host => [host, refuseHost(host)])
)
