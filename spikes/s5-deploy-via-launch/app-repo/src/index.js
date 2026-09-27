import { neon } from '@neondatabase/serverless'

// A stand-in app: static assets, a KV binding, and Neon over HTTP with the Worker secret DATABASE_URL.
export default {
  async fetch(req, env) {
    const url = new URL(req.url)
    if (url.pathname === '/api/state') {
      const sql = neon(env.DATABASE_URL)
      const [last] = await sql.query('select run_id, env, sha, at from deploys order by at desc limit 1')
      await env.RATE_LIMIT_KV.put('last-hit', new Date().toISOString())
      return Response.json({ release: env.RELEASE, lastMigration: last, kv: !!(await env.RATE_LIMIT_KV.get('last-hit')) })
    }
    return env.ASSETS.fetch(req)
  },
}
