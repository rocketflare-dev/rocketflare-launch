/**
 * Cloudflare v4 API over plain `fetch` — the few calls wrangler has no command for. Facts
 * verified against https://developers.cloudflare.com/api/ on 2026-09-02:
 *   - `Authorization: Bearer <token>`; envelope `{ success, errors[], messages[], result }`
 *   - `GET /zones?name=<zone>&per_page=50` → `result: [{ id, name, status }]`
 *     (…/resources/zones/methods/list/); a token without a Zone scope gets `result: []`, not an
 *     error, so "no zone" and "no zone permission" look alike — `hasAnyZone()` tells them apart
 *   - `GET /zones/{zone}/dns_records?per_page=1` is the cheapest proof the token can READ DNS in
 *     that zone (`assertDnsRead`); `Zone: DNS — Edit` is what the kit asks for, which implies it
 *   - `GET /zones/{zone}/dns_records?name=&type=&per_page=` and `POST /zones/{zone}/dns_records
 *     { type, name, content, ttl (1 = automatic), proxied, priority (MX), comment }` → `result.id`
 *     (…/resources/dns/subresources/records/methods/create/); `PUT …/dns_records/{id}` overwrites
 *     a record with the same body (…/resources/dns/subresources/records/methods/update/ — "Overwrite
 *     DNS Record")
 *   - `GET /accounts/{account}/workers/subdomain` → `result: { subdomain }`, Workers Scripts Read
 *     (…/resources/workers/subresources/subdomains/methods/get/)
 */
import { ProvisionError } from './config'
import { redact } from './redact'
import type { DnsRecordInput } from './resend'

export const CF_API = 'https://api.cloudflare.com/client/v4'

export interface DnsRecord extends DnsRecordInput {
  id: string
}

type Fetch = typeof fetch

export class CloudflareClient {
  constructor(
    private readonly apiToken: string,
    private readonly fetchImpl: Fetch = fetch
  ) {}

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${CF_API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    const json: any = await res.json().catch(() => ({}))
    if (!res.ok || json.success === false) {
      const errors = (json.errors ?? []).map((e: any) => `${e.code}: ${e.message}`).join('; ')
      throw new ProvisionError(
        `Cloudflare ${method} ${path} → ${res.status} ${redact(errors || JSON.stringify(json)).slice(0, 400)}`
      )
    }
    return json.result as T
  }

  async findZone(name: string) {
    const zones = await this.request<{ id: string; name: string; status: string }[]>(
      'GET',
      `/zones?name=${encodeURIComponent(name)}&per_page=50`
    )
    return zones.find(z => z.name === name)
  }

  /** First candidate (most specific first) that is a zone in this account. */
  async findZoneFor(candidates: string[]) {
    for (const c of candidates) {
      const z = await this.findZone(c)
      if (z) return z
    }
    return undefined
  }

  /** Whether the token sees ANY zone in the account — false means the token lacks a Zone scope. */
  async hasAnyZone(): Promise<boolean> {
    const zones = await this.request<{ id: string }[]>('GET', '/zones?per_page=1')
    return zones.length > 0
  }

  /** Throws with the fix when the token cannot read DNS records in the zone (its own message, not the hint for a missing zone). */
  async assertDnsRead(zone: { id: string; name: string }): Promise<void> {
    try {
      await this.request('GET', `/zones/${zone.id}/dns_records?per_page=1`)
    } catch (err) {
      throw new ProvisionError(
        `the token cannot read DNS records in zone ${zone.name} (${zone.id}) — give CLOUDFLARE_API_TOKEN \`Zone: DNS — Edit\` on that zone (${err instanceof Error ? err.message : String(err)})`
      )
    }
  }

  listRecords(zoneId: string, name: string, type?: string) {
    const q = `name=${encodeURIComponent(name)}${type ? `&type=${type}` : ''}&per_page=100`
    return this.request<DnsRecord[]>('GET', `/zones/${zoneId}/dns_records?${q}`)
  }

