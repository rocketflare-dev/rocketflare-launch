/**
 * `pnpm provision <phase> [flags]` — stand up (and later update) ONE Launch instance on your own
 * Cloudflare account and domain, from one git-ignored file at the repo root: `launch.deploy.env`
 * (copy `launch.deploy.env.example`; `LAUNCH_DEPLOY_FILE=` selects another instance's file). The
 * runbook is docs/DEPLOYMENT.md; the `/launch-deploy` skill drives it.
 *
 * The committed `apps/web/wrangler{,.staging}.toml` stay neutral templates. What provisioning
 * creates is recorded in `.launch/state.json` (ids, never a secret), and every wrangler call
 * targets `apps/web/wrangler.deploy.toml`, RENDERED from the template, the file and the state.
 *
 * Phases (each idempotent find-or-create, each ending in ONE `Verify:` line):
 *   check (alias preflight)   names present (names only), tools (Docker builds linux/amd64), the
 *                             account token, the zone in its account, the zone audit, Neon, Resend,
 *                             the GitHub App. Read-only: writes nothing, creates nothing
 *   github-app                the GitHub App from a manifest (two clicks) → GITHUB_APP_ID + key
 *   email create|status|verify   Resend domain → DNS records in the zone; verify + the sending key
 *   neon                      the instance's Neon project (default branch), SELECT 1
 *   cloudflare                KV / Queue / R2 by the instance's names → ids into the state
 *   migrate                   the migrations against the instance database
 *   route (alias urls)        the proxied wildcard `AAAA * → 100::` (only if no `*` record exists)
 *   render                    apps/web/wrangler.deploy.toml
 *   deploy                    render → (drain check) → build → wrangler deploy → /api/health, /api/ready
 *   secrets [--dry-run]       OAUTH_ENCRYPTION_KEY (file, else generated + written back first),
 *                             BOOTSTRAP_ADMIN_EMAILS, DATABASE_URL, every optional secret set
 *   setup                     the Setup page's settings + sealed credentials, audited, in the DB
 *   all                       every phase above in order (github-app only when missing)
 *   tokens                    TTY only: prompt (hidden) for the tokens → the instance file
 *   github [name]             CI later: a GitHub Environment + DATABASE_URL / CLOUDFLARE_* secrets
 *                             (not part of `all`)
 *
 * Secrets: every printed line passes `redact()` (which also masks the exact values read from the
 * file), connection strings reach child processes through their environment or stdin only, Worker
 * secrets go over stdin. Vendor REST calls (no vendor CLIs): scripts/provision/*.ts carry the
 * verified API facts. wrangler runs as `pnpm exec wrangler` INSIDE apps/web.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { readManifest } from '../../../scripts/lib/manifest.mjs'
import { checkGitHubApp } from '../src/api/services/launch/setup'
import { loadConfig } from '../src/config'
import { closeAllDatabases, getScriptDatabase } from '../src/db/client'
import { openScriptSql } from './lib/sql'
import {
  CloudflareClient,
  missingZoneHint,
  WILDCARD_RECORD,
  zoneAuditFindings,
} from './provision/cloudflare-dns'
import {
  accountId,
  apexOf,
  capture,
  DEPLOY_FILE,
  DEPLOY_TOML,
  DEPLOY_TOML_BASENAME,
  heading,
  LEGACY_TOKEN_FILE,
  log,
  OPTIONAL_WORKER_SECRETS,
  ProvisionError,
  REQUIRED_TOKENS,
  ROOT_DIR,
  readState,
  requireInstance,
  requireToken,
  run,
  STATE_FILE_LABEL,
  sleep,
  TEMPLATE_TOML,
  TOKEN_FILE_LABEL,
  TOKEN_HELP,
  token,
  tokenSource,
  verifyLine,
  WEB_DIR,
  warn,
  wrangler,
  wranglerConfigArgs,
  writeDeployFileValue,
  writeState,
} from './provision/config'
import { githubAppPhase, readGitHubAppKey } from './provision/github-app'
import {
  GITHUB_APP_KEYS,
  type Instance,
  instanceResourceNames,
  REQUIRED_INSTANCE_KEYS,
  readInstance,
} from './provision/instance'
import {
  buildConnectionUrl,
  NeonClient,
  pickDatabase,
  pickEndpoint,
  pickRole,
  toPooledNeonUrl,
} from './provision/neon'
import { readTomlString } from './provision/patch-toml'
import {
  type PluginResources,
  pluginDeclarations,
  pluginResourceList,
  readPluginResources,
} from './provision/plugin-resources'
import { redact } from './provision/redact'
import { renderDeployToml, renderedPlaceholders } from './provision/render-toml'
import { emailFromFor, ResendClient, resendRecordsToDns, zoneCandidates } from './provision/resend'
import {
  describeSecretPlan,
  generateHexKey,
  listWorkerSecrets,
  planSecrets,
  putWorkerSecret,
} from './provision/secrets'
import { writeInstanceSetup } from './provision/setup-db'
import { MANUAL_SCOPES } from './provision/token-template'
import { tokensPhase } from './provision/tokens'

// ---- arguments ----------------------------------------------------------------------------

interface Flags {
  skipEmail: boolean
  rotate: boolean
  dryRun: boolean
  drained: boolean
  adopt: boolean
  debug: boolean
  help: boolean
}

const USAGE = `usage: pnpm provision <phase> [flags]          (instance file: ${TOKEN_FILE_LABEL})

phases (\`all\` runs them in this order)
  check                 read-only: names present, tools (Docker linux/amd64), the account token, the zone
                        and its audit, Neon, Resend, the GitHub App. Alias: preflight
  github-app            create the GitHub App from a manifest (you click Create, then Install)
  email create | status | verify   Resend domain + DNS records; verify and set the sending key
  neon                  the instance's Neon project, SELECT 1
  cloudflare            KV, Queue, R2 by the instance's names → ids in ${STATE_FILE_LABEL}
  migrate               run the migrations against the instance database
  route                 the proxied wildcard DNS record *.<domain> (only if none exists). Alias: urls
  render                write apps/web/${DEPLOY_TOML_BASENAME} from wrangler.toml + the file + the state
  deploy                render, build, wrangler deploy, then /api/health and /api/ready
  secrets               OAUTH_ENCRYPTION_KEY + BOOTSTRAP_ADMIN_EMAILS + DATABASE_URL + every optional
                        secret set in the file (--dry-run: names only, nothing put)
  setup                 Setup's settings and sealed credentials into the instance database (audited)
  all                   every phase in order; stops at the first failed Verify; rerun to UPDATE
  tokens                prompt for the tokens (hidden input, verified) → the instance file
  github [environment]  CI later: a GitHub Environment (default production) + DATABASE_URL / CLOUDFLARE_*

flags
  --dry-run             secrets: list what would be put, generated or skipped (names only)
  --rotate              regenerate OAUTH_ENCRYPTION_KEY (re-seals Setup credentials), the Neon password,
                        the Resend sending key; github-app: create a new app
  --drained             deploy: sessions are drained (Admin → Sessions → Drain), go ahead with a new image
  --adopt               neon: use an existing project with the instance's name the state does not record
  --skip-email          no Resend: skip email create/verify (magic links are only logged)
  --debug               print sanitised vendor payloads to stderr
  --help

The instance file holds every answer and token (names in launch.deploy.env.example); an exported
variable of the same name wins (CI). Values are never printed. Ids are kept in ${STATE_FILE_LABEL}.`

function parseArgs(argv: string[]): { positional: string[]; flags: Flags } {
  const flags: Flags = {
    skipEmail: false,
    rotate: false,
    dryRun: false,
    drained: false,
    adopt: false,
    debug: false,
    help: false,
  }
  const positional: string[] = []
  for (const a of argv) {
    switch (a) {
      case '--help':
      case '-h':
        flags.help = true
        break
      case '--skip-email':
        flags.skipEmail = true
        break
      case '--rotate':
        flags.rotate = true
        break
      case '--dry-run':
        flags.dryRun = true
        break
      case '--drained':
        flags.drained = true
        break
      case '--adopt':
        flags.adopt = true
        break
      case '--debug':
        flags.debug = true
        break
      default:
        if (a.startsWith('--')) throw new ProvisionError(`unknown flag ${a}\n${USAGE}`, 2)
        positional.push(a)
    }
  }
  return { positional, flags }
}

// ---- shared helpers -----------------------------------------------------------------------

function cfClient(): CloudflareClient {
  return new CloudflareClient(requireToken('CLOUDFLARE_API_TOKEN'))
}
function resendClient(): ResendClient {
  return new ResendClient(requireToken('RESEND_API_KEY'))
}

/**
 * The account the instance lives in: the file's `CLOUDFLARE_ACCOUNT_ID`, the state, else the ONE
 * account the token sees (several → name them and stop). `persist` records a discovery.
 */
