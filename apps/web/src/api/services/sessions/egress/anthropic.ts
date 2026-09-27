/**
 * The model proxy (Launch P3, plan §1.4) — `SessionSandbox.outboundByHost['api.anthropic.com']`,
 * running IN LAUNCH'S WORKER for every request a session's Claude Code makes. The sandbox holds
 * only `ANTHROPIC_API_KEY=launch-session-placeholder`; this handler:
 *
 * 1. finds the session from `ctx.containerId` → `sessions.sandbox_id` (unique) — a server-side
 *    lookup, so the sandbox cannot forge who it is. Unknown → 403;
 * 2. allows only `POST /v1/messages` and `/v1/messages/count_tokens`, and only `policy.model`;
 * 3. checks the budget (over → an Anthropic-shaped 403 `permission_error`, no upstream call);
 * 4. swaps in the real key (`anthropic_api_key` credential, else `cfg.ANTHROPIC_API_KEY`) and
 *    sends it through `deps.upstream` (`ModelUpstream`);
 * 5. meters usage from the SSE or JSON response as it streams back (ported from
 *    `spikes/s7-sandbox/worker/src/index.js`) into `ai_usage` (`recordUsage` with `sessionId`) and
 *    the session's running totals, atomically.
 *
 * **Pre-tenant by design**, like `/ci/*`: the only thing this request carries is the container id,
 * so the session lookup names no tenant and the tenant is then taken from the row — the entry for
 * this file in `tests/config/unscoped-allowlist.test.ts`.
 *
 * **Slice 3c owns this file.** From 3a it is real up to step 1 — the lookup, and the 403 for a
 * container that is not a live session — and answers 503 `not wired` after it.
 */
import { ACTIVE_SESSION_STATUSES } from '@launch/shared/launch-sessions'
import { and, eq, inArray } from 'drizzle-orm'
import { type AppConfig, loadConfig } from '../../../../config'
import { type Database, type DatabaseHandle, openDatabase } from '../../../../db/client'
import { type SessionRow, sessions } from '../../../../db/schema'
import type { AppBindings } from '../../../types'
import type { ModelUpstream } from '../ports'

/** What the platform hands an outbound handler (`OutboundHandlerContext` in `@cloudflare/containers`). */
export interface EgressContext {
  /** The Durable Object id of the sandbox — `sessions.sandbox_id`. */
  containerId: string
  className?: string
}

/** Everything the handler reaches, injectable so a test drives it with fakes. */
export interface AnthropicEgressDeps {
  upstream: ModelUpstream
  openDb: (env: AppBindings, cfg: AppConfig) => DatabaseHandle
  now: () => Date
}

/** The placeholder the sandbox is started with; it must never reach Anthropic. */
export const MODEL_KEY_PLACEHOLDER = 'launch-session-placeholder'

/** An error in Anthropic's own shape, so Claude Code reports it as the API would. */
export function anthropicError(status: number, type: string, message: string): Response {
  return Response.json({ type: 'error', error: { type, message } }, { status })
}

/**
 * The live session a container belongs to, or null. PRE-TENANT: `sandbox_id` is unique and the
 * platform — not the sandbox — supplies it; the tenant is taken from the row that comes back.
 */
export async function sessionForSandbox(
  db: Database,
  sandboxId: string
): Promise<SessionRow | null> {
  const [row] = await db
    .select()
    .from(sessions)
    .where(
      and(eq(sessions.sandboxId, sandboxId), inArray(sessions.status, [...ACTIVE_SESSION_STATUSES]))
    )
    .limit(1)
  return row ?? null
}

const defaultDeps = (): AnthropicEgressDeps => ({
  upstream: { fetch: req => fetch(req) },
  openDb: (env, cfg) => openDatabase({ ...cfg, HYPERDRIVE: env.HYPERDRIVE }),
  now: () => new Date(),
})

export async function handleAnthropic(
  _req: Request,
  env: AppBindings,
  ctx: EgressContext,
  overrides: Partial<AnthropicEgressDeps> = {}
): Promise<Response> {
  const deps = { ...defaultDeps(), ...overrides }
  const cfg = loadConfig(env)
  const handle = deps.openDb(env, cfg)
  try {
    const session = await sessionForSandbox(handle.db, ctx.containerId)
    if (!session) {
      return anthropicError(403, 'permission_error', 'This sandbox is not a live Launch session')
    }
    return anthropicError(503, 'api_error', 'The Launch model proxy is not wired yet (P3 slice 3c)')
  } finally {
    await handle.close()
  }
}
