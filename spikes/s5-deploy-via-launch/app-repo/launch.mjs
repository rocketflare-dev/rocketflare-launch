// Everything the deploy job does with Launch. The job has no Cloudflare token and no stored database
// credential: it proves who it is with a GitHub Actions OIDC token, minted fresh for each call.
import { appendFileSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import postgres from 'postgres'

const { LAUNCH_URL, TOML, GITHUB_ENV } = process.env
const AUDIENCE = 'rfspike-launch'

async function oidc(audience = AUDIENCE) {
  const r = await fetch(`${process.env.ACTIONS_ID_TOKEN_REQUEST_URL}&audience=${audience}`, {
    headers: { authorization: `bearer ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
  })
  return (await r.json()).value
}
async function launch(method, path, body, audience) {
  const r = await fetch(`${LAUNCH_URL}${path}`, {
    method,
    headers: { authorization: `Bearer ${await oidc(audience)}`, 'content-type': 'application/json' },
    body: body && JSON.stringify(body),
  })
  return { status: r.status, body: await r.json().catch(() => ({})) }
}
const exportEnv = (k, v) => appendFileSync(GITHUB_ENV, `${k}=${v}\n`)

const cmd = process.argv[2]
if (cmd === 'start') {
  const start = await launch('POST', '/deploy/start')
  if (start.status !== 200) throw new Error(`start refused: ${start.status} ${JSON.stringify(start.body)}`)
  const id = start.body.id
  exportEnv('LAUNCH_TICKET', id)
  console.log(`ticket ${id}: ${start.body.status}`)
  const deadline = Date.now() + Number(process.env.WAIT_SECONDS ?? 300) * 1000
  for (;;) {
    const t = await launch('GET', `/deploy/${id}`)
    if (t.body.status === 'approved') break
    if (t.body.status === 'rejected') throw new Error('rejected in Launch')
    if (Date.now() > deadline) throw new Error(`no approval within ${process.env.WAIT_SECONDS}s (status ${t.body.status})`)
    console.log(`waiting for approval in Launch (status ${t.body.status})`)
    await new Promise((r) => setTimeout(r, 10000))
  }
  console.log('approved')
} else if (cmd === 'upload') {
  const toml = readFileSync(TOML, 'utf8')
  const modules = {}
  for (const f of readdirSync('dist')) if (f.endsWith('.js')) modules[f] = readFileSync(join('dist', f)).toString('base64')
  const assets = {}
  const walk = (d) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f)
      if (statSync(p).isDirectory()) walk(p)
      else assets[`/${relative('public', p)}`] = readFileSync(p).toString('base64')
    }
  }
  walk('public')
  const main = basename(toml.match(/^main\s*=\s*"(.+)"/m)[1])
  const r = await launch('POST', `/deploy/${process.env.LAUNCH_TICKET}/upload`, { toml, main, modules, assets })
  const { migratorUrl, ...rest } = r.body
  console.log(`upload: ${r.status} ${JSON.stringify(rest)}`)
  if (r.status !== 200) process.exit(1)
  console.log(`::add-mask::${migratorUrl}`)
  console.log(`::add-mask::${new URL(migratorUrl).password}`)
  exportEnv('MIGRATOR_URL', migratorUrl)
  console.log('build accepted as an undeployed version; received short-lived migrator credentials')
} else if (cmd === 'activate') {
  const r = await launch('POST', `/deploy/${process.env.LAUNCH_TICKET}/activate`)
  console.log(`activate: ${r.status} ${r.body.status ?? JSON.stringify(r.body)}`)
  if (r.status !== 200) process.exit(1)
} else if (cmd === 'finish') {
  if (!process.env.LAUNCH_TICKET) process.exit(0)
  const r = await launch('POST', `/deploy/${process.env.LAUNCH_TICKET}/finish`)
  console.log(`finish: ${r.status} ${r.body.status}`)
} else if (cmd === 'check-dead') {
  // The credentials this run was given must be dead once the deploy has finished.
  if (!process.env.MIGRATOR_URL) process.exit(0)
  const sql = postgres(process.env.MIGRATOR_URL, { max: 1, connect_timeout: 10 })
  try {
    await sql`select 1`
    console.log('FAIL: the migrator password still works after finish')
    process.exit(1)
  } catch (e) {
    console.log(`ok: the migrator password is dead after finish (${String(e.message).slice(0, 60)})`)
  } finally {
    await sql.end().catch(() => {})
  }
} else if (cmd === 'wrong-audience') {
  const r = await launch('POST', '/deploy/start', undefined, 'someone-else')
  console.log(`a token for another audience: ${r.status} ${JSON.stringify(r.body)}`)
  if (r.status !== 401) process.exit(1)
}