async function resolveAccount(cf: CloudflareClient, persist: boolean) {
  const known = accountId()
  const accounts = await cf.listAccounts().catch(() => [] as { id: string; name: string }[])
  if (known) {
    const name = accounts.find(a => a.id === known)?.name ?? readState().cloudflare?.accountName
    if (persist) writeState({ cloudflare: { accountId: known, accountName: name } })
    return { id: known, name: name ?? known }
  }
  if (accounts.length === 1) {
    const [only] = accounts
    if (persist) writeState({ cloudflare: { accountId: only.id, accountName: only.name } })
    return { id: only.id, name: only.name }
  }
  throw new ProvisionError(
    accounts.length
      ? `the token sees ${accounts.length} accounts (${accounts.map(a => `${a.name} ${a.id}`).join(', ')}) — set CLOUDFLARE_ACCOUNT_ID in ${TOKEN_FILE_LABEL}`
      : `the token sees no account — set CLOUDFLARE_ACCOUNT_ID in ${TOKEN_FILE_LABEL}, and give the token Account Settings: Read`,
    2
  )
}

interface Zone {
  id: string
  name: string
}

/** The zone `name` lives in, which must belong to `account` (routes only reach that account's Workers). */
async function requireZone(cf: CloudflareClient, name: string, account: string): Promise<Zone> {
  for (const candidate of zoneCandidates(name)) {
    const zone = await cf.findZoneWithAccount(candidate)
    if (!zone) continue
    if (zone.account?.id && zone.account.id !== account)
      throw new ProvisionError(
        `zone ${zone.name} is in account ${zone.account.id}, not ${account} — a Worker route can only point at a Worker in the zone's own account`
      )
    return { id: zone.id, name: zone.name }
  }
  if (!(await cf.hasAnyZone()))
    warn('the token sees no zones at all — it is missing Zone: Zone Read / DNS Edit on the zone')
  throw new ProvisionError(missingZoneHint(apexOf(name)))
}

function installedPluginResources(): PluginResources[] {
  const { manifest } = readManifest(ROOT_DIR)
  return readPluginResources(ROOT_DIR, manifest?.surfaces ?? [])
}

async function fetchJson(url: string, attempts = 6): Promise<any> {
  let last: any
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' } })
      const body = await res.json().catch(() => ({}))
      last = { status: res.status, body }
      if (res.ok) return body
      if (res.status === 503) return { ...(body as object), __status: 503 }
    } catch (err) {
      last = err instanceof Error ? err.message : err
    }
    if (i < attempts) await sleep(5000)
  }
  throw new ProvisionError(
    `${url}: ${redact(typeof last === 'string' ? last : JSON.stringify(last))}`
  )
}

// ---- check --------------------------------------------------------------------------------

type Mark = 'ok' | 'warn' | 'fail' | 'info'
const line = (mark: Mark, text: string) =>
  log(`  ${{ ok: 'ok  ', warn: 'WARN', fail: 'FAIL', info: '  · ' }[mark]} ${text}`)

/** Docker must be up and able to build the linux/amd64 session image `wrangler deploy` pushes. */
function checkDocker(problems: string[]): void {
  const server = capture('docker', ['version', '--format', '{{.Server.Os}}/{{.Server.Arch}}'])
  if (!server) {
    line(
      'fail',
      'docker: not running (or not installed) — start Docker Desktop; deploy builds the session image'
    )
    problems.push('Docker is not running')
    return
  }
  // A builder that lists linux/amd64 is enough; otherwise RUN an amd64 container — Rosetta
  // (colima `--vz-rosetta`, Docker Desktop) emulates amd64 without any builder listing it.
  const amd64 =
    server === 'linux/amd64' ||
    /linux\/amd64/.test(capture('docker', ['buildx', 'ls']) ?? '') ||
    capture('docker', [
      'run',
      '--rm',
      '--platform',
      'linux/amd64',
      'alpine:3.20',
      'uname',
      '-m',
    ]) === 'x86_64'
  if (!amd64) {
    line(
      'fail',
      `docker: ${server}, and an amd64 container does not run — enable amd64 emulation (Docker Desktop: Settings → General → Rosetta; colima: \`colima start --vz-rosetta\`; or \`docker run --privileged --rm tonistiigi/binfmt --install amd64\`)`
    )
    problems.push('Docker cannot build linux/amd64')
  } else line('ok', `docker: ${server}, builds linux/amd64`)
  const mem = Number(capture('docker', ['info', '--format', '{{.MemTotal}}']) ?? 0)
  if (mem && mem < 11 * 1024 ** 3)
    line(
      'warn',
      `docker: ${(mem / 1024 ** 3).toFixed(1)} GB memory — the session image build wants 12 GB or more`
    )
}