  /**
   * Find-or-create by (name, type[, content for multi-value types]). TXT and MX may legitimately
   * hold several records at one name (SPF + DKIM), so those match on content too; CNAME is
   * single-valued and is overwritten when its target differs.
   */
  async upsertRecord(
    zoneId: string,
    rec: DnsRecordInput
  ): Promise<'exists' | 'created' | 'updated'> {
    const existing = await this.listRecords(zoneId, rec.name, rec.type)
    const same = existing.find(r => normalise(r.content) === normalise(rec.content))
    if (same) return 'exists'
    if (rec.type === 'CNAME' && existing[0]) {
      await this.request('PUT', `/zones/${zoneId}/dns_records/${existing[0].id}`, withComment(rec))
      return 'updated'
    }
    await this.request('POST', `/zones/${zoneId}/dns_records`, withComment(rec))
    return 'created'
  }

  // ---- the instance flow (`check`, `cloudflare`, `route`) ----------------------------------

  /** The accounts the token can see (an account-owned token sees its one account). */
  listAccounts() {
    return this.request<{ id: string; name: string }[]>('GET', '/accounts?per_page=50')
  }

  /** `/accounts/{id}/tokens/verify` — what Launch's own Setup check calls; refuses a user token. */
  verifyAccountToken(accountId: string) {
    return this.request<{ id: string; status: string }>(
      'GET',
      `/accounts/${accountId}/tokens/verify`
    )
  }

  /** The zone named exactly `name`, with the account it belongs to. */
  async findZoneWithAccount(name: string) {
    const zones = await this.request<
      { id: string; name: string; status: string; account?: { id: string; name?: string } }[]
    >('GET', `/zones?name=${encodeURIComponent(name)}&per_page=50`)
    return zones.find(z => z.name === name)
  }

  /** Every DNS record in the zone (paged by 500 — the zone audit reads them all). */
  async listAllRecords(zoneId: string): Promise<DnsRecord[]> {
    const out: DnsRecord[] = []
    for (let page = 1; page <= 20; page++) {
      const batch = await this.request<DnsRecord[]>(
        'GET',
        `/zones/${zoneId}/dns_records?per_page=500&page=${page}`
      )
      out.push(...batch)
      if (batch.length < 500) break
    }
    return out
  }

  /** Worker custom domains attached in the zone (`GET /accounts/{a}/workers/domains?zone_id=`). */
  listWorkerDomains(accountId: string, zoneId: string) {
    return this.request<{ hostname: string; service: string }[]>(
      'GET',
      `/accounts/${accountId}/workers/domains?zone_id=${zoneId}`
    )
  }

  listWorkerRoutes(zoneId: string) {
    return this.request<{ id: string; pattern: string; script?: string }[]>(
      'GET',
      `/zones/${zoneId}/workers/routes`
    )
  }

  /** Create one record exactly as given (the wildcard — `upsertRecord` is for Resend's). */
  createRecord(zoneId: string, rec: DnsRecordInput & { proxied?: boolean; comment?: string }) {
    return this.request<DnsRecord>('POST', `/zones/${zoneId}/dns_records`, rec)
  }

  // ---- account resources, find-or-create by name (the `cloudflare` phase) ------------------

  /** KV namespace titled `title` (or wrangler's older `<worker>-<title>`), else created. */
  async ensureKv(accountId: string, title: string): Promise<{ id: string; created: boolean }> {
    for (let page = 1; page <= 50; page++) {
      const list = await this.request<{ id: string; title: string }[]>(
        'GET',
        `/accounts/${accountId}/storage/kv/namespaces?per_page=100&page=${page}`
      )
      const hit = list.find(n => n.title === title) ?? list.find(n => n.title.endsWith(`-${title}`))
      if (hit) return { id: hit.id, created: false }
      if (list.length < 100) break
    }
    const made = await this.request<{ id: string }>(
      'POST',
      `/accounts/${accountId}/storage/kv/namespaces`,
      { title }
    )
    return { id: made.id, created: true }
  }

  async ensureQueue(accountId: string, name: string): Promise<{ created: boolean }> {
    for (let page = 1; page <= 50; page++) {
      const list = await this.request<{ queue_name: string }[]>(
        'GET',
        `/accounts/${accountId}/queues?per_page=100&page=${page}`
      )
      if (list.some(q => q.queue_name === name)) return { created: false }
      if (list.length < 100) break
    }
    await this.request('POST', `/accounts/${accountId}/queues`, { queue_name: name })
    return { created: true }
  }

