/**
 * `NeonClient.waitForOperations` (slice 2a of rocketflare-launch#1): polls on a capped exponential
 * backoff (200, 300, 450, 675, 1000, 1000… ms), reads every pending operation each round, waits
 * only for the `actions` asked for (`waitForBranch` = `create_branch` alone — not the compute's
 * `start_compute`), throws on a failed one, and gives up after `NEON_OPERATION_TIMEOUT_MS` slept.
 * No database: a scripted `fetch` answers the operation reads.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BRANCH_READY_ACTIONS,
  NEON_OPERATION_TIMEOUT_MS,
  NeonApiError,
  NeonClient,
  neonBackoffDelay,
} from '@/api/services/launch/neon'

/**
 * A Neon that answers `GET …/operations/{id}` from a script: each op id reads its statuses in
 * turn (the last one repeats). Every read is recorded.
 */
function scriptedNeon(script: Record<string, string[]>, errors: Record<string, string> = {}) {
  const reads: string[] = []
  const fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    const id = decodeURIComponent(url.pathname.split('/operations/')[1] ?? '')
    reads.push(id)
    const statuses = script[id]
    if (!statuses) return new Response(JSON.stringify({ message: 'not found' }), { status: 404 })
    const status = statuses.length > 1 ? (statuses.shift() as string) : statuses[0]
    return Response.json({
      operation: { id, status, ...(errors[id] ? { error: errors[id] } : {}) },
    })
  }) as typeof globalThis.fetch
  return { fetch, reads }
}

function client(fetch: typeof globalThis.fetch, sleeps: number[]) {
  return new NeonClient('neon-key-xxxxxxxxxxxxxxxxxx', {
    fetch,
    sleep: async ms => {
      sleeps.push(ms)
    },
  })
}

afterEach(() => {
  vi.useRealTimers()
})

describe('neonBackoffDelay', () => {
  it('starts at 200 ms, grows ×1.5 and caps at 1 s', () => {
    expect(Array.from({ length: 8 }, (_, i) => neonBackoffDelay(i))).toEqual([
      200, 300, 450, 675, 1000, 1000, 1000, 1000,
    ])
    expect(neonBackoffDelay(3, 2000)).toBe(675)
    expect(neonBackoffDelay(10, 2000)).toBe(2000)
  })
})

