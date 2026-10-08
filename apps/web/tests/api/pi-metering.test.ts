/**
 * Pi records each response's usage as soon as it is drained (rocketflare-launch#14): a turn step
 * killed mid-turn (`WorkflowInternalError` on launch.rocketflare.dev, after 8 minutes) never
 * reached the end-of-turn write and lost the whole turn's spend. Recording as it goes means a
 * retried step drains the turn again — the claim on `runtime_state.piMetered` keeps it from
 * charging the same responses twice.
 */
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { recordSessionUsage } from '@/api/services/sessions/egress/anthropic'
import { claimPiMetered } from '@/api/services/sessions/runtimes/pi'
import { aiUsage, sessions } from '@/db/schema'
import { setupTestDatabase } from '../helpers/db'
import { createFakeCloud } from '../helpers/fake-cloud'
import { insertSession, seedSessionApp } from '../helpers/sessions'

const db = setupTestDatabase()
const usage = { inputTokens: 1_000, outputTokens: 100 }
const MODEL = '@cf/moonshotai/kimi-k2.7-code'

describe('Pi metering claims', () => {
  it('records an entry once per turn, however often a step drains it; a new turn starts over', async () => {
    const f = await seedSessionApp(db, createFakeCloud())
    const row = await insertSession(db, f, { runtime: 'pi' })
    const write = (operationId: string, seq: number) =>
      recordSessionUsage(db, row, MODEL, usage, {
        provider: 'workers_ai',
        claim: tx => claimPiMetered(tx, row, operationId, seq),
      })

    expect(await write(`${row.id}:1`, 3)).toBe(true)
    expect(await write(`${row.id}:1`, 7)).toBe(true)
    // A retried step drains turn 1 from the start: everything up to entry 7 is already paid.
    expect(await write(`${row.id}:1`, 3)).toBe(false)
    expect(await write(`${row.id}:1`, 7)).toBe(false)
    expect(await write(`${row.id}:1`, 9)).toBe(true)
    // Turn 2 is a new operation: its entries count from nothing.
    expect(await write(`${row.id}:2`, 4)).toBe(true)

    const rows = await db
      .select()
      .from(aiUsage)
      .where(and(eq(aiUsage.tenantId, row.tenantId), eq(aiUsage.sessionId, row.id)))
    expect(rows).toHaveLength(4)
    expect(rows.every(r => r.provider === 'workers_ai' && r.model === MODEL)).toBe(true)
    const [after] = await db
      .select()
      .from(sessions)
      .where(and(eq(sessions.tenantId, row.tenantId), eq(sessions.id, row.id)))
    expect(after?.tokensIn).toBe(4_000)
    expect(after?.costMicrocents).toBeGreaterThan(0)
    expect(after?.runtimeState).toMatchObject({ piMetered: { op: `${row.id}:2`, seq: 4 } })
  })
})