async function checkPhase(flags: Flags): Promise<void> {
  heading(`check — ${TOKEN_FILE_LABEL}`)
  const problems: string[] = []

  // 1. the file and the names in it (names only — a value is never shown)
  if (!fs.existsSync(DEPLOY_FILE)) {
    line(
      'fail',
      `${TOKEN_FILE_LABEL} does not exist — cp launch.deploy.env.example ${TOKEN_FILE_LABEL}, then fill it in`
    )
    problems.push(`${TOKEN_FILE_LABEL} missing`)
  }
  if (fs.existsSync(LEGACY_TOKEN_FILE)) {
    line(
      'fail',
      `apps/web/.provision.env is no longer read — move its values into ${TOKEN_FILE_LABEL} and delete it`
    )
    problems.push('apps/web/.provision.env must be moved')
  }
  const reading = readInstance(token)
  const tokens = REQUIRED_TOKENS.filter(t => !(flags.skipEmail && t === 'RESEND_API_KEY'))
  log('  names:')
  for (const k of [...REQUIRED_INSTANCE_KEYS, ...tokens])
    line(
      token(k) ? 'ok' : 'fail',
      `${k}${token(k) ? ` (${tokenSource(k)?.source})` : ' — MISSING'}`
    )
  for (const k of GITHUB_APP_KEYS)
    line(
      token(k) ? 'ok' : 'info',
      `${k}${token(k) ? '' : ' — not yet (pnpm provision github-app writes it)'}`
    )
  line(
    token('OAUTH_ENCRYPTION_KEY') ? 'ok' : 'info',
    `OAUTH_ENCRYPTION_KEY${token('OAUTH_ENCRYPTION_KEY') ? '' : ' — not yet (secrets generates it and writes it back)'}`
  )
  const optional = OPTIONAL_WORKER_SECRETS.filter(n => token(n))
  line('info', `optional Worker secrets set: ${optional.join(', ') || 'none'}`)
  const missingNames = [...reading.missing, ...tokens.filter(t => !token(t))]
  for (const msg of reading.invalid) line('fail', msg)
  if (missingNames.length) problems.push(`missing: ${missingNames.join(', ')}`)
  if (reading.invalid.length) problems.push(`${reading.invalid.length} invalid answer(s)`)

  // 2. tools
  log('  tools:')
  const major = Number(process.versions.node.split('.')[0])
  if (major < 24) {
    line('fail', `node ${process.versions.node} — Launch needs Node 24 (nvm install reads .nvmrc)`)
    problems.push('Node 24')
  } else line('ok', `node v${process.versions.node}`)
  const wranglerVersion = capture('pnpm', ['exec', 'wrangler', '--version'])
  if (!wranglerVersion) {
    line('fail', 'wrangler: not runnable — run pnpm install')
    problems.push('wrangler')
  } else line('ok', `wrangler ${wranglerVersion.split('\n').pop()}`)
  checkDocker(problems)

  if (problems.length) {
    for (const m of missingNames)
      if (TOKEN_HELP[m]) log(`  ${m} — mint at ${TOKEN_HELP[m].url}\n    (${TOKEN_HELP[m].scopes})`)
    throw new ProvisionError(
      `check: ${problems.join('; ')} — nothing was contacted or changed; fix these and rerun`,
      2
    )
  }
  const instance = reading.instance as Instance
  log(
    `  instance: ${instance.appUrl} (worker ${instance.name}, zone ${instance.domain}, mail ${instance.emailDomain}, org ${instance.githubOrg}, neon ${instance.neonRegion})`
  )

  // 3. Cloudflare — the account token, the zone, the audit
  log('  cloudflare:')
  const cf = cfClient()
  const account = await resolveAccount(cf, false)
  line('ok', `account ${account.name} (${account.id})`)
  try {
    const verify = await cf.verifyAccountToken(account.id)
    if (verify.status !== 'active') throw new ProvisionError(`the token is ${verify.status}`)
    line('ok', `account-owned token ${verify.id} is active`)
  } catch (err) {
    line(
      'fail',
      `the token does not verify as an ACCOUNT-owned token of ${account.id} (${err instanceof Error ? err.message : String(err)}). Launch's Setup check requires one: create it under Manage Account → API Tokens (${TOKEN_HELP.CLOUDFLARE_API_TOKEN.url})`
    )
    problems.push('Cloudflare token is not an active account-owned token')
  }
  let zone: Zone | undefined
  try {
    zone = await requireZone(cf, instance.domain, account.id)
    await cf.assertDnsRead(zone)
    line('ok', `zone ${zone.name} (${zone.id}) in this account, DNS readable`)
  } catch (err) {
    line('fail', err instanceof Error ? err.message : String(err))
    problems.push('zone')
  }
  if (zone) {
    const records = await cf.listAllRecords(zone.id)
    const customDomains = await cf.listWorkerDomains(account.id, zone.id).catch(() => [])
    const audit = zoneAuditFindings({
      domain: instance.domain,
      host: instance.host,
      records,
      customDomains,
    })
    if (audit.captured.length)
      line(
        'warn',
        `zone audit: ${audit.captured.length} proxied host(s) not served by a Worker custom domain — Launch's *.${instance.domain}/* route would capture them: ${audit.captured.join(', ')}. Move each to a Worker custom domain (or accept that it now reaches Launch) before deploying`
      )
    else line('ok', `zone audit: no proxied host would be captured by *.${instance.domain}/*`)
    if (audit.hostTaken)
      line(
        'warn',
        `${instance.host} already has a DNS record (${audit.hostTaken}) — the custom domain deploy creates its own; delete that record first`
      )
    const wildcard = records.filter(r => r.name === `*.${instance.domain}`)
    line(
      wildcard.some(r => r.proxied) ? 'ok' : wildcard.length ? 'warn' : 'info',
      wildcard.length
        ? `wildcard *.${instance.domain}: ${wildcard.map(r => `${r.type}${r.proxied ? ' proxied' : ' DNS-only — turn its proxy on'}`).join(', ')}`
        : `wildcard *.${instance.domain}: none yet (route creates AAAA * → 100::, proxied)`
    )
    try {
      const routes = await cf.listWorkerRoutes(zone.id)
      line('ok', `Workers routes readable (${routes.length} in the zone)`)
    } catch (err) {
      line(
        'fail',
        `Workers routes not readable — the token needs Zone: Workers Routes Edit (${err instanceof Error ? err.message : String(err)})`
      )
      problems.push('Workers Routes scope')
    }
  }
  line(
    'info',
    `Workers Paid (containers) and ${MANUAL_SCOPES.join(' / ')} cannot be proven without creating something; the first deploy fails loudly if either is missing`
  )

  // 4. Neon, Resend, GitHub
  log('  neon:')
  try {
    const neon = new NeonClient(requireToken('NEON_API_KEY'), fetch, flags.debug)
    const { projects } = await neon.listProjectsSample(instance.neonOrgId)
    line(
      'ok',
      `API key works (${projects.length ? `org ${projects[0].org_id ?? 'personal'}` : 'no projects yet'})`
    )
    const state = readState().neon
    if (state?.projectId) line('info', `instance project ${state.projectId} (${state.host ?? '?'})`)
  } catch (err) {
    line('fail', err instanceof Error ? err.message : String(err))
    problems.push('Neon key')
  }
  if (!flags.skipEmail) {
    log('  resend:')
    try {
      const resend = resendClient()
      await resend.request('GET', '/api-keys')
      const domains = await resend.listDomains()
      const mine = domains.find(d => d.name === instance.emailDomain)
      line('ok', `full-access key (${domains.length} domain(s))`)
      line(
        'info',
        `${instance.emailDomain}: ${mine ? mine.status : 'not created yet (email create)'}`
      )
    } catch (err) {
      line(
        'fail',
        `${err instanceof Error ? err.message : String(err)} — Launch needs a FULL-ACCESS Resend key`
      )
      problems.push('Resend key')
    }
  }
  log('  github:')
  const appId = token('GITHUB_APP_ID')
  if (!appId) line('info', 'no GitHub App yet — `pnpm provision github-app` (all runs it)')
  else {
    try {
      const privateKey = readGitHubAppKey()
      if (!privateKey) throw new ProvisionError('GITHUB_APP_PRIVATE_KEY_FILE is not set')
      const outcome = await checkGitHubApp(
        { appId, privateKey },
        { github_org: instance.githubOrg }
      )
      for (const c of outcome.checks)
        line(
          c.status === 'ok' ? 'ok' : c.status === 'warning' ? 'warn' : 'fail',
          `${c.label}${c.detail ? ` — ${c.detail}` : ''}`
        )
      if (outcome.checks.some(c => c.status === 'failed')) problems.push('GitHub App')
    } catch (err) {
      line('fail', err instanceof Error ? err.message : String(err))
      problems.push('GitHub App')
    }
  }

  if (problems.length) throw new ProvisionError(`check: ${problems.join('; ')}`, 1)
  verifyLine(
    `check ok — ${instance.appUrl}: names present, Docker builds linux/amd64, account ${account.name}, zone ${instance.domain}, Neon, ${flags.skipEmail ? 'email skipped' : 'Resend'}, GitHub App ${appId ? 'ok' : 'pending'}`
  )
}

