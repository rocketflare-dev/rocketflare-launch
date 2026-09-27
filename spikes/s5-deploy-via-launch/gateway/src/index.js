// Stand-in for Launch's deploy endpoint (spec/08, "Launch deploys, so Launch is the gate").
//
//   POST /deploy/start            GitHub OIDC → open a ticket (staging: approved; production: pending)
//   GET  /deploy/:id              GitHub OIDC → status
//   POST /deploy/:id/upload       GitHub OIDC, approved only → check bindings against the registry,
//                                 upload assets + an UNDEPLOYED Worker version, then hand out
//                                 short-lived migrator credentials (so nothing migrates before the
//                                 build has passed the check)
//   POST /deploy/:id/activate     GitHub OIDC → deploy that version at 100%, reset the migrator password
//   POST /deploy/:id/finish       GitHub OIDC → reset the migrator password if still live (always runs)
//   GET  /admin/tickets           x-admin-key → list tickets
//   POST /admin/:id/(approve|reject)
//
// The CI job holds no Cloudflare token and no database credential. Everything it can do is here.
import { DurableObject } from 'cloudflare:workers'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { parse as parseToml } from 'smol-toml'

const ISSUER = 'https://token.actions.githubusercontent.com'
const JWKS = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks`))

export class Tickets extends DurableObject {
  async get(id) {
    return this.ctx.storage.get(id)
  }
  async put(t) {
    await this.ctx.storage.put(t.id, t)
    return t
  }
  async list() {
    return [...(await this.ctx.storage.list()).values()]
  }
}

const json = (body, status = 200) => Response.json(body, { status })

/** Verify a GitHub Actions OIDC token and map it to one app environment in the registry. */
async function caller(req, env) {
  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer /i, '')
  if (!token) throw json({ error: 'no token' }, 401)
  let claims
  try {
    ;({ payload: claims } = await jwtVerify(token, JWKS, { issuer: ISSUER, audience: env.AUDIENCE }))
  } catch (e) {
    throw json({ error: `token rejected: ${e.code ?? e.message}` }, 401)
  }
  const registry = JSON.parse(env.REGISTRY)
  if (claims.repository !== registry.repo) throw json({ error: `unknown repository ${claims.repository}` }, 403)
  if (!claims.job_workflow_ref?.startsWith(`${registry.repo}/.github/workflows/deploy.yml@`))
    throw json({ error: `not the deploy workflow: ${claims.job_workflow_ref}` }, 403)
  if (!(claims.ref === 'refs/heads/main' || claims.ref?.startsWith('refs/tags/')))
    throw json({ error: `ref not deployable: ${claims.ref}` }, 403)
  const app = registry.environments[claims.environment]
  if (!app) throw json({ error: `no such environment: ${claims.environment}` }, 403)
  return { claims, app, registry }
}

async function neon(env, method, path, body) {
  for (let i = 0; ; i++) {
    const r = await fetch(`https://console.neon.tech/api/v2${path}`, {
      method,
      headers: { authorization: `Bearer ${env.NEON_API_KEY}`, 'content-type': 'application/json', accept: 'application/json' },
      body: body && JSON.stringify(body),
    })
    if (r.status === 423 && i < 30) {
      await new Promise((res) => setTimeout(res, 1000))
      continue
    }
    if (!r.ok) throw new Error(`neon ${path}: ${r.status} ${await r.text()}`)
    return r.json()
  }
}

/** Reset the migrator role and return its fresh direct URI. Launch never stores it. */
async function rotateMigrator(env, app) {
  const { project, branch } = app.neon
  await neon(env, 'POST', `/projects/${project}/branches/${branch}/roles/migrator/reset_password`)
  const { uri } = await neon(env, 'GET', `/projects/${project}/connection_uri?branch_id=${branch}&database_name=app&role_name=migrator&pooled=false`)
  return uri
}

const cf = (env, method, path, init = {}) =>
  fetch(`https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}${path}`, {
    method,
    ...init,
    headers: { authorization: `Bearer ${init.bearer ?? env.CF_TOKEN}`, ...init.headers },
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }))

