/**
 * The Cloudflare v4 API client Launch acts with (spec/03, spec/04) — Worker-safe (plain `fetch`, no
 * wrangler, no Node) and every call takes an injected `fetch` so no test reaches Cloudflare.
 * `apps/web/scripts/provision/cloudflare-dns.ts` is the Node-side sibling; it is a reference, never
 * an import.
 *
 * API facts this module relies on (developers.cloudflare.com/api, checked 2026-09-27):
 *
 * - `Authorization: Bearer <token>`; every response is `{ success, errors[], messages[], result }`,
 *   and list endpoints add `result_info`.
 * - Launch's token is **account-owned** (spec/03). Those verify at
 *   `GET /accounts/{account_id}/tokens/verify` → `result: { id, status: active|disabled|expired }`;
 *   `/user/tokens/verify` refuses them.
 * - Read probes: `GET /accounts/{id}/workers/scripts`, `…/storage/kv/namespaces`, `…/queues`,
 *   `…/r2/buckets` (R2 nests its list: `result: { buckets: [] }`) — the S0 limits spike's calls.
 * - `GET /zones?name=<zone>` → `result: [{ id, name, status, account: { id, name } }]`. A token
 *   with no Zone scope gets `[]`, not an error, so "no zone" and "no permission" look alike.
 * - `GET /zones/{id}/dns_records?name=<fqdn>` matches the name exactly, `*.<zone>` included, and
 *   each record carries `proxied`.
 * - `GET /zones/{id}/workers/routes` → `result: [{ id, pattern, script }]` (S2).
 */

export const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4'
const TIMEOUT_MS = 10_000

export interface CloudflareOptions {
  fetch?: typeof fetch
  /** Override for tests; no trailing slash. */
  apiBase?: string
}

/** A failed Cloudflare call. `message` is Cloudflare's own `errors[].message`, never the token. */
export class CloudflareApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly path: string
  ) {
    super(message)
    this.name = 'CloudflareApiError'
  }
}

export interface CloudflareTokenVerify {
  id: string
  status: 'active' | 'disabled' | 'expired' | string
  expires_on?: string
}

export interface CloudflareZone {
  id: string
  name: string
  status: string
  account: { id: string; name?: string }
}

export interface CloudflareDnsRecord {
  id: string
  type: string
  name: string
  content: string
  proxied?: boolean
}

export interface CloudflareWorkerRoute {
  id: string
  pattern: string
  script?: string
}

interface Envelope<T> {
  success?: boolean
  errors?: { code?: number; message?: string }[]
  result?: T
}

/** A client bound to one token. Construct per use; it holds the token only in memory. */
export class CloudflareClient {
  constructor(
    private readonly apiToken: string,
    private readonly opts: CloudflareOptions = {}
  ) {}

  async get<T>(path: string): Promise<T> {
    const doFetch = this.opts.fetch ?? fetch
    const res = await doFetch(`${this.opts.apiBase ?? CLOUDFLARE_API_BASE}${path}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.apiToken}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const body = (await res.json().catch(() => ({}))) as Envelope<T>
    if (!res.ok || body.success === false) {
      const message =
        (body.errors ?? [])
          .map(e => [e.code, e.message].filter(Boolean).join(': '))
          .filter(Boolean)
          .join('; ') || `Cloudflare ${res.status}`
      throw new CloudflareApiError(res.status, message, path)
    }
    return body.result as T
  }

  verifyAccountToken(accountId: string): Promise<CloudflareTokenVerify> {
    return this.get(`/accounts/${encodeURIComponent(accountId)}/tokens/verify`)
  }

  listWorkerScripts(accountId: string): Promise<{ id: string }[]> {
    return this.get(`/accounts/${encodeURIComponent(accountId)}/workers/scripts`)
  }

  listKvNamespaces(accountId: string): Promise<{ id: string }[]> {
    return this.get(`/accounts/${encodeURIComponent(accountId)}/storage/kv/namespaces?per_page=1`)
  }

  listQueues(accountId: string): Promise<{ queue_id: string }[]> {
    return this.get(`/accounts/${encodeURIComponent(accountId)}/queues?per_page=1`)
  }

  async listR2Buckets(accountId: string): Promise<{ name: string }[]> {
    const result = await this.get<{ buckets?: { name: string }[] }>(
      `/accounts/${encodeURIComponent(accountId)}/r2/buckets?per_page=1`
    )
    return result?.buckets ?? []
  }

  /** The zone named exactly `name`, or null when the token cannot see one. */
  async findZone(name: string): Promise<CloudflareZone | null> {
    const zones = await this.get<CloudflareZone[]>(
      `/zones?name=${encodeURIComponent(name)}&per_page=50`
    )
    return zones.find(z => z.name === name) ?? null
  }

  async listDnsRecords(zoneId: string, name: string): Promise<CloudflareDnsRecord[]> {
    const records = await this.get<CloudflareDnsRecord[]>(
      `/zones/${encodeURIComponent(zoneId)}/dns_records?name=${encodeURIComponent(name)}&per_page=100`
    )
    return records.filter(r => r.name === name)
  }

  listWorkerRoutes(zoneId: string): Promise<CloudflareWorkerRoute[]> {
    return this.get(`/zones/${encodeURIComponent(zoneId)}/workers/routes`)
  }
}
