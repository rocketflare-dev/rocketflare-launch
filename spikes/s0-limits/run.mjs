// S0: read-only. How close is this account to the limits that cap fleet size?
// Per app, the spec (06) creates: 2 Workers, 2 Worker routes, 2 Hyperdrive, 2 KV, 2 Queues, 2 R2,
// 1 Neon project. Email uses one shared Resend domain for the whole fleet (spec/04).
import { need } from '../lib/env.mjs'
import { cf, neon, resend } from '../lib/http.mjs'

const { CF_ACCOUNT_ID: acc, CF_ZONE_ID: zone, CF_ADMIN_TOKEN, NEON_API_KEY, NEON_ORG_ID, RESEND_API_KEY } = need(
  'CF_ACCOUNT_ID', 'CF_ZONE_ID', 'CF_ADMIN_TOKEN', 'NEON_API_KEY', 'NEON_ORG_ID', 'RESEND_API_KEY',
)
const CF = cf(CF_ADMIN_TOKEN)
const NEON = neon(NEON_API_KEY)
const RESEND = resend(RESEND_API_KEY)

const neonOrg = await NEON('GET', `/organizations/${NEON_ORG_ID}`)
// neon.com/docs/introduction/plans: 100 projects on Free and Launch, 1,000 (soft) on Scale
const NEON_PROJECT_LIMIT = neonOrg.json?.plan === 'scale' ? 1000 : 100

const count = async (res, pick = (j) => j?.result) => (res.ok ? (pick(res.json) ?? []).length : `err ${res.status}`)

// [resource, per app, documented paid limit, current count]
const rows = [
  ['Workers scripts', 2, 500, await count(await CF('GET', `/accounts/${acc}/workers/scripts`))],
  ['Worker routes (zone)', 2, 1000, await count(await CF('GET', `/zones/${zone}/workers/routes`))],
  ['Hyperdrive configs', 2, 25, await count(await CF('GET', `/accounts/${acc}/hyperdrive/configs`))],
  ['KV namespaces', 2, 1000, await count(await CF('GET', `/accounts/${acc}/storage/kv/namespaces?per_page=100`))],
  ['Queues', 2, 10000, await count(await CF('GET', `/accounts/${acc}/queues`))],
  ['R2 buckets', 2, 1000000, await count(await CF('GET', `/accounts/${acc}/r2/buckets`), (j) => j?.result?.buckets)],
  ['Neon projects', 1, NEON_PROJECT_LIMIT, await count(await NEON('GET', `/projects?org_id=${NEON_ORG_ID}&limit=400`), (j) => j?.projects)],
  ['Resend domains (shared, not per app)', 0, 'plan: 3 Free, 10 Pro, 1000 Scale', await count(await RESEND('GET', '/domains'), (j) => j?.data)],
]


console.log('\n| Resource | Per app | Limit | In use | Apps that fit |\n|---|---|---|---|---|')
for (const [name, perApp, limit, used] of rows) {
  const fit = typeof limit === 'number' && typeof used === 'number' ? Math.floor((limit - used) / perApp) : '—'
  console.log(`| ${name} | ${perApp} | ${limit} | ${used} | ${fit} |`)
}
console.log('\nCF zone plan:', (await CF('GET', `/zones/${zone}`)).json?.result?.plan?.name)
console.log('Neon org:', neonOrg.ok ? JSON.stringify({ plan: neonOrg.json?.plan, name: neonOrg.json?.name }) : neonOrg.status)
