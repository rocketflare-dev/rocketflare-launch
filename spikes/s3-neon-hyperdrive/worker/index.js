import postgres from 'postgres'
import { neon, Pool } from '@neondatabase/serverless'

// Three ways a Rocketflare app could reach its Neon branch, timed side by side:
//   /hyperdrive  postgres.js over the HYPERDRIVE binding (what the kit does for /api/ready today)
//   /direct      postgres.js over TCP straight to Neon's pooler (no Hyperdrive config used)
//   /http        Neon's serverless driver over HTTPS (no Hyperdrive config used)
//   /ws          Neon's serverless driver over WebSockets (Pool): interactive transactions work
// Each path also runs the kit's tenant-scope pattern: a transaction with set_config(..., true).
async function timed(fn) {
  const t0 = performance.now()
  const rows = await fn()
  return { ms: Math.round(performance.now() - t0), rows }
}

export default {
  async fetch(req, env, ctx) {
    const path = new URL(req.url).pathname
    const q = 'select 1 as ok, current_user, current_database()'
    try {
      if (path === '/hyperdrive' || path === '/direct') {
        const url = path === '/hyperdrive' ? env.HYPERDRIVE.connectionString : env.DATABASE_URL_POOLED
        const sql = postgres(url, { max: 1, fetch_types: false, prepare: path === '/hyperdrive' })
        const first = await timed(() => sql.unsafe(q))
        const second = await timed(() => sql.unsafe(q))
        ctx.waitUntil(sql.end())
        return Response.json({ path, first: first.ms, second: second.ms, row: first.rows[0] })
      }
      if (path === '/http') {
        const sql = neon(env.DATABASE_URL_POOLED)
        const first = await timed(() => sql.query(q))
        const second = await timed(() => sql.query(q))
        return Response.json({ path, first: first.ms, second: second.ms, row: first.rows[0] })
      }
      if (path === '/ws') {
        const pool = new Pool({ connectionString: env.DATABASE_URL_POOLED })
        // "first" includes the WebSocket handshake + auth, like the other paths' first query does.
        let client
        const first = await timed(async () => {
          client = await pool.connect()
          return (await client.query(q)).rows
        })
        const second = await timed(() => client.query(q).then((r) => r.rows))
        const tx = await timed(async () => {
          await client.query('begin')
          await client.query("select set_config('app.tenant_id', 't1', true)")
          const r = await client.query("select current_setting('app.tenant_id', true) as tenant")
          await client.query('commit')
          return r.rows
        })
        client.release()
        ctx.waitUntil(pool.end())
        return Response.json({ path, first: first.ms, second: second.ms, tx: tx.ms, tenant: tx.rows[0].tenant, row: first.rows[0] })
      }
      if (path === '/http-tx') {
        // The HTTP driver's only transaction form: a non-interactive batch.
        const sql = neon(env.DATABASE_URL_POOLED)
        const tx = await timed(() =>
          sql.transaction([sql`select set_config('app.tenant_id', 't1', true)`, sql`select current_setting('app.tenant_id', true) as tenant`]),
        )
        return Response.json({ path, tx: tx.ms, tenant: tx.rows[1][0].tenant })
      }
      return new Response('try /hyperdrive, /direct, /http, /ws or /http-tx', { status: 404 })
    } catch (e) {
      return Response.json({ path, error: String(e?.message ?? e) }, { status: 500 })
    }
  },
}
