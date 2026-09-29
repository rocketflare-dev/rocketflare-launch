// @vitest-isolate
// Runs the nightly prune, which deletes EVERY expired session, magic link and invitation in the
// shared test database — in the shared `api` run it raced files asserting on their own expired rows
// (auth-magic-link's `expired`). The isolated run starts after the shared one.
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { dispatchScheduled, SCHEDULED_TASKS, type ScheduledTask, scheduled } from '@/api/scheduled'
import { approvalsSweep } from '@/api/services/approvals/sweep'
import { grantsSweep } from '@/api/services/grants/sweep'
import { auditSeal } from '@/api/services/launch/audit-chain'
import { healthPoll, healthPollTask } from '@/api/services/launch/health'
import { sessionsChecks } from '@/api/services/sessions/checks-cron'
import { expireSessions } from '@/api/services/sessions/expire'
import { sessionsGateSweep } from '@/api/services/sessions/gate-sweep'
import { appEnvironments } from '@/db/schema'
import { createTestTenantWithUser } from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { forgetApps, seedApp } from '../helpers/launch-apps'
import { createExecutionContext, createTestEnv, waitOnExecutionContext } from '../mocks/bindings'

const db = setupTestDatabase()

describe('scheduled dispatcher', () => {
  it('registers pruneExpired and the trace-store retention on the nightly cron', () => {
    expect(SCHEDULED_TASKS['0 4 * * *']?.map(t => t.name)).toEqual(['pruneExpired', 'pruneAiSpans'])
  })

  it("registers Launch's health poll, the P3 session tasks (and issue #1's gate-branch sweep), the P4 approval and audit tasks and the P5 grants sweep on the five-minute cron", () => {
    // The grants sweep runs BEFORE the seal, so the audit rows it writes join the same run's chain.
    expect(SCHEDULED_TASKS['*/5 * * * *']).toEqual([
      healthPoll,
      expireSessions,
      sessionsChecks,
      sessionsGateSweep,
      approvalsSweep,
      grantsSweep,
      auditSeal,
    ])
    expect(SCHEDULED_TASKS['*/5 * * * *']?.map(t => t.name)).toEqual([
      'healthPoll',
      'sessions.expire',
      'sessions.checks',
      'sessions.gate-sweep',
      'approvals.sweep',
      'grants.sweep',
      'audit.seal',
    ])
  })

  it('dispatches the health poll: an injected fetch, one tenant — no network, no other suite', async () => {
    // The poll walks every tenant in the shared test database, so the registered task (global
    // fetch, every tenant) would probe other suites' environments over the real network. The
    // same task over injected options is the deterministic version of that run.
    const { tenant } = await createTestTenantWithUser(db, 'owner')
    const { environments } = await seedApp(db, tenant.id, {
      environments: { production: 'https://sched.apps.test' },
    })
    const seen: string[] = []
    const fakeFetch = (async (input: RequestInfo | URL) => {
      seen.push(String(input))
      return new Response(JSON.stringify({ status: 'ok', version: '9.9.9' }), { status: 200 })
    }) as typeof fetch
    const ctx = createExecutionContext()
    const reports = await dispatchScheduled('*/5 * * * *', createTestEnv(), ctx, {
      '*/5 * * * *': [healthPollTask({ fetch: fakeFetch, tenantIds: [tenant.id] })],
    })
    await waitOnExecutionContext(ctx)
    expect(reports).toEqual([
      expect.objectContaining({ cron: '*/5 * * * *', task: 'healthPoll', status: 'ok' }),
    ])
    expect(seen.sort()).toEqual([
      'https://sched.apps.test/api/health',
      'https://sched.apps.test/api/ready',
    ])
    const [row] = await db
      .select()
      .from(appEnvironments)
      .where(eq(appEnvironments.id, environments[0]?.id ?? ''))
    expect(row?.healthStatus).toBe('up')
    await forgetApps(db, [tenant.id])
  })

  it('runs the tasks registered for event.cron and reports each', async () => {
    const env = createTestEnv()
    const ctx = createExecutionContext()
    const reports = await dispatchScheduled('0 4 * * *', env, ctx)
    await waitOnExecutionContext(ctx)
    expect(reports).toEqual([
      expect.objectContaining({ cron: '0 4 * * *', task: 'pruneExpired', status: 'ok' }),
      expect.objectContaining({ cron: '0 4 * * *', task: 'pruneAiSpans', status: 'ok' }),
    ])
  })

  it('isolates a failing task from the others', async () => {
    const boom: ScheduledTask = {
      name: 'boom',
      run: async () => {
        throw new Error('nope')
      },
    }
    const ran: string[] = []
    const after: ScheduledTask = {
      name: 'after',
      run: async ({ db, logger }) => {
        expect(db).toBeDefined()
        expect(logger).toBeDefined()
        ran.push('after')
      },
    }
    const ctx = createExecutionContext()
    const reports = await dispatchScheduled('* * * * *', createTestEnv(), ctx, {
      '* * * * *': [boom, after],
    })
    await waitOnExecutionContext(ctx)
    expect(reports.map(r => `${r.task}:${r.status}`)).toEqual(['boom:failed', 'after:ok'])
    expect(ran).toEqual(['after'])
  })

  it('an unknown cron runs nothing', async () => {
    const ctx = createExecutionContext()
    expect(await dispatchScheduled('59 23 31 12 *', createTestEnv(), ctx)).toEqual([])
  })

  it('the Worker handler accepts a ScheduledController', async () => {
    const ctx = createExecutionContext()
    await scheduled(
      { cron: '0 4 * * *', scheduledTime: Date.now(), noRetry() {} },
      createTestEnv(),
      ctx
    )
    await waitOnExecutionContext(ctx)
  })
})