// ---- email --------------------------------------------------------------------------------

async function findOrCreateDomain(instance: Instance) {
  const resend = resendClient()
  let domain = (await resend.listDomains()).find(d => d.name === instance.emailDomain)
  let created = false
  if (!domain) {
    domain = await resend.createDomain(instance.emailDomain, instance.emailRegion)
    created = true
  }
  const full = await resend.getDomain(domain.id)
  writeState({ resend: { domainId: full.id, domainName: full.name, region: full.region } })
  return { domain: full, created }
}

async function emailCreate(): Promise<void> {
  heading('email create')
  const instance = requireInstance()
  const { domain, created } = await findOrCreateDomain(instance)
  log(
    `resend domain: ${domain.name} ${created ? 'created' : 'exists'} (status ${domain.status}, region ${domain.region ?? '?'})`
  )
  const records = resendRecordsToDns(domain.records ?? [], domain.name)
  if (!records.length) throw new ProvisionError('Resend returned no DNS records for the domain')
  const cf = cfClient()
  const account = await resolveAccount(cf, true)
  const zone = await requireZone(cf, domain.name, account.id)
  const counts = { exists: 0, created: 0, updated: 0 }
  for (const rec of records) {
    const outcome = await cf.upsertRecord(zone.id, rec)
    counts[outcome]++
    log(
      `  ${outcome.padEnd(7)} ${rec.type.padEnd(5)} ${rec.name}${rec.priority !== undefined ? ` (priority ${rec.priority})` : ''}`
    )
  }
  verifyLine(
    `email create ok — domain=${domain.name} zone=${zone.name} records=${records.length} (created ${counts.created}, updated ${counts.updated}, existing ${counts.exists})`
  )
}

async function emailStatus(): Promise<void> {
  heading('email status')
  const instance = requireInstance()
  const { domain } = await findOrCreateDomain(instance)
  const cf = cfClient()
  const account = await resolveAccount(cf, true)
  const zone = await requireZone(cf, domain.name, account.id).catch(() => undefined)
  if (!zone) warn(missingZoneHint(apexOf(domain.name)))
  const records = resendRecordsToDns(domain.records ?? [], domain.name)
  let present = 0
  for (const [i, rec] of records.entries()) {
    const found = zone ? (await cf.listRecords(zone.id, rec.name, rec.type)).length > 0 : false
    if (found) present++
    log(
      `  ${found ? 'present' : 'MISSING'}  ${rec.type.padEnd(5)} ${rec.name}   resend: ${domain.records?.[i]?.status ?? '?'}`
    )
  }
  verifyLine(
    `email status — domain=${domain.name} status=${domain.status} dns=${present}/${records.length} present`
  )
}

async function emailVerify(flags: Flags): Promise<void> {
  heading('email verify')
  const instance = requireInstance()
  const { domain } = await findOrCreateDomain(instance)
  const resend = resendClient()
  let status = domain.status
  if (status !== 'verified') {
    await resend.verifyDomain(domain.id)
    const deadline = Date.now() + 10 * 60_000
    while (Date.now() < deadline) {
      await sleep(15_000)
      status = (await resend.getDomain(domain.id)).status
      log(`  ${domain.name}: ${status}`)
      if (status === 'verified') break
      if (status === 'failed')
        throw new ProvisionError(
          `Resend reports ${domain.name} as failed — run \`pnpm provision email status\``
        )
    }
    if (status !== 'verified')
      throw new ProvisionError(
        `DNS still propagating — Resend reports "${status}" after 10 min; rerun \`pnpm provision email verify\` later`
      )
  }
  log(`resend domain: ${domain.name} verified`)
  await ensureRendered()
  const existing = await listWorkerSecrets()
  if (existing.includes('RESEND_API_KEY') && !flags.rotate) {
    log('RESEND_API_KEY already set on the Worker (pass --rotate to mint a new key)')
  } else {
    const key = await resend.createSendingKey(instance.name, domain.id)
    await putWorkerSecret('RESEND_API_KEY', key.token)
    log(
      `RESEND_API_KEY: minted sending key "${instance.name}" (id ${key.id}) and set on the Worker`
    )
  }
  const methods = await fetchJson(`${instance.appUrl}/auth/methods`)
  if (methods?.magicLink !== true)
    throw new ProvisionError(
      `${instance.appUrl}/auth/methods does not report magicLink — is the Worker deployed?`
    )
  verifyLine(
    `email verify ok — domain=${domain.name} verified, RESEND_API_KEY set, ${instance.appUrl}/auth/methods reports magic link`
  )
}

