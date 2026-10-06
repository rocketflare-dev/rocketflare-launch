// @vitest-isolate
// Points the neon driver's GLOBAL `neonConfig` at a local relay, so it needs its own module registry.
/**
 * `createNeonPool` (`src/db/client.ts`, rocketflare-launch#7): a Neon WebSocket pool whose dropped
 * connections REJECT the query in flight and never surface as an uncaught exception. Without its
 * listeners, pg-pool's `error` on the pool (an idle client dropped) and a checked-out client's own
 * `error` (a transaction's connection dropped) are unhandled — the process dies under Node, which
 * vitest reports as an "Unhandled Error" failing this file. Run on the REAL driver against the test
 * Postgres through a WebSocket relay (`helpers/ws-pg-relay.ts`) that drops its connections on cue.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { createNeonPool, routeNeonThroughProxy } from '@/db/client'
import { type PgRelay, relay } from '../helpers/ws-pg-relay'

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
let r: PgRelay | undefined

afterAll(() => r?.close())

describe('createNeonPool', () => {
  it('a transaction whose connection drops rejects; an idle one that drops is replaced — nothing uncaught', async () => {
    r = await relay()
    routeNeonThroughProxy(r.url)
    const pool = createNeonPool(process.env.DATABASE_URL ?? '', 1)
    try {
      // Checked out (an interactive transaction): the drop rejects the next query.
      const client = await pool.connect()
      await client.query('BEGIN')
      r.dropAll()
      await pause(200)
      await expect(client.query('select 1')).rejects.toThrow()
      client.release(true)

      // Idle in the pool: the drop is absorbed, and the next query opens a new connection.
      expect((await pool.query('select 2 as two')).rows).toEqual([{ two: 2 }])
      r.dropAll()
      await pause(200)
      expect((await pool.query('select 3 as three')).rows).toEqual([{ three: 3 }])
    } finally {
      await pool.end().catch(() => {})
    }
  }, 30_000)
})