describe('NeonClient.waitForOperations', () => {
  it('polls on the backoff schedule until the operation finishes', async () => {
    const neon = scriptedNeon({
      'op-1': ['running', 'running', 'running', 'running', 'running', 'running', 'finished'],
    })
    const sleeps: number[] = []
    await client(neon.fetch, sleeps).waitForOperations('proj-1', [
      { id: 'op-1', action: 'create_branch', status: 'running' },
    ])
    expect(sleeps).toEqual([200, 300, 450, 675, 1000, 1000, 1000])
    expect(neon.reads).toHaveLength(7)
  })

  it('does not poll an operation that is already done, and reads pending ones together', async () => {
    const neon = scriptedNeon({ a: ['running', 'finished'], b: ['finished'] })
    const sleeps: number[] = []
    await client(neon.fetch, sleeps).waitForOperations('proj-1', [
      { id: 'a', status: 'running' },
      { id: 'b', status: 'scheduling' },
      { id: 'c', status: 'finished' },
      { id: 'd', status: 'skipped' },
    ])
    // Round 1 reads a and b; round 2 only a.
    expect(neon.reads).toEqual(['a', 'b', 'a'])
    expect(sleeps).toEqual([200, 300])
  })

  it('waitForBranch waits for create_branch only — never the compute start', async () => {
    const neon = scriptedNeon({
      'op-branch': ['running', 'finished'],
      'op-compute': ['running'],
    })
    const sleeps: number[] = []
    await client(neon.fetch, sleeps).waitForBranch('proj-1', [
      { id: 'op-branch', action: 'create_branch', status: 'running' },
      { id: 'op-compute', action: 'start_compute', status: 'scheduling' },
    ])
    expect(BRANCH_READY_ACTIONS).toEqual(['create_branch'])
    expect(neon.reads).toEqual(['op-branch', 'op-branch'])
    expect(sleeps).toEqual([200, 300])
  })

  it('an operation without an action is waited for even when actions narrow the wait', async () => {
    const neon = scriptedNeon({ x: ['running', 'finished'] })
    await client(neon.fetch, []).waitForOperations('proj-1', [{ id: 'x', status: 'running' }], {
      actions: ['create_branch'],
    })
    expect(neon.reads).toEqual(['x', 'x'])
  })

  it('with no actions it waits for every operation, start_compute included', async () => {
    const neon = scriptedNeon({ b: ['finished'], c: ['running', 'running', 'finished'] })
    await client(neon.fetch, []).waitForOperations('proj-1', [
      { id: 'b', action: 'create_branch', status: 'running' },
      { id: 'c', action: 'start_compute', status: 'scheduling' },
    ])
    expect(neon.reads).toEqual(['b', 'c', 'c', 'c'])
  })

  it('throws on an operation that fails — with Neon’s error — and on one handed in failed', async () => {
    const neon = scriptedNeon({ f: ['running', 'failed'] }, { f: 'out of quota' })
    const err = await client(neon.fetch, [])
      .waitForOperations('proj-1', [{ id: 'f', action: 'create_branch', status: 'running' }])
      .catch(e => e)
    expect(err).toBeInstanceOf(NeonApiError)
    expect(err.status).toBe(500)
    expect(err.message).toBe('Neon operation f failed: out of quota')

    const reads = scriptedNeon({})
    await expect(
      client(reads.fetch, []).waitForOperations('proj-1', [{ id: 'g', status: 'error' }])
    ).rejects.toThrow('Neon operation g error')
    expect(reads.reads).toEqual([])
  })

  it('a failure of an operation the caller did not ask for is not its concern', async () => {
    const neon = scriptedNeon({ b: ['finished'], c: ['failed'] })
    await client(neon.fetch, []).waitForBranch('proj-1', [
      { id: 'b', action: 'create_branch', status: 'running' },
      { id: 'c', action: 'start_compute', status: 'running' },
    ])
    expect(neon.reads).toEqual(['b'])
  })

  it('gives up (504) once it has slept the deadline — 120 s by default', async () => {
    const neon = scriptedNeon({ s: ['running'] })
    const sleeps: number[] = []
    const err = await client(neon.fetch, sleeps)
      .waitForOperations('proj-1', [{ id: 's', action: 'create_branch', status: 'running' }])
      .catch(e => e)
    expect(err).toBeInstanceOf(NeonApiError)
    expect(err.status).toBe(504)
    expect(err.message).toBe('Neon operation s still running')
    const slept = sleeps.reduce((a, b) => a + b, 0)
    expect(slept).toBe(NEON_OPERATION_TIMEOUT_MS)
    expect(NEON_OPERATION_TIMEOUT_MS).toBe(120_000)
    // 200 + 300 + 450 + 675 = 1625, then 1 s polls: ~120 reads, as the old 120 × 1 s.
    expect(sleeps.length).toBe(123)
    expect(neon.reads).toHaveLength(sleeps.length)
  })

  it('honours a shorter timeoutMs, clipping the last sleep to it', async () => {
    const neon = scriptedNeon({ s: ['running'] })
    const sleeps: number[] = []
    await expect(
      client(neon.fetch, sleeps).waitForOperations('proj-1', [{ id: 's', status: 'running' }], {
        timeoutMs: 1000,
      })
    ).rejects.toThrow(/still running/)
    expect(sleeps).toEqual([200, 300, 450, 50])
  })

  it('runs on real timers: nothing is read before 200 ms, then 300 ms later', async () => {
    vi.useFakeTimers()
    const neon = scriptedNeon({ t: ['running', 'finished'] })
    const done = new NeonClient('neon-key-xxxxxxxxxxxxxxxxxx', { fetch: neon.fetch })
      .waitForOperations('proj-1', [{ id: 't', status: 'running' }])
      .then(() => 'done')
    await vi.advanceTimersByTimeAsync(199)
    expect(neon.reads).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(neon.reads).toEqual(['t'])
    await vi.advanceTimersByTimeAsync(299)
    expect(neon.reads).toEqual(['t'])
    await vi.advanceTimersByTimeAsync(1)
    await expect(done).resolves.toBe('done')
    expect(neon.reads).toEqual(['t', 't'])
  })
})