// ---- neon ---------------------------------------------------------------------------------

interface NeonInfo {
  projectId: string
  branchId: string
  host: string
  /** In memory only — the DIRECT host, for DDL and the setup write. */
  url: string
}

let neonMemo: Promise<NeonInfo> | undefined

/** Resolved ONCE per process: `migrate`, `deploy`, `secrets` and `setup` all need the URL. */
function resolveNeon(
  flags: Flags,
  opts: { quiet?: boolean; rotate?: boolean } = {}
): Promise<NeonInfo> {
  neonMemo ??= resolveNeonUncached(flags, opts)
  return neonMemo
}

async function resolveNeonUncached(
  flags: Flags,
  opts: { quiet?: boolean; rotate?: boolean }
): Promise<NeonInfo> {
  const say = opts.quiet ? () => {} : log
  const instance = requireInstance()
  const neon = new NeonClient(requireToken('NEON_API_KEY'), fetch, flags.debug)
  const state = readState().neon

  let project: { id: string; name: string; region_id: string; org_id?: string } | undefined
  let created = false
  if (state?.projectId) {
    project = await neon.getProject(state.projectId).catch(() => undefined)
    if (!project)
      throw new ProvisionError(
        `${STATE_FILE_LABEL} records Neon project ${state.projectId}, which this key cannot see — was it deleted, or is NEON_API_KEY for another org?`
      )
  } else {
    const found = await neon.findProject(instance.name, instance.neonOrgId)
    if (found && !flags.adopt)
      throw new ProvisionError(
        `a Neon project named "${instance.name}" (${found.id}) exists but ${STATE_FILE_LABEL} does not record it. If it IS this instance's (the state was lost), rerun with --adopt; otherwise choose another LAUNCH_NAME`,
        2
      )
    if (found) project = found
    else {
      say(`neon project: creating "${instance.name}" in ${instance.neonRegion} (pg 17)…`)
      project = await neon.createProject(instance.name, instance.neonRegion, instance.neonOrgId)
      created = true
    }
  }
  say(
    `neon project: ${project.name} (${project.id}) ${created ? 'created' : 'exists'} region=${project.region_id}`
  )

  const branches = await neon.listBranches(project.id)
  const main = branches.find(b => b.default || b.primary) ?? branches[0]
  if (!main) throw new ProvisionError('the Neon project has no default branch')
  const endpoint = pickEndpoint(await neon.listEndpoints(project.id, main.id))
  const db = pickDatabase(await neon.listDatabases(project.id, main.id))
  const role = pickRole(await neon.listRoles(project.id, main.id), db.owner_name)
  let password: string | undefined
  const rotated = !created && (opts.rotate ?? false)
  if (created || rotated) {
    password = await neon.resetPassword(project.id, main.id, role)
    say(`  password ${rotated ? 'rotated' : 'set'} for role ${role}`)
  } else {
    password = await neon.revealPassword(project.id, main.id, role)
    if (!password) {
      warn(`Neon does not store passwords for this project — resetting the ${role} password`)
      password = await neon.resetPassword(project.id, main.id, role)
    }
  }
  const url = buildConnectionUrl({ role, password, host: endpoint.host, database: db.name })
  await waitForSelectOne(url)
  say(
    `  branch ${main.name} (${main.id}): host=${endpoint.host} db=${db.name} role=${role} SELECT 1 ok`
  )
  writeState({
    neon: {
      projectId: project.id,
      orgId: project.org_id,
      branchId: main.id,
      host: endpoint.host,
      database: db.name,
      role,
      region: project.region_id,
    },
  })
  if (
    rotated &&
    fs.existsSync(DEPLOY_TOML) &&
    (await listWorkerSecrets()).includes('DATABASE_URL')
  ) {
    await putWorkerSecret('DATABASE_URL', toPooledNeonUrl(url))
    say('  DATABASE_URL re-put on the Worker with the rotated password')
  }
  return { projectId: project.id, branchId: main.id, host: endpoint.host, url }
}

/** Neon computes scale to zero; the first connection can take a few seconds to wake one. */
async function waitForSelectOne(url: string, attempts = 10): Promise<void> {
  for (let i = 1; i <= attempts; i++) {
    const sql = openScriptSql(url, process.env, { connectTimeout: 20 })
    try {
      await sql.query('SELECT 1')
      return
    } catch (err) {
      if (i === attempts)
        throw new ProvisionError(
          `SELECT 1 failed after ${attempts} attempts: ${redact(String(err))}`
        )
      if (i === 1) log('  waiting for the compute to wake…')
      await sleep(4000)
    } finally {
      await sql.end()
    }
  }
}

async function neonPhase(flags: Flags): Promise<void> {
  heading('neon')
  const info = await resolveNeon(flags, { rotate: flags.rotate })
  verifyLine(
    `neon ok — project ${info.projectId}, branch ${info.branchId}, host ${info.host} (SELECT 1)`
  )
}

// ---- cloudflare ---------------------------------------------------------------------------

async function cloudflarePhase(): Promise<void> {
  heading('cloudflare')
  const instance = requireInstance()
  const cf = cfClient()
  const account = await resolveAccount(cf, true)
  const previous = readState().instance?.name
  if (previous && previous !== instance.name)
    warn(
      `LAUNCH_NAME changed from "${previous}" to "${instance.name}": resources are created under the new name; the old ones are left as they are`
    )
  const names = instanceResourceNames(instance.name)
  const plugins = installedPluginResources()
  const list = [
    { type: 'kv', name: names.kv, binding: 'RATE_LIMIT_KV' },
    { type: 'queue', name: names.queue, binding: 'JOBS_QUEUE' },
    { type: 'r2', name: names.bucket, binding: 'FILES' },
    ...pluginResourceList(instance.name, plugins, 'production'),
  ]
  const kv: Record<string, string> = {}
  for (const r of list) {
    if (r.type === 'kv') {
      const { id, created } = await cf.ensureKv(account.id, r.name)
      kv[r.binding] = id
      log(`  kv     ${r.name.padEnd(36)} ${created ? 'created' : 'exists '} id=${id}`)
    } else if (r.type === 'queue') {
      const { created } = await cf.ensureQueue(account.id, r.name)
      log(`  queue  ${r.name.padEnd(36)} ${created ? 'created' : 'exists'}`)
    } else if (r.type === 'r2') {
      const { created } = await cf.ensureR2Bucket(account.id, r.name)
      log(`  r2     ${r.name.padEnd(36)} ${created ? 'created' : 'exists'}`)
    } else throw new ProvisionError(`unsupported resource type ${r.type} (${r.binding})`)
  }
  writeState({
    instance: { name: instance.name, domain: instance.domain, host: instance.host },
    cloudflare: { kv },
  })
  verifyLine(
    `cloudflare ok — account ${account.name}: ${list.map(r => r.name).join(', ')}; ids in ${STATE_FILE_LABEL} (workflows, Durable Objects and the container are registered by deploy)`
  )
}