/**
 * The binding check. Every binding the build declares must be one the registry recorded for this
 * app and environment. Anything else, including a real resource of another app, is refused.
 */
function checkBindings(config, app) {
  const refused = []
  const bindings = []
  for (const kv of config.kv_namespaces ?? []) {
    if (app.kv[kv.binding] === kv.id) bindings.push({ type: 'kv_namespace', name: kv.binding, namespace_id: kv.id })
    else refused.push(`kv_namespaces ${kv.binding}=${kv.id}`)
  }
  const other = ['r2_buckets', 'queues', 'services', 'hyperdrive', 'd1_databases', 'durable_objects', 'workflows', 'analytics_engine_datasets', 'secrets_store_secrets', 'send_email', 'vectorize', 'dispatch_namespaces', 'mtls_certificates']
  for (const key of other) {
    const v = config[key]
    const list = Array.isArray(v) ? v : v?.bindings ?? v?.producers ?? (v ? [v] : [])
    for (const b of list) refused.push(`${key} ${b.binding ?? b.name ?? JSON.stringify(b)}`)
  }
  if (config.assets?.binding) bindings.push({ type: 'assets', name: config.assets.binding })
  for (const [name, text] of Object.entries(config.vars ?? {})) bindings.push({ type: 'plain_text', name, text: String(text) })
  return { bindings, refused }
}

async function sha256Hex(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
const mime = (p) =>
  ({ html: 'text/html', js: 'application/javascript', css: 'text/css', json: 'application/json', svg: 'image/svg+xml', txt: 'text/plain' })[p.split('.').pop()] ?? 'application/octet-stream'

/** Static assets direct upload: manifest → session → buckets → completion JWT. */
async function uploadAssets(env, script, assets) {
  const manifest = {}
  const byHash = {}
  for (const [path, b64] of Object.entries(assets)) {
    const hash = (await sha256Hex(b64 + path.split('.').pop())).slice(0, 32)
    manifest[path] = { hash, size: Math.floor((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0) }
    byHash[hash] = { b64, path }
  }
  const session = await cf(env, 'POST', `/workers/scripts/${script}/assets-upload-session`, {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ manifest }),
  })
  if (!session.body.success) throw new Error(`assets session: ${JSON.stringify(session.body.errors)}`)
  let completion = session.body.result.jwt
  for (const bucket of session.body.result.buckets ?? []) {
    const form = new FormData()
    for (const h of bucket) form.append(h, new File([byHash[h].b64], h, { type: mime(byHash[h].path) }), h)
    const up = await cf(env, 'POST', `/workers/assets/upload?base64=true`, { bearer: completion, body: form })
    if (!up.body.success) throw new Error(`assets upload: ${JSON.stringify(up.body.errors)}`)
    if (up.body.result?.jwt) completion = up.body.result.jwt
  }
  return completion
}

