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
 * | `auth.openai.com`  | the device sign-in and token refresh (`openai-auth.ts`) | §18.22-B |
 *
 * `platform.claude.com` is NOT on `SESSION_BASE_ALLOWED_HOSTS`: only a Claude login sandbox reaches
 * it (its driver's `hosts` join that sandbox's allow-list), and the handler refuses anything that
 * is not a login of the right runtime, passing exactly `CLAUDE_LOGIN_PASSTHROUGH` through.
 *
 * Codex's hosts (`CODEX_EGRESS_HOSTS` → `SESSION_BASE_ALLOWED_HOSTS`) are on the allow-list; two of
 * them have handlers here (`CODEX_OUTBOUND_HANDLERS`), each refusing a container that is not a
 * Codex session (or login) of the right kind, so Claude sessions gain nothing from them.
 *
 * **`chatgpt.com` has NO handler, on purpose** ({@link DIRECT_CODEX_HOSTS}): ChatGPT answers a
 * request sent from the Workers runtime with a 403 HTML block page (the identical request from
 * curl or Node gets its normal JSON), so a handler re-fetching it from this Worker breaks every
 * Codex turn on a person's plan. With no handler, the container reaches it DIRECTLY with Codex's
 * own client — under `SESSION_EGRESS=open` (the tomls) only `outboundByHost` hosts are intercepted.
 * Nothing secret is lost: on a ChatGPT plan the container already holds the person's `auth.json`
 * for the turn (§18.22-B); what goes is the path allow-list (Codex's `config.toml` turns analytics,
 * feedback and OTEL off) and per-request metering — the turn is metered from Codex's own
 * `turn.completed` instead (`turn-meter.ts`, `runtimes/process/turn.ts`). Under `allowlist` it
 * does NOT work: any
 * allow-list makes `@cloudflare/containers` 0.3.7 intercept every HTTPS connection and its
 * `ContainerProxy` re-fetches an allowed host with no handler from the Worker — which ChatGPT
 * blocks — and the runtime has no way to exempt one host (§18.22-B known gaps).
 *
 * The remote sandbox host's `HostedSessionSandbox` (`src/sandbox-host/hosted-session-sandbox.ts`)
 * handles exactly the hosts of this table too, from the egress grant Launch sends it, through the
 * same forwarding functions (`forward-git.ts`, `forward-model.ts`, `forward-openai.ts`) — a test
 * keeps the two key sets equal.
 *
 * Under `SESSION_EGRESS=allowlist` a host must ALSO be on `SESSION_BASE_ALLOWED_HOSTS` for its
 * handler to run at all (S7). A handler identifies the sandbox by `ctx.containerId`
 * (`sandbox-lookup.ts`), never by anything the sandbox sends.
 */
import type { AppBindings } from '../../../types'
import { handleAnthropic, handleClaudeLoginHost } from './anthropic'
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

/** Codex's handled hosts and their handlers (§18.22-B) — every Codex host but `chatgpt.com`. */
export const CODEX_OUTBOUND_HANDLERS: Record<string, SessionOutboundHandler> = {
  'api.openai.com': (req, env, ctx) => handleOpenAi(req, env as AppBindings, ctx),
  'auth.openai.com': (req, env, ctx) => handleOpenAiAuth(req, env as AppBindings, ctx),
}

/** The hosts Codex reaches — all on the allow-list. */
export const CODEX_EGRESS_HOSTS: readonly string[] = OPENAI_EGRESS_HOSTS

/**
 * Allow-listed hosts the container reaches DIRECTLY — no handler in either sandbox class, because
 * ChatGPT blocks requests from the Workers runtime (see the header).
 */
export const DIRECT_CODEX_HOSTS: readonly string[] = ['chatgpt.com']

/** What `SessionSandbox.outboundByHost` is. */
export const SESSION_OUTBOUND_HANDLERS: Record<string, SessionOutboundHandler> = {
  'api.anthropic.com': (req, env, ctx) => handleAnthropic(req, env as AppBindings, ctx),
  'platform.claude.com': (req, env, ctx) => handleClaudeLoginHost(req, env as AppBindings, ctx),
  'github.com': (req, env, ctx) => handleGitHub(req, env as AppBindings, ctx),
  ...CODEX_OUTBOUND_HANDLERS,
}