// ---- migrate ------------------------------------------------------------------------------

function journalCount(): number {
  const journal = JSON.parse(
    fs.readFileSync(path.join(WEB_DIR, 'migrations/meta/_journal.json'), 'utf8')
  )
  return (journal.entries ?? []).length
}

async function migratePhase(flags: Flags): Promise<void> {
  heading('migrate')
  const info = await resolveNeon(flags, { quiet: true })
  await run('pnpm', ['db:migrate:ci'], { cwd: WEB_DIR, env: { DATABASE_URL: info.url } })
  const sql = openScriptSql(info.url, process.env, { connectTimeout: 20 })
  let applied = 0
  try {
    const [row] = await sql.query<{ n: string }>(
      'SELECT count(*) AS n FROM drizzle.__drizzle_migrations'
    )
    applied = Number(row?.n ?? 0)
  } finally {
    await sql.end()
  }
  const expected = journalCount()
  if (applied !== expected)
    throw new ProvisionError(`migrate: ${applied} applied but the journal has ${expected} entries`)
  verifyLine(`migrate ok — ${applied}/${expected} migrations applied on ${info.host}`)
}

// ---- route --------------------------------------------------------------------------------

async function routePhase(): Promise<void> {
  heading('route')
  const instance = requireInstance()
  const cf = cfClient()
  const account = await resolveAccount(cf, true)
  const zone = await requireZone(cf, instance.domain, account.id)
  writeState({
    cloudflare: { zoneId: zone.id, zoneName: zone.name, zones: { [zone.name]: zone.id } },
  })
  const wildcard = `*.${instance.domain}`
  const records = await cf.listRecords(zone.id, wildcard)
  const proxied = records.find(r => r.proxied)
  let outcome: string
  if (proxied) outcome = `exists (${proxied.type}, proxied)`
  else if (records[0])
    throw new ProvisionError(
      `${wildcard} is a DNS-only ${records[0].type} record, so requests never reach the Worker route. Launch does not change a record it did not create: turn its proxy on (orange cloud) in the zone's DNS, or delete it and rerun \`pnpm provision route\``
    )
  else {
    await cf.createRecord(zone.id, {
      ...WILDCARD_RECORD,
      ttl: 1,
      comment: 'Launch: apps wildcard — Worker routes answer, not an origin',
    })
    outcome = 'created AAAA * → 100:: (proxied)'
  }
  log(`  ${wildcard}: ${outcome}`)
  verifyLine(
    `route ok — zone ${zone.name}: ${wildcard} ${outcome}; deploy adds the custom domain ${instance.host} and the route ${wildcard}/*`
  )
}

// ---- render -------------------------------------------------------------------------------

function renderToFile(): { placeholders: string[]; text: string } {
  const instance = requireInstance()
  const template = fs.readFileSync(TEMPLATE_TOML, 'utf8')
  const appName = readTomlString(template, 'APP_NAME') ?? 'Launch'
  const text = renderDeployToml(template, {
    name: instance.name,
    domain: instance.domain,
    host: instance.host,
    emailFrom: emailFromFor(appName, instance.emailDomain),
    kvIds: readState().cloudflare?.kv ?? {},
    plugins: installedPluginResources(),
  })
  fs.writeFileSync(DEPLOY_TOML, text)
  return { placeholders: renderedPlaceholders(text), text }
}

async function ensureRendered(): Promise<void> {
  if (!fs.existsSync(DEPLOY_TOML)) renderToFile()
}

async function renderPhase(): Promise<void> {
  heading('render')
  const instance = requireInstance()
  const { placeholders } = renderToFile()
  verifyLine(
    `render ok — apps/web/${DEPLOY_TOML_BASENAME}: worker ${instance.name}, routes ${instance.host} + *.${instance.domain}/*${placeholders.length ? `; still placeholders ${placeholders.join(', ')} (run \`pnpm provision cloudflare\`)` : ', no placeholders'}`
  )
}

// ---- deploy -------------------------------------------------------------------------------

/**
 * What decides whether a deploy replaces the running session containers: the image directory's
 * files and the rendered `[[containers]]` block. Recorded after each deploy.
 */
function containersHash(rendered: string): string {
  const hash = createHash('sha256')
  const dir = path.join(WEB_DIR, 'containers/session')
  const walk = (d: string): string[] =>
    fs
      .readdirSync(d, { withFileTypes: true })
      .flatMap(e => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]))
  for (const file of walk(dir).sort()) {
    hash.update(path.relative(dir, file))
    hash.update(fs.readFileSync(file))
  }
  const block = /\[\[containers\]\][\s\S]*?\n\n/.exec(rendered)?.[0] ?? ''
  hash.update(block)
  return hash.digest('hex').slice(0, 16)
}

/** Sessions holding a container (what the drain suspends) — counted straight from the database. */
async function liveSessionCount(url: string): Promise<number> {
  const sql = openScriptSql(url, process.env, { connectTimeout: 20 })
  try {
    const [row] = await sql.query<{ n: string }>(
      "SELECT count(*) AS n FROM sessions WHERE status IN ('requested','booting','ready','working','blocked') OR (status = 'suspended' AND container_kept_at IS NOT NULL)"
    )
    return Number(row?.n ?? 0)
  } catch {
    return 0
  } finally {
    await sql.end()
  }
}

function releaseVersion(): string {
  const version = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8')).version
  const sha = capture('git', ['rev-parse', '--short=7', 'HEAD'], ROOT_DIR)
  const dirty = capture('git', ['status', '--porcelain'], ROOT_DIR)
  return `${version}${sha ? `-${sha}` : ''}${dirty ? '-dirty' : ''}`
}

async function deployPhase(flags: Flags): Promise<void> {
  heading('deploy')
  const instance = requireInstance()
  const { placeholders, text } = renderToFile()
  if (placeholders.length)
    throw new ProvisionError(
      `apps/web/${DEPLOY_TOML_BASENAME} still has ${placeholders.join(', ')} — run \`pnpm provision cloudflare\` first`
    )
  const info = await resolveNeon(flags, { quiet: true })

  const hash = containersHash(text)
  const before = readState().deploy?.containersHash
  if (before && before !== hash && !flags.drained) {
    const live = await liveSessionCount(info.url)
    if (live > 0)
      throw new ProvisionError(
        `the session image or [[containers]] changed since the last deploy and ${live} session(s) hold a container — a deploy replaces them mid-turn. Drain first: Admin → Sessions → Drain at ${instance.appUrl}/admin, wait until none is live, then rerun with --drained (and Undrain after)`,
        2
      )
    log(`  session image changed; no live sessions hold a container — no drain needed`)
  }

  const version = releaseVersion()
  await run('pnpm', ['build:ui'], { cwd: WEB_DIR })
  await wrangler(['deploy', ...wranglerConfigArgs(), '--var', `RELEASE_VERSION:${version}`])
  // A `neon` Worker fails `loadConfig` until it holds DATABASE_URL, and a secret can only be put on
  // a Worker that exists — so the first deploy is followed straight away by the secret.
  if (!(await listWorkerSecrets()).includes('DATABASE_URL')) {
    await putWorkerSecret('DATABASE_URL', toPooledNeonUrl(info.url))
    log('  DATABASE_URL (pooled Neon URI) set on the Worker')
  }
  writeState({ deploy: { containersHash: hash, version, at: new Date().toISOString() } })
  // A new custom domain needs its certificate; give it two minutes.
  const health = await fetchJson(`${instance.appUrl}/api/health`, 24)
  if (health?.status !== 'ok')
    throw new ProvisionError(`${instance.appUrl}/api/health → ${JSON.stringify(health)}`)
  const ready = await fetchJson(`${instance.appUrl}/api/ready`, 12)
  if (ready?.__status === 503 || ready?.status !== 'ready')
    throw new ProvisionError(
      `${instance.appUrl}/api/ready → ${JSON.stringify(ready)} — the Worker cannot reach Neon: check its DATABASE_URL secret (\`pnpm provision neon --rotate\` resets the password and re-puts it — never \`secrets --rotate\`, which also replaces OAUTH_ENCRYPTION_KEY)`
    )
  verifyLine(
    `deploy ok — ${instance.appUrl}/api/health ok (version ${health.version}), /api/ready ok`
  )
}