async function upload(env, t, app, build) {
  const config = parseToml(build.toml)
  if (config.name !== app.script) return json({ error: `toml name ${config.name} is not ${app.script}` }, 403)
  const { bindings, refused } = checkBindings(config, app)
  if (refused.length) return json({ error: 'bindings not registered for this app', refused }, 403)

  const assetsJwt = build.assets && Object.keys(build.assets).length ? await uploadAssets(env, app.script, build.assets) : undefined
  const metadata = {
    main_module: build.main,
    compatibility_date: config.compatibility_date,
    compatibility_flags: config.compatibility_flags ?? [],
    bindings: [...bindings, { type: 'plain_text', name: 'RELEASE', text: `${t.sha.slice(0, 7)} run ${t.run_id}` }],
    // Secrets are set by Launch (pipeline step 10) and must survive a code deploy.
    keep_bindings: ['secret_text'],
    annotations: { 'workers/message': `launch ticket ${t.id}`, 'workers/tag': t.sha.slice(0, 7) },
    ...(assetsJwt && { assets: { jwt: assetsJwt, config: { html_handling: 'auto-trailing-slash' } } }),
  }
  const form = new FormData()
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }))
  for (const [name, b64] of Object.entries(build.modules)) {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    form.append(name, new File([bytes], name, { type: 'application/javascript+module' }), name)
  }
  const r = await cf(env, 'POST', `/workers/scripts/${app.script}/versions`, { body: form })
  if (!r.body.success) return json({ error: 'version upload failed', detail: r.body.errors }, 502)
  return json({ versionId: r.body.result.id, bindings: metadata.bindings.map((b) => `${b.type}:${b.name}`) })
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url)
    const parts = url.pathname.split('/').filter(Boolean)
    const store = env.TICKETS.get(env.TICKETS.idFromName('all'))
    try {
      if (parts[0] === 'admin') {
        if (req.headers.get('x-admin-key') !== env.ADMIN_KEY) return json({ error: 'forbidden' }, 403)
        if (parts[1] === 'tickets') return json(await store.list())
        const t = await store.get(parts[1])
        if (!t) return json({ error: 'no ticket' }, 404)
        if (t.status !== 'pending') return json({ error: `ticket is ${t.status}` }, 409)
        t.status = parts[2] === 'approve' ? 'approved' : 'rejected'
        t.decidedAt = new Date().toISOString()
        return json(await store.put(t))
      }
      if (parts[0] !== 'deploy') return new Response('rfspike launch gateway', { status: 404 })

      const { claims, app } = await caller(req, env)
      if (parts[1] === 'start' && req.method === 'POST') {
        const t = {
          id: crypto.randomUUID(),
          env: claims.environment,
          script: app.script,
          run_id: claims.run_id,
          sha: claims.sha,
          ref: claims.ref,
          actor: claims.actor,
          status: app.policy === 'auto' ? 'approved' : 'pending',
          createdAt: new Date().toISOString(),
        }
        return json(await store.put(t))
      }

      const t = await store.get(parts[1])
      if (!t) return json({ error: 'no ticket' }, 404)
      // A ticket belongs to the run that opened it; another run (or a re-run) can't use it.
      if (t.run_id !== claims.run_id || t.env !== claims.environment) return json({ error: 'ticket belongs to another run' }, 403)

      if (!parts[2] && req.method === 'GET') return json(t)
      if (parts[2] === 'upload' && req.method === 'POST') {
        if (t.status !== 'approved') return json({ error: `ticket is ${t.status}` }, 409)
        const res = await upload(env, t, app, await req.json())
        const result = await res.json()
        if (!res.ok) {
          t.status = 'refused'
          t.result = result
          await store.put(t)
          return json(result, res.status)
        }
        t.versionId = result.versionId
        t.status = 'uploaded'
        const migratorUrl = await rotateMigrator(env, app)
        t.credsIssued = new Date().toISOString()
        await store.put(t)
        return json({ ...result, migratorUrl })
      }
      if (parts[2] === 'activate' && req.method === 'POST') {
        if (t.status !== 'uploaded') return json({ error: `ticket is ${t.status}` }, 409)
        const d = await cf(env, 'POST', `/workers/scripts/${app.script}/deployments`, {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ strategy: 'percentage', versions: [{ version_id: t.versionId, percentage: 100 }] }),
        })
        if (!d.body.success) return json({ error: 'activate failed', detail: d.body.errors }, 502)
        await rotateMigrator(env, app)
        t.finished = new Date().toISOString()
        t.status = 'deployed'
        await store.put(t)
        return json(t)
      }
      if (parts[2] === 'finish' && req.method === 'POST') {
        if (t.credsIssued && !t.finished) {
          await rotateMigrator(env, app)
          t.finished = new Date().toISOString()
          await store.put(t)
        }
        return json(t)
      }
      return json({ error: 'no route' }, 404)
    } catch (e) {
      if (e instanceof Response) return e
      return json({ error: String(e?.message ?? e) }, 500)
    }
  },
}
