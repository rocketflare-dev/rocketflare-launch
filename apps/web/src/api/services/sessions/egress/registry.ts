/**
 * `SESSION_OUTBOUND_HANDLERS` — every host a session (or login) sandbox's outbound traffic is
 * handed to IN LAUNCH'S WORKER (`SessionSandbox.outboundByHost`, §18.22). One table, so the hosts a
 * container may reach through Launch are enumerable in one place:
 *
 * | host               | handler                          | owner                       |
 * |--------------------|----------------------------------|-----------------------------|
 * | `api.anthropic.com`| the model proxy (`anthropic.ts`) — with the subscription OAuth swap and a Claude sign-in's profile passthrough | P3, §18.22-A |
 * | `platform.claude.com` | a Claude sign-in's token exchange (`anthropic.ts` `handleClaudeLoginHost`) — login sandboxes only | §18.22-A |
 * | `github.com`       | the git proxy (`github.ts`)      | P3                          |
 * | `api.openai.com`   | the OpenAI model proxy (`openai.ts`) — Codex on Launch's key | §18.22-B |
 * | `chatgpt.com`      | the ChatGPT-plan model egress (`chatgpt.ts`) — Codex on a person's plan | §18.22-B |
 * | `auth.openai.com`  | the device sign-in and token refresh (`openai-auth.ts`) | §18.22-B |
 *
 * `platform.claude.com` is NOT on `SESSION_BASE_ALLOWED_HOSTS`: only a Claude login sandbox reaches
 * it (its driver's `hosts` join that sandbox's allow-list), and the handler refuses anything that
 * is not a login of the right runtime, passing exactly `CLAUDE_LOGIN_PASSTHROUGH` through.
 *
 * Codex's three hosts (`CODEX_OUTBOUND_HANDLERS`) joined this table and the allow-list
 * (`CODEX_EGRESS_HOSTS` → `SESSION_BASE_ALLOWED_HOSTS`) TOGETHER, with their real handlers: a host on
 * the allow-list with no handler would pass straight through. Each refuses a container that is not
 * a Codex session (or login) of the right kind, so Claude sessions gain nothing from them. The
 * sandbox host (`SESSION_SANDBOX_HOST=remote`, Claude Code only) answers the same hosts with the
 * OpenAI-shaped refusals instead (`refuse.ts`, `src/sandbox-host/hosted-session-sandbox.ts`), and
 * registers nothing for `platform.claude.com` (no Launch credential crosses it).
 *
 * Under `SESSION_EGRESS=allowlist` a host must ALSO be on `SESSION_BASE_ALLOWED_HOSTS` for its
 * handler to run at all (S7). A handler identifies the sandbox by `ctx.containerId`
 * (`sandbox-lookup.ts`), never by anything the sandbox sends.
 */
import type { AppBindings } from '../../../types'
import { handleAnthropic, handleClaudeLoginHost } from './anthropic'
import { handleChatGpt } from './chatgpt'
import type { EgressContext } from './forward-git'
import { handleGitHub } from './github'
import { handleOpenAi } from './openai'
import { handleOpenAiAuth } from './openai-auth'
import { OPENAI_EGRESS_HOSTS } from './refuse'

export type SessionOutboundHandler = (
  req: Request,
  env: unknown,
  ctx: EgressContext
) => Promise<Response>

/** Codex's hosts and their handlers (§18.22-B). */
export const CODEX_OUTBOUND_HANDLERS: Record<string, SessionOutboundHandler> = {
  'api.openai.com': (req, env, ctx) => handleOpenAi(req, env as AppBindings, ctx),
  'chatgpt.com': (req, env, ctx) => handleChatGpt(req, env as AppBindings, ctx),
  'auth.openai.com': (req, env, ctx) => handleOpenAiAuth(req, env as AppBindings, ctx),
}

/** The hosts Codex reaches — on the allow-list with their handlers. */
export const CODEX_EGRESS_HOSTS: readonly string[] = OPENAI_EGRESS_HOSTS

/** What `SessionSandbox.outboundByHost` is. */
export const SESSION_OUTBOUND_HANDLERS: Record<string, SessionOutboundHandler> = {
  'api.anthropic.com': (req, env, ctx) => handleAnthropic(req, env as AppBindings, ctx),
  'platform.claude.com': (req, env, ctx) => handleClaudeLoginHost(req, env as AppBindings, ctx),
  'github.com': (req, env, ctx) => handleGitHub(req, env as AppBindings, ctx),
  ...CODEX_OUTBOUND_HANDLERS,
}