// ---- secrets ------------------------------------------------------------------------------

async function secretsPhase(flags: Flags): Promise<void> {
  heading(`secrets${flags.dryRun ? ' --dry-run' : ''}`)
  const instance = requireInstance()
  await ensureRendered()
  const existing = await listWorkerSecrets()
  const pluginSecrets = pluginDeclarations(installedPluginResources())
    .vars.filter(v => v.secret)
    .map(v => v.key)
  const names = new Set(
    ['OAUTH_ENCRYPTION_KEY', ...OPTIONAL_WORKER_SECRETS, ...pluginSecrets].filter(n => token(n))
  )
  const plan = planSecrets({
    available: names,
    existing,
    optional: OPTIONAL_WORKER_SECRETS,
    pluginSecrets,
    rotate: flags.rotate,
    needsDatabaseUrl: true,
  })
  for (const l of describeSecretPlan(plan, existing)) log(l)
  if (flags.dryRun) {
    const doing = plan.actions.filter(a => a.action !== 'skip').map(a => a.name)
    verifyLine(
      `secrets --dry-run — would set ${doing.length}: ${doing.join(', ')}; nothing was put`
    )
    if (plan.refuse) process.exitCode = 2
    return
  }
  if (plan.refuse) throw new ProvisionError(`secrets: ${plan.refuse}`, 2)

  const set: string[] = []
  for (const a of plan.actions) {
    if (a.action === 'skip') continue
    let value: string
    if (a.action === 'generate') {
      if (existing.includes(a.name))
        warn(
          'rotating OAUTH_ENCRYPTION_KEY: every sealed credential and OAuth token must be re-sealed — run `pnpm provision setup --rotate` next'
        )
      value = generateHexKey()
      // Written back BEFORE the put: a key on the Worker that is in no file is a key nobody has.
      writeDeployFileValue(a.name, value)
      log(`  ${a.name}: generated and written to ${TOKEN_FILE_LABEL} — back that file up`)
    } else if (a.name === 'BOOTSTRAP_ADMIN_EMAILS') value = instance.adminEmails.join(',')
    else if (a.name === 'DATABASE_URL')
      value = toPooledNeonUrl((await resolveNeon(flags, { quiet: true })).url)
    else value = token(a.name) as string
    await putWorkerSecret(a.name, value)
    set.push(a.name)
  }
  const after = await listWorkerSecrets()
  const missing = set.filter(n => !after.includes(n))
  if (missing.length)
    throw new ProvisionError(`secrets: not listed after put: ${missing.join(', ')}`)
  verifyLine(
    `secrets ok — set ${set.length}; wrangler secret list shows ${after.length}: ${after.sort().join(', ')}`
  )
}

// ---- setup --------------------------------------------------------------------------------

async function setupPhase(flags: Flags): Promise<void> {
  heading('setup')
  const instance = requireInstance()
  const key = requireToken('OAUTH_ENCRYPTION_KEY')
  const info = await resolveNeon(flags, { quiet: true })
  const state = readState()
  const template = fs.readFileSync(TEMPLATE_TOML, 'utf8')
  const appName = readTomlString(template, 'APP_NAME') ?? 'Launch'
  const cfg = loadConfig({
    APP_ENV: 'production',
    APP_URL: instance.appUrl,
    APP_NAME: appName,
    TENANCY_MODE: 'single',
    OAUTH_ENCRYPTION_KEY: key,
  } as unknown as Cloudflare.Env)
  const account = accountId()
  if (!account)
    throw new ProvisionError(
      'no Cloudflare account id yet — run `pnpm provision cloudflare` first',
      2
    )

  const credentials: Parameters<typeof writeInstanceSetup>[2]['credentials'] = {
    cloudflare_api_token: { apiToken: requireToken('CLOUDFLARE_API_TOKEN') },
    neon_org_api_key: { apiKey: requireToken('NEON_API_KEY') },
  }
  if (!flags.skipEmail) credentials.resend_api_key = { apiKey: requireToken('RESEND_API_KEY') }
  const appId = token('GITHUB_APP_ID')
  const privateKey = readGitHubAppKey()
  if (appId && privateKey) credentials.github_app = { appId, privateKey }
  else
    warn(
      'no GitHub App in the instance file — github_app is not written (run `pnpm provision github-app`, then `setup` again)'
    )
  const anthropic = token('ANTHROPIC_API_KEY')
  if (anthropic) credentials.anthropic_api_key = { apiKey: anthropic }
  const openai = token('OPENAI_API_KEY')
  if (openai) credentials.openai_api_key = { apiKey: openai }

  const db = getScriptDatabase(info.url, process.env)
  try {
    const result = await writeInstanceSetup(db, cfg, {
      settings: {
        apps_domain: instance.domain,
        cloudflare_account_id: account,
        ...(state.neon?.orgId ? { neon_org_id: state.neon.orgId } : {}),
        neon_region_id: instance.neonRegion,
        notifications_domain: instance.emailDomain,
        github_org: instance.githubOrg,
      },
      credentials,
      tenantName: appName,
      ownerEmail: instance.adminEmails[0] as string,
      force: flags.rotate,
    })
    if (result.tenantCreated)
      log(
        `  organisation "${appName}" created with ${instance.adminEmails[0]} as its owner (they sign in to claim it)`
      )
    log(`  settings changed: ${result.settingsChanged.join(', ') || 'none'}`)
    for (const [kind, outcome] of Object.entries(result.credentials))
      log(`  ${kind.padEnd(22)} ${outcome}`)
    verifyLine(
      `setup ok — ${Object.keys(result.credentials).length} credential(s) sealed with the instance key (${Object.entries(
        result.credentials
      )
        .map(([k, o]) => `${k} ${o}`)
        .join(
          ', '
        )}), ${result.settingsChanged.length} setting(s) changed, audited in organisation ${result.tenantId}`
    )
  } finally {
    await closeAllDatabases()
  }
}

