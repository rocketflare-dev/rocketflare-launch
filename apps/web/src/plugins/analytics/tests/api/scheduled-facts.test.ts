/**
 * The `"15 * * * *"` cron (D19, D31): this plugin's task, and the expression it is registered under.
 *
 * The cron EXPRESSION is the host's — it lives in `[triggers].crons` in both wrangler tomls, which
 * a plugin may not edit — and the TASK is this plugin's, contributed through
 * `ServerPlugin.scheduledTasks`. What has to be true is that the two met: a task registered under
 * an expression no toml declares never runs, and nothing else would notice.
 *
 * **Both halves are provable now.** `@testkit/integration` publishes the host's dispatcher (kit
 * 0.7.0), so this file asserts the whole handshake rather than the plugin's side of it:
 *
 *   1. the expression this plugin REGISTERS the task under is the one its `plugin.json` declares —
 *      which is the file `pnpm provision cloudflare <env>` copies into both tomls;
 *   2. dispatching THAT expression through the host runs this plugin's task, which is the half no
 *      amount of checking the plugin's own registry could ever see;
 *   3. the task itself rebuilds the fact table.
 *
 * Note that (2) asserts `status: 'ok'` rather than that nothing threw. The dispatcher try/catches
 * each task on its own — so one plugin's failure cannot stop the kit's nightly prune — and a task
 * that threw comes back as `'failed'` rather than as a rejected promise.
 */
import { readFileSync } from 'node:fs'
import {
  createExecutionContext,
  createTestEnv,
  createTestTenantWithUser,
  dispatchScheduled,
  setupTestDatabase,
  waitOnExecutionContext,
} from '@testkit/integration'
import { makeCronCtx } from '@testkit/unit'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { activityEvents } from '@/db/schema/kit'
import { analyticsServer } from '../..'
import { refreshFactTables } from '../../api/scheduled'
import { tenantActivityDailyFacts } from '../../db/schema/facts'

const db = setupTestDatabase()

const manifest = JSON.parse(
  readFileSync(new URL('../../plugin.json', import.meta.url), 'utf8')
) as { crons: string[] }

describe('scheduled: fact-table refresh', () => {
  it('registers its task under exactly the cron expressions its manifest declares', () => {
    // The manifest is what reaches `[triggers].crons` in both tomls; the registry is what the
    // host's dispatcher looks the task up in. A drift between them is a task nothing ever runs.
    expect(Object.keys(analyticsServer.scheduledTasks)).toEqual(manifest.crons)
    expect(analyticsServer.scheduledTasks['15 * * * *']?.map(t => t.name)).toEqual([
      'analytics.refreshFactTables',
    ])
  })

  it('is actually dispatched by the host when that expression fires', async () => {
    const ctx = createExecutionContext()
    const reports = await dispatchScheduled(manifest.crons[0] ?? '', createTestEnv(), ctx)
    await waitOnExecutionContext(ctx)
    expect(reports).toContainEqual(
      expect.objectContaining({ task: 'analytics.refreshFactTables', status: 'ok' })
    )
  })

  it('rebuilds the fact table for seeded activity when the task runs', async () => {
    const { user, tenant } = await createTestTenantWithUser(db, 'owner')
    await db.insert(activityEvents).values([
      { tenantId: tenant.id, userId: user.id, type: 'cron.a' },
      { tenantId: tenant.id, userId: user.id, type: 'cron.b' },
    ])

    await refreshFactTables(makeCronCtx({ db }))

    const rows = await db
      .select()
      .from(tenantActivityDailyFacts)
      .where(
        and(
          eq(tenantActivityDailyFacts.tenantId, tenant.id),
          eq(tenantActivityDailyFacts.userId, user.id)
        )
      )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.eventCount).toBe(2)
    expect(rows[0]?.distinctEventTypes).toBe(2)
  })
})
