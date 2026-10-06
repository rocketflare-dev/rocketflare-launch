/**
 * How many session containers are live on a sandbox host, against the host's cap — the
 * `[[containers]] max_instances` of its toml, which the platform enforces and Launch cannot read
 * at run time. Issue #16's `prebuild` runs use the same class (`SessionSandbox`) as a person's
 * session and a sign-in, so a prebuild must never take the slot a person is about to need:
 * `requestPrebuild` asks only while at least {@link PREBUILD_CONTAINER_HEADROOM} slots are free.
 *
 * - **The cap**: `SESSION_MAX_CONTAINERS` for this Worker's own containers (default 10, the two
 *   deployed tomls' `max_instances` — `tests/config` pins the default to them; an instance that
 *   raises its toml's value sets the var with it) and {@link SANDBOX_HOST_MAX_CONTAINERS} for the
 *   remote sandbox host (its own toml, pinned the same way).
 * - **Live** is every row that holds (or is about to hold) a container on that host, of EVERY kind
 *   and tenant — a session `requested` → `ending`, a `suspended` one whose container an idle
 *   suspend kept — plus every sign-in in flight (`agent_logins` carries no host: counted against
 *   both, the cautious side). A count, never a reservation: two requests at the same moment may
 *   both pass; the headroom absorbs one.
 *
 * Cross-tenant by design (the cap is the platform's): allow-listed in `unscoped-allowlist.test.ts`.
 */
import { AGENT_LOGIN_ACTIVE_STATUSES } from '@launch/shared/launch-agents'
import type { SessionSandboxHost } from '@launch/shared/launch-setup'
import { and, eq, inArray, isNotNull, or, sql } from 'drizzle-orm'
import type { AppConfig } from '../../../config'
import type { Database } from '../../../db/client'
import { agentLogins, sessions } from '../../../db/schema'

/** `wrangler.sandbox-host.toml`'s `max_instances` (a config test pins it). */
export const SANDBOX_HOST_MAX_CONTAINERS = 3

/** Free slots a prebuild leaves: its own, and one for the next person. */
export const PREBUILD_CONTAINER_HEADROOM = 2

/** Statuses whose session holds a container (a `suspended` one only when it was kept). */
const CONTAINER_STATUSES = [
  'requested',
  'booting',
  'ready',
  'working',
  'blocked',
  'shipping',
  'ending',
] as const

/** The container cap of `host`. */
export function containerCapFor(
  cfg: Pick<AppConfig, 'SESSION_MAX_CONTAINERS'>,
  host: SessionSandboxHost
): number {
  return host === 'remote' ? SANDBOX_HOST_MAX_CONTAINERS : cfg.SESSION_MAX_CONTAINERS
}

/** Containers live (or starting) on `host` now, across every kind and tenant — see the header. */
export async function liveContainerCount(db: Database, host: SessionSandboxHost): Promise<number> {
  const [held] = await db
    .select({ n: sql<number>`count(*)` })
    .from(sessions)
    .where(
      and(
        eq(sessions.sandboxHost, host),
        or(
          inArray(sessions.status, [...CONTAINER_STATUSES]),
          and(eq(sessions.status, 'suspended'), isNotNull(sessions.containerKeptAt))
        )
      )
    )
  const [logins] = await db
    .select({ n: sql<number>`count(*)` })
    .from(agentLogins)
    .where(inArray(agentLogins.status, [...AGENT_LOGIN_ACTIVE_STATUSES]))
  return Number(held?.n ?? 0) + Number(logins?.n ?? 0)
}