// ---- github (CI later) --------------------------------------------------------------------

function repoSlug(): string {
  const remote = capture('git', ['remote', 'get-url', 'origin'], ROOT_DIR) ?? ''
  const m = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(remote)
  if (!m) throw new ProvisionError(`origin "${remote}" is not a GitHub remote`)
  return `${m[1]}/${m[2]}`
}

async function githubPhase(environment: string, flags: Flags): Promise<void> {
  heading(`github ${environment}`)
  const info = await resolveNeon(flags, { quiet: true })
  const repo = repoSlug()
  await run('gh', ['api', '-X', 'PUT', `repos/${repo}/environments/${environment}`, '--silent'], {
    cwd: ROOT_DIR,
    echo: false,
  })
  const secrets: Record<string, string> = {
    DATABASE_URL: info.url,
    CLOUDFLARE_API_TOKEN: requireToken('CLOUDFLARE_API_TOKEN'),
    CLOUDFLARE_ACCOUNT_ID: accountId() ?? '',
  }
  for (const [name, value] of Object.entries(secrets)) {
    if (!value) continue
    await run('gh', ['secret', 'set', name, '-e', environment, '-R', repo], {
      cwd: ROOT_DIR,
      stdin: value,
      echo: false,
    })
    log(`  set ${name}`)
  }
  verifyLine(
    `github ${environment} ok — environment ${environment} on ${repo} has ${Object.keys(secrets).join(', ')}`
  )
}

// ---- all ----------------------------------------------------------------------------------

function closeOut(flags: Flags): void {
  const instance = requireInstance()
  console.log(`
== close-out
1. Sign in: open ${instance.appUrl}/login and request a magic link for ${instance.adminEmails[0]}.
   ${flags.skipEmail ? 'Email is skipped: copy the link from `pnpm --filter @launch/web exec wrangler tail -c wrangler.deploy.toml`.' : `It arrives from ${instance.emailDomain}.`}
   You are the organisation's owner and the platform admin.
2. Setup (${instance.appUrl}/settings/platform/setup): press Check on every card (Cloudflare, Neon,
   Resend, GitHub App), run the Public URL check, pin the kit version, and turn on Coding agents.
3. Back up ${TOKEN_FILE_LABEL} and .launch/ (password manager or encrypted storage): the file holds
   OAUTH_ENCRYPTION_KEY, which unseals every credential; losing it means rotating them all.
4. CLI: pnpm cli login --server ${instance.appUrl}
5. To update the instance later: pull, then \`pnpm provision all\` again.`)
}

async function allPhase(flags: Flags): Promise<void> {
  type Step = [string, () => Promise<void>]
  const steps: Step[] = [
    ['check', () => checkPhase(flags)],
    ...(token('GITHUB_APP_ID') ? [] : ([['github-app', () => githubAppPhase(flags)]] as Step[])),
    ...(flags.skipEmail ? [] : ([['email create', () => emailCreate()]] as Step[])),
    ['neon', () => neonPhase(flags)],
    ['cloudflare', () => cloudflarePhase()],
    ['migrate', () => migratePhase(flags)],
    ['route', () => routePhase()],
    ['render', () => renderPhase()],
    ['deploy', () => deployPhase(flags)],
    ['secrets', () => secretsPhase({ ...flags, dryRun: false })],
    ['setup', () => setupPhase(flags)],
    ...(flags.skipEmail ? [] : ([['email verify', () => emailVerify(flags)]] as Step[])),
  ]
  for (const [name, fn] of steps) {
    try {
      await fn()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new ProvisionError(
        `phase "${name}" failed: ${msg}\n→ fix the cause and rerun \`pnpm provision ${name}\` (then \`pnpm provision all\` continues idempotently)`,
        err instanceof ProvisionError ? err.exitCode : 1
      )
    }
  }
  closeOut(flags)
  verifyLine(`all ok — ${steps.length} phases passed; ${requireInstance().appUrl} is live`)
}

// ---- main ---------------------------------------------------------------------------------

async function main(argv: string[]): Promise<void> {
  const { positional, flags } = parseArgs(argv)
  const [phase, a] = positional
  if (flags.help || !phase) {
    console.log(USAGE)
    if (!phase && !flags.help) process.exitCode = 2
    return
  }
  if (phase !== 'check' && phase !== 'preflight' && fs.existsSync(LEGACY_TOKEN_FILE))
    warn(
      `apps/web/.provision.env is no longer read — move its values into ${TOKEN_FILE_LABEL} and delete it`
    )
  switch (phase) {
    case 'check':
    case 'preflight':
      return checkPhase(flags)
    case 'github-app':
      return githubAppPhase(flags)
    case 'tokens':
      return tokensPhase(flags)
    case 'email': {
      if (a === 'create') return emailCreate()
      if (a === 'status') return emailStatus()
      if (a === 'verify') return emailVerify(flags)
      throw new ProvisionError('email needs create | status | verify', 2)
    }
    case 'neon':
      return neonPhase(flags)
    case 'cloudflare':
      return cloudflarePhase()
    case 'migrate':
      return migratePhase(flags)
    case 'route':
    case 'urls':
      return routePhase()
    case 'render':
      return renderPhase()
    case 'deploy':
      return deployPhase(flags)
    case 'secrets':
      return secretsPhase(flags)
    case 'setup':
      return setupPhase(flags)
    case 'github':
      return githubPhase(a ?? 'production', flags)
    case 'all':
      return allPhase(flags)
    default:
      throw new ProvisionError(`unknown phase "${phase}"\n${USAGE}`, 2)
  }
}

main(process.argv.slice(2)).catch(err => {
  const code = err instanceof ProvisionError ? err.exitCode : 1
  console.error(redact(`\nerror: ${err instanceof Error ? err.message : String(err)}`))
  process.exitCode = code
})
