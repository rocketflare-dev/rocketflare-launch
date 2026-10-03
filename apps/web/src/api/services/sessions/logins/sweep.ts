/**
 * `agentLoginsSweep` — the `*\/5` cron's backstop for personal AI accounts (§18.22):
 *
 * - **Logins past their TTL** (`expires_at`) still marked active — a Workflow that died, or never
 *   ran — are settled `expired` with the URL, the device code and any sealed code nulled, and their
 *   sandbox destroyed (best effort: the platform reclaims an idle one anyway). A live Workflow
 *   notices the same expiry on its next step; this is only for the ones that will not.
 * - **Stale credential claims** (`claim_expires_at` passed — a turn whose Workflow died holding a
 *   ChatGPT `auth.json`) are released (`sweepStaleClaims`).
 *
 * CROSS-TENANT by design, like every cron (the `unscoped-allowlist` entries); each row is written
 * inside its own tenant. `tenantIds` scopes it for the tests.
 */
import { AGENT_LOGIN_ACTIVE_STATUSES } from '@launch/shared/launch-agents'
import type { SessionSandboxHost } from '@launch/shared/launch-setup'
import { and, eq, inArray, lt } from 'drizzle-orm'
import type { Database } from '../../../../db/client'
import { agentLogins } from '../../../../db/schema'
import type { ScheduledTask } from '../../../scheduled'
import type { Logger } from '../../../utils/core/logger'
import { sweepStaleClaims } from '../credentials/store'
import { defaultSessionPorts, type SandboxPort } from '../ports'
import { isRemoteSandboxId } from '../sandbox-host/protocol'
import { loginSandboxName } from './steps'

export interface AgentLoginsSweepResult {
  expired: number
  claimsReleased: number
}

export async function runAgentLoginsSweep(
  db: Database,
  opts: {
    now?: Date
    tenantIds?: readonly string[]
    /** The login sandbox by name and host, to destroy it; absent = leave it to the platform. */
    sandbox?: (name: string, host: SessionSandboxHost) => SandboxPort
    logger?: Pick<Logger, 'warn'>
  } = {}
): Promise<AgentLoginsSweepResult> {
  const now = opts.now ?? new Date()
  const stale = await db
    .select({
      id: agentLogins.id,
      tenantId: agentLogins.tenantId,
      sandboxId: agentLogins.sandboxId,
    })
    .from(agentLogins)
    .where(
      and(
        inArray(agentLogins.status, [...AGENT_LOGIN_ACTIVE_STATUSES]),
        lt(agentLogins.expiresAt, now),
        opts.tenantIds ? inArray(agentLogins.tenantId, [...opts.tenantIds]) : undefined
      )
    )
  let expired = 0
  for (const login of stale) {
    const [settled] = await db
      .update(agentLogins)
      .set({
        status: 'expired',
        error: 'The sign-in took too long and was stopped. Start it again.',
        verificationUrl: null,
        userCode: null,
        codeSealed: null,
        finishedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(agentLogins.tenantId, login.tenantId),
          eq(agentLogins.id, login.id),
          inArray(agentLogins.status, [...AGENT_LOGIN_ACTIVE_STATUSES])
        )
      )
      .returning({ id: agentLogins.id })
    if (!settled) continue
    expired++
    if (opts.sandbox) {
      await opts
        .sandbox(
          loginSandboxName(login.id),
          isRemoteSandboxId(login.sandboxId) ? 'remote' : 'local'
        )
        .destroy()
        .catch(err =>
          opts.logger?.warn({ err, loginId: login.id }, 'agent login sweep: destroy failed')
        )
    }
  }
  const claimsReleased = await sweepStaleClaims(db, { now, tenantIds: opts.tenantIds })
  return { expired, claimsReleased }
}

export const agentLoginsSweep: ScheduledTask = {
  name: 'agent-logins.sweep',
  async run({ db, env, config, logger }) {
    const result = await runAgentLoginsSweep(db, {
      // The host a login ran on is in its recorded sandbox id (`remote:<name>` on the sandbox host).
      sandbox: (name, host) => defaultSessionPorts(env, config, host).sandbox(name),
      logger,
    })
    if (result.expired || result.claimsReleased) {
      logger.info(result, 'agentLoginsSweep: expired logins and released stale claims')
    }
  },
}
