// Delete everything the spikes created, newest first, by recorded id.
//   node spikes/teardown.mjs          delete recorded resources
//   node spikes/teardown.mjs --check  also sweep every service for leftover rfspike-* names (read-only)
import { optional } from './lib/env.mjs'
import { forget, listCreated, PREFIX } from './lib/created.mjs'
import { cf, gh, ghInstallationToken, neon, resend } from './lib/http.mjs'

const env = process.env
const acc = env.CF_ACCOUNT_ID
const zone = env.CF_ZONE_ID
const CF = env.CF_ADMIN_TOKEN && cf(env.CF_ADMIN_TOKEN)
const NEON = env.NEON_API_KEY && neon(env.NEON_API_KEY)
const RESEND = env.RESEND_API_KEY && resend(env.RESEND_API_KEY)

async function ghClient() {
  if (!env.GH_APP_ID) return undefined
  return gh(
    await ghInstallationToken({
      appId: env.GH_APP_ID,
      keyPath: env.GH_APP_PRIVATE_KEY_PATH,
      installationId: env.GH_APP_INSTALLATION_ID,
    }),
  )
}

const deleters = {
  'cf.token': (r) => CF('DELETE', `/accounts/${acc}/tokens/${r.id}`),
  'cf.domain': (r) => CF('DELETE', `/accounts/${acc}/workers/domains/${r.id}`),
  'cf.route': (r) => CF('DELETE', `/zones/${zone}/workers/routes/${r.id}`),
  'cf.worker': (r) => CF('DELETE', `/accounts/${acc}/workers/scripts/${r.id}?force=true`),
  'cf.dns': (r) => CF('DELETE', `/zones/${zone}/dns_records/${r.id}`),
  'cf.hyperdrive': (r) => CF('DELETE', `/accounts/${acc}/hyperdrive/configs/${r.id}`),
  'cf.kv': (r) => CF('DELETE', `/accounts/${acc}/storage/kv/namespaces/${r.id}`),
  'cf.queue': (r) => CF('DELETE', `/accounts/${acc}/queues/${r.id}`),
  'cf.r2': async (r) => {
    const objs = await CF('GET', `/accounts/${acc}/r2/buckets/${r.id}/objects`)
    for (const o of objs.json?.result ?? []) await CF('DELETE', `/accounts/${acc}/r2/buckets/${r.id}/objects/${o.key}`)
    return CF('DELETE', `/accounts/${acc}/r2/buckets/${r.id}`)
  },
  'neon.project': (r) => NEON('DELETE', `/projects/${r.id}`),
  'neon.branch': (r) => NEON('DELETE', `/projects/${r.id.split('/')[0]}/branches/${r.id.split('/')[1]}`),
  'neon.apikey': (r) => NEON('DELETE', `/organizations/${env.NEON_ORG_ID}/api_keys/${r.id}`),
  'resend.key': (r) => RESEND('DELETE', `/api-keys/${r.id}`),
  'resend.domain': (r) => RESEND('DELETE', `/domains/${r.id}`),
  'gh.repo': async (r) => (await ghClient())('DELETE', `/repos/${env.GH_ORG}/${r.id}`),
}

let failed = 0
for (const r of listCreated().reverse()) {
  const del = deleters[r.kind]
  if (!del) {
    console.warn(`no deleter for ${r.kind} ${r.id}; remove it by hand`)
    failed++
    continue
  }
  const res = await del(r)
  if (res.ok || res.status === 404) forget(r.kind, r.id)
  else {
    console.error(`  failed: ${r.kind} ${r.id}: ${res.text.slice(0, 300)}`)
    failed++
  }
}

if (process.argv.includes('--check')) {
  const leftovers = []
  const has = (s) => typeof s === 'string' && s.includes(PREFIX)
  if (CF) {
    const sweeps = [
      [`/accounts/${acc}/tokens`, (x) => x.name],
      [`/accounts/${acc}/workers/scripts`, (x) => x.id],
      [`/accounts/${acc}/workers/domains`, (x) => x.hostname],
      [`/zones/${zone}/dns_records?per_page=500`, (x) => x.name],
      [`/zones/${zone}/workers/routes`, (x) => `${x.pattern} ${x.script ?? ''}`],
      [`/accounts/${acc}/hyperdrive/configs`, (x) => x.name],
      [`/accounts/${acc}/storage/kv/namespaces?per_page=100`, (x) => x.title],
      [`/accounts/${acc}/queues`, (x) => x.queue_name],
    ]
    for (const [path, name] of sweeps) {
      const res = await CF('GET', path)
      for (const x of res.json?.result ?? []) if (has(name(x))) leftovers.push(`cf ${path.split('?')[0]}: ${name(x)}`)
    }
  }
  if (NEON) {
    const res = await NEON('GET', `/projects?org_id=${optional('NEON_ORG_ID') ?? ''}`)
    for (const p of res.json?.projects ?? []) if (has(p.name)) leftovers.push(`neon project: ${p.name} (${p.id})`)
  }
  if (RESEND) {
    for (const [path, key] of [['/domains', 'name'], ['/api-keys', 'name']]) {
      const res = await RESEND('GET', path)
      for (const x of res.json?.data ?? []) if (has(x[key])) leftovers.push(`resend ${path}: ${x[key]}`)
    }
  }
  const G = await ghClient()
  if (G) {
    const res = await G('GET', `/installation/repositories?per_page=100`)
    for (const r of res.json?.repositories ?? []) if (has(r.name)) leftovers.push(`github repo: ${r.full_name}`)
  }
  console.log(leftovers.length ? `\nLEFTOVERS:\n  ${leftovers.join('\n  ')}` : '\nNo rfspike-* resources remain.')
  if (leftovers.length) failed++
}

process.exit(failed ? 1 : 0)
