/**
 * `runStep` (Launch P2, `services/launch/pipeline/operations.ts`) — the `app_operations` row that
 * makes a retried pipeline resume instead of repeat: a succeeded step is skipped and hands back
 * its ids, an id recorded before a throw survives into the next attempt's `ctx.prior`, a failure
 * is stored scrubbed and rethrown, and `skipStep` records a deliberate skip.
 */
import { and, eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { runStep, type StepKey, skipStep } from '@/api/services/launch/pipeline/operations'
import { appOperations } from '@/db/schema'
import { createTestTenant } from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { seedApp } from '../helpers/launch-apps'

const db = setupTestDatabase()

async function stepKey(step = 'cloudflare'): Promise<StepKey> {
  const tenant = await createTestTenant(db)
  const { app } = await seedApp(db, tenant.id)
  return { tenantId: tenant.id, appId: app.id, runId: crypto.randomUUID(), kind: 'create', step }
}

async function row(key: StepKey) {
  const [found] = await db
    .select()
    .from(appOperations)
    .where(and(eq(appOperations.runId, key.runId), eq(appOperations.step, key.step)))
  return found
}

describe('runStep', () => {
  it('runs a new step once, records running → succeeded, and merges the returned ids', async () => {
    const key = await stepKey()
    const fn = vi.fn(async ctx => {
      expect(ctx.prior).toEqual({})
      expect(ctx.attempt).toBe(1)
      const running = await row(key)
      expect(running?.status).toBe('running')
      await ctx.record({ kvStaging: 'kv1' })
      return { queueStaging: 'q1' }
    })
    const result = await runStep(db, key, fn)
    expect(result).toEqual({
      externalIds: { kvStaging: 'kv1', queueStaging: 'q1' },
      skipped: false,
      attempt: 1,
    })
    expect(await row(key)).toMatchObject({
      status: 'succeeded',
      attempt: 1,
      kind: 'create',
      externalIds: { kvStaging: 'kv1', queueStaging: 'q1' },
      error: null,
    })
    expect((await row(key))?.finishedAt).toBeInstanceOf(Date)
  })

  it('skips a step that already succeeded: fn is not called and its stored ids come back', async () => {
    const key = await stepKey()
    await runStep(db, key, async () => ({ projectId: 'proj-1' }))
    const again = vi.fn(async () => ({ projectId: 'proj-2' }))
    const result = await runStep(db, key, again)
    expect(again).not.toHaveBeenCalled()
    expect(result).toEqual({ externalIds: { projectId: 'proj-1' }, skipped: true, attempt: 1 })
    expect((await row(key))?.attempt).toBe(1)
  })

  it('a recorded id survives a throw, and the retry sees it as ctx.prior with attempt + 1', async () => {
    const key = await stepKey()
    const boom = new Error('R2 said no to api-token-abcdefgh1234')
    await expect(
      runStep(db, key, async ctx => {
        ctx.redact('api-token-abcdefgh1234')
        await ctx.record({ kvStaging: 'kv-made-before-the-throw' })
        throw boom
      })
    ).rejects.toBe(boom)
    const failed = await row(key)
    expect(failed).toMatchObject({
      status: 'failed',
      attempt: 1,
      externalIds: { kvStaging: 'kv-made-before-the-throw' },
    })
    // The error is stored, scrubbed of what the step marked secret.
    expect(failed?.error).toBe('R2 said no to [redacted]')

    const retried = await runStep(db, key, async ctx => {
      expect(ctx.prior).toEqual({ kvStaging: 'kv-made-before-the-throw' })
      expect(ctx.attempt).toBe(2)
      return { r2Staging: 'bucket' }
    })
    expect(retried).toEqual({
      externalIds: { kvStaging: 'kv-made-before-the-throw', r2Staging: 'bucket' },
      skipped: false,
      attempt: 2,
    })
    expect(await row(key)).toMatchObject({ status: 'succeeded', attempt: 2, error: null })
  })

  it('keys by (run, step): the same step in another run is a new row', async () => {
    const key = await stepKey()
    await runStep(db, key, async () => ({ a: '1' }))
    const other = { ...key, runId: crypto.randomUUID() }
    const fn = vi.fn(async () => ({ a: '2' }))
    await runStep(db, other, fn)
    expect(fn).toHaveBeenCalledOnce()
  })

  it('skipStep records a deliberate skip that runStep then never runs', async () => {
    const key = await stepKey('production')
    await skipStep(db, key, 'waits for the first release and an owner’s approval')
    expect(await row(key)).toMatchObject({
      status: 'skipped',
      error: expect.stringContaining('first release'),
    })
    const fn = vi.fn(async () => undefined)
    expect((await runStep(db, key, fn)).skipped).toBe(true)
    expect(fn).not.toHaveBeenCalled()
  })

  it('never touches another tenant’s row for the same run and step', async () => {
    const key = await stepKey()
    await runStep(db, key, async () => {
      throw new Error('first')
    }).catch(() => {})
    const foreign = await stepKey()
    // Same run id and step, another tenant: the conflict target matches, the tenant guard does not.
    const result = await runStep(db, { ...foreign, runId: key.runId }, async () => ({
      x: '1',
    })).catch(e => e)
    expect(result).toBeInstanceOf(Error)
    expect(await row(key)).toMatchObject({ tenantId: key.tenantId, status: 'failed' })
  })
})