  async ensureR2Bucket(accountId: string, name: string): Promise<{ created: boolean }> {
    try {
      await this.request('GET', `/accounts/${accountId}/r2/buckets/${name}`)
      return { created: false }
    } catch (err) {
      if (!/→ 404/.test(err instanceof Error ? err.message : '')) throw err
    }
    await this.request('POST', `/accounts/${accountId}/r2/buckets`, { name })
    return { created: true }
  }

  async workersSubdomain(accountId: string): Promise<string> {
    const r = await this.request<{ subdomain?: string }>(
      'GET',
      `/accounts/${accountId}/workers/subdomain`
    )
    if (!r?.subdomain)
      throw new ProvisionError(
        'the account has no workers.dev subdomain yet — pick one in the dashboard (Workers & Pages → Overview) or pass a custom host'
      )
    return r.subdomain
  }
}

const withComment = (rec: DnsRecordInput) => ({ ...rec, comment: 'launch provision: Resend' })
const normalise = (v: string) => v.trim().replace(/^"|"$/g, '').replace(/\.$/, '').toLowerCase()

// ---- pure helpers (tests/config/provision-zone.test.ts) ----------------------------------

export const WORKERS_DEV = 'workers.dev'

/**
 * The names preflight must resolve to a zone in the account: every custom host (anything but the
 * literal `workers.dev`) and the sending domain unless email is skipped. Lower-cased, deduplicated,
 * hosts first.
 */
export function hostsNeedingZone(
  answers: { hosts: Record<string, string>; domain?: string },
  skipEmail: boolean
): string[] {
  const out: string[] = []
  const add = (v: string | undefined) => {
    const name = v?.trim().toLowerCase().replace(/\.$/, '')
    if (name && name !== WORKERS_DEV && !out.includes(name)) out.push(name)
  }
  for (const host of Object.values(answers.hosts)) add(host)
  if (!skipEmail) add(answers.domain)
  return out
}

/** What `route` creates when the zone has no `*` record at all (spike S2, as Setup's check does). */
export const WILDCARD_RECORD = { type: 'AAAA', name: '*', content: '100::', proxied: true } as const

/**
 * The zone audit: every PROXIED hostname in the zone that Launch's `*.<domain>/*` route would
 * capture — a subdomain (the apex is not matched by `*.`), not the wildcard itself, not Launch's
 * own host, and not served by a Worker custom domain (a custom domain wins over a route). Each one
 * is a site that stops reaching its origin the moment the instance deploys.
 */
export function zoneAuditFindings(input: {
  domain: string
  host: string
  records: ReadonlyArray<{ name: string; type: string; proxied?: boolean }>
  customDomains: ReadonlyArray<{ hostname: string; service?: string }>
}): { captured: string[]; hostTaken?: string } {
  const domain = input.domain.toLowerCase()
  const covered = new Set(input.customDomains.map(d => d.hostname.toLowerCase()))
  const captured = new Set<string>()
  let hostTaken: string | undefined
  for (const r of input.records) {
    const name = r.name.toLowerCase()
    if (name === input.host.toLowerCase() && !covered.has(name)) hostTaken = `${r.type} ${name}`
    if (!r.proxied) continue
    if (name === domain || name === `*.${domain}` || !name.endsWith(`.${domain}`)) continue
    if (name === input.host.toLowerCase() || covered.has(name)) continue
    captured.add(name)
  }
  return { captured: [...captured].sort(), ...(hostTaken ? { hostTaken } : {}) }
}

/** The one sentence a person sees when a host or sending domain is not a zone in the account. */
export const missingZoneHint = (apex: string): string =>
  `the domain ${apex} is not on this Cloudflare account. Add it first — register it at https://dash.cloudflare.com/?to=/:account/domains/register or add the site and move its nameservers (https://dash.cloudflare.com/?to=/:account/add-site) — or use workers.dev for the hosts and --skip-email.`
