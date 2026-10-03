/**
 * Who a sandbox is, from the platform's `ctx.containerId` (§18.22) — the egress handlers' ONE
 * pre-tenant read. `sessions.sandbox_id` and `agent_logins.sandbox_id` are both unique and both
 * written by Launch before the container starts; the sandbox never names itself, and the tenant is
 * taken from the row that comes back. Both functions are entries in
 * `tests/config/unscoped-allowlist.test.ts`.
 */
import { AGENT_LOGIN_ACTIVE_STATUSES } from '@launch/shared/launch-agents'
import { ACTIVE_SESSION_STATUSES } from '@launch/shared/launch-sessions'
import { and, eq, inArray } from 'drizzle-orm'
import type { Database } from '../../../../db/client'
import { type AgentLoginRow, agentLogins, type SessionRow, sessions } from '../../../../db/schema'

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

/**
 * The login in flight a container belongs to, or null — what a login sandbox's egress (Stream A's
 * Claude sign-in hosts, Stream B's device flow) checks before passing a request through. Same
 * PRE-TENANT rule as {@link sessionForSandbox}.
 */
export async function loginForSandbox(
  db: Database,
  sandboxId: string
): Promise<AgentLoginRow | null> {
  const [row] = await db
    .select()
    .from(agentLogins)
    .where(
      and(
        eq(agentLogins.sandboxId, sandboxId),
        inArray(agentLogins.status, [...AGENT_LOGIN_ACTIVE_STATUSES])
      )
    )
    .limit(1)
  return row ?? null
}
