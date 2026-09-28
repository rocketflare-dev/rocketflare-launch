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
 * - `POST /zones/{id}/dns_records {type, name, content, proxied, comment}` → the record; `name`
 *   is relative to the zone (`*` is the wildcard). The setup check creates the apps domain's
 *   proxied `AAAA * → 100::` with it when the zone has no `*` record at all (spike S2's
 *   `ensureWildcard`); it needs DNS Edit on the zone.
 * - `GET /zones/{id}/workers/routes` → `result: [{ id, pattern, script }]` (S2).
 *
 * The writes P2 adds (checked against the same reference and spikes S1/S2/S5):
 *
 * - KV `POST …/storage/kv/namespaces {title}` → `{ id, title }`; a duplicate title is an error, so
 *   a retry looks the title up (`findKvByTitle`) before adopting it.
 * - Queues `POST …/queues {queue_name}` → `{ queue_id, queue_name }`; consumers live under
 *   `…/queues/{queue_id}/consumers` (`consumer_id`) — the Versions API never creates them.
 * - R2 `POST …/r2/buckets {name}`; a bucket must be EMPTY to delete, so teardown lists and deletes
 *   its objects first (`…/r2/buckets/{name}/objects`, cursor-paged).
 * - Scripts: `PUT …/workers/scripts/{name}` is multipart — a `metadata` JSON part (main module,
 *   compatibility, bindings, and the DO `migrations` the Versions API cannot apply) plus one part
 *   per module. `DELETE …?force=true` also removes a script other things still bind.
 *   `…/subdomain {enabled}` turns `workers.dev` off; `…/secrets` PUTs one `secret_text`.
 * - Workflows `PUT /accounts/{a}/workflows/{name} {class_name, script_name}` registers one against
 *   a script — `wrangler deploy` does it implicitly, a version upload does not.
 * - Routes `POST /zones/{z}/workers/routes {pattern, script}` → `{ id }`.
 * - Deploys (DEPLOYER.md): `…/assets-upload-session {manifest}` → `{ jwt, buckets }`, each bucket
 *   POSTed to `…/workers/assets/upload?base64=true` under the SESSION jwt (the last answer carries
 *   the completion jwt); `…/versions` (multipart, like a script) → `{ id }`; `…/deployments
 *   {strategy:'percentage', versions:[…100]}`; `PUT …/schedules [{cron}]`; `PATCH
 *   …/script-settings` (JSON).
 */

export const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4'
const TIMEOUT_MS = 10_000
/** A script, version or asset upload carries a whole build; give it longer than a JSON call. */
const UPLOAD_TIMEOUT_MS = 120_000

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
  result_info?: { cursor?: string; is_truncated?: boolean; page?: number; total_pages?: number }
}

/** True for a Cloudflare 404 — what teardown counts as "already gone". */
export function isCloudflareNotFound(err: unknown): boolean {
  return err instanceof CloudflareApiError && err.status === 404
}

export interface CloudflareKvNamespace {
  id: string
  title: string
}

export interface CloudflareQueue {
  queue_id: string
  queue_name: string
}

export interface CloudflareQueueConsumerSettings {
  batch_size?: number
  max_retries?: number
  max_wait_time_ms?: number
  retry_delay?: number
}

export interface CloudflareQueueConsumer {
  consumer_id: string
  script_name?: string
  script?: string
  type?: string
  settings?: CloudflareQueueConsumerSettings
  dead_letter_queue?: string
}

export interface CloudflareR2Bucket {
  name: string
  location?: string
  creation_date?: string
}

/** One Worker module part: its path (the part name) and bytes, typed by extension (DEPLOYER.md). */
export interface WorkerModule {
  name: string
  content: string | Uint8Array
  /** Overrides the type the extension implies. */
  contentType?: string
}

/**
 * A script's or version's `metadata` part. Bindings are Cloudflare's own shapes
 * (`{ type: 'kv_namespace', name, namespace_id }` …), passed through untouched.
 */
export interface WorkerMetadata {
  main_module: string
  compatibility_date?: string
  compatibility_flags?: string[]
  bindings?: Record<string, unknown>[]
  /** `secret_text` keeps the Worker's secrets across a code upload. */
  keep_bindings?: string[]
  /** Durable Object migrations: `{ new_tag, old_tag?, steps: [{ new_classes|new_sqlite_classes… }] }`. */
  migrations?: Record<string, unknown>
  annotations?: Record<string, string>
  assets?: { jwt: string; config?: Record<string, unknown> }
  observability?: Record<string, unknown>
  [key: string]: unknown
}

export interface CloudflareScript {
  id: string
  etag?: string
  created_on?: string
  modified_on?: string
}

export interface CloudflareWorkflow {
  id?: string
  name: string
  class_name?: string
  script_name?: string
}

export interface CloudflareVersion {
  id: string
  number?: number
  metadata?: Record<string, unknown>
}

export interface CloudflareDeployment {
  id: string
  versions?: { version_id: string; percentage: number }[]
}

/** `assets-upload-session`: the files Cloudflare lacks, grouped into buckets, and the session jwt. */
export interface CloudflareAssetsSession {
  jwt: string
  buckets?: string[][]
}

/** One asset in an upload manifest: its `/`-rooted path → content hash (32 hex) and byte size. */
export type AssetsManifest = Record<string, { hash: string; size: number }>

/** One file in an asset bucket upload: the manifest hash, its base64 body and its media type. */
export interface AssetUploadFile {
  hash: string
  base64: string
  contentType: string
}

interface RequestInit_ {
  json?: unknown
  form?: FormData
  /** Authenticate with this bearer instead of the token (the assets upload's session jwt). */
  bearer?: string
  timeoutMs?: number
}

/** The media type of a Worker module part, by extension (wrangler's default module rules). */
export function workerModuleType(name: string): string {
  if (/\.(m?js)$/.test(name)) return 'application/javascript+module'
  if (name.endsWith('.cjs')) return 'application/javascript'
  if (name.endsWith('.wasm')) return 'application/wasm'
  if (/\.(txt|html|sql)$/.test(name)) return 'text/plain'
  return 'application/octet-stream'
}

function workerForm(metadata: WorkerMetadata, modules: readonly WorkerModule[]): FormData {
  const form = new FormData()
  form.append(
    'metadata',
    new Blob([JSON.stringify(metadata)], { type: 'application/json' }),
    'metadata.json'
  )
  for (const mod of modules) {
    const type = mod.contentType ?? workerModuleType(mod.name)
    form.append(mod.name, new File([mod.content as BlobPart], mod.name, { type }), mod.name)
  }
  return form
}

const enc = encodeURIComponent

/** A client bound to one token. Construct per use; it holds the token only in memory. */
export class CloudflareClient {
  constructor(
    private readonly apiToken: string,
    private readonly opts: CloudflareOptions = {}
  ) {}

  /** The whole envelope, so a list can read `result_info`. Throws on non-2xx or `success: false`. */
  private async request<T>(
    method: string,
    path: string,
    init: RequestInit_ = {}
  ): Promise<Envelope<T>> {
    const doFetch = this.opts.fetch ?? fetch
    const headers: Record<string, string> = {
      Authorization: `Bearer ${init.bearer ?? this.apiToken}`,
      Accept: 'application/json',
    }
    let body: BodyInit | undefined
    if (init.form) body = init.form
    else if (init.json !== undefined) {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify(init.json)
    }
    const res = await doFetch(`${this.opts.apiBase ?? CLOUDFLARE_API_BASE}${path}`, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(init.timeoutMs ?? TIMEOUT_MS),
    })
    const envelope = (await res.json().catch(() => ({}))) as Envelope<T>
    if (!res.ok || envelope.success === false) {
      const message =
        (envelope.errors ?? [])
          .map(e => [e.code, e.message].filter(Boolean).join(': '))
          .filter(Boolean)
          .join('; ') || `Cloudflare ${res.status}`
      throw new CloudflareApiError(res.status, message, path)
    }
    return envelope
  }

  async get<T>(path: string): Promise<T> {
    return (await this.request<T>('GET', path)).result as T
  }

  private async call<T>(method: string, path: string, init: RequestInit_ = {}): Promise<T> {
    return (await this.request<T>(method, path, init)).result as T
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

  /** Create one DNS record (the setup check's wildcard). A secret never goes in one. */
  createDnsRecord(
    zoneId: string,
    record: { type: string; name: string; content: string; proxied: boolean; comment?: string }
  ): Promise<CloudflareDnsRecord> {
    return this.call('POST', `/zones/${enc(zoneId)}/dns_records`, { json: record })
  }

  listWorkerRoutes(zoneId: string): Promise<CloudflareWorkerRoute[]> {
    return this.get(`/zones/${encodeURIComponent(zoneId)}/workers/routes`)
  }

  // ---- KV (P2) ---------------------------------------------------------------------------------

  createKvNamespace(accountId: string, title: string): Promise<CloudflareKvNamespace> {
    return this.call('POST', `/accounts/${enc(accountId)}/storage/kv/namespaces`, {
      json: { title },
    })
  }

  async deleteKvNamespace(accountId: string, namespaceId: string): Promise<void> {
    await this.call(
      'DELETE',
      `/accounts/${enc(accountId)}/storage/kv/namespaces/${enc(namespaceId)}`
    )
  }

  /** The namespace titled exactly `title`, or null — how a retry adopts one it already made. */
  async findKvByTitle(accountId: string, title: string): Promise<CloudflareKvNamespace | null> {
    for (let page = 1; page <= 50; page++) {
      const envelope = await this.request<CloudflareKvNamespace[]>(
        'GET',
        `/accounts/${enc(accountId)}/storage/kv/namespaces?per_page=100&page=${page}`
      )
      const list = envelope.result ?? []
      const found = list.find(ns => ns.title === title)
      if (found) return found
      const info = envelope.result_info
      if (list.length < 100 || (info?.total_pages !== undefined && page >= info.total_pages)) break
    }
    return null
  }

  // ---- Queues (P2) -----------------------------------------------------------------------------

  createQueue(accountId: string, name: string): Promise<CloudflareQueue> {
    return this.call('POST', `/accounts/${enc(accountId)}/queues`, { json: { queue_name: name } })
  }

  async deleteQueue(accountId: string, queueId: string): Promise<void> {
    await this.call('DELETE', `/accounts/${enc(accountId)}/queues/${enc(queueId)}`)
  }

  listQueueConsumers(accountId: string, queueId: string): Promise<CloudflareQueueConsumer[]> {
    return this.call('GET', `/accounts/${enc(accountId)}/queues/${enc(queueId)}/consumers`)
  }

  /**
   * The Worker `scriptName` as a consumer of the queue — created, or updated in place when that
   * script already consumes it, so a retried step never registers a second consumer.
   */
  async putQueueConsumer(
    accountId: string,
    queueId: string,
    consumer: {
      scriptName: string
      settings?: CloudflareQueueConsumerSettings
      deadLetterQueue?: string
    }
  ): Promise<CloudflareQueueConsumer> {
    const body = {
      type: 'worker',
      script_name: consumer.scriptName,
      ...(consumer.settings ? { settings: consumer.settings } : {}),
      ...(consumer.deadLetterQueue ? { dead_letter_queue: consumer.deadLetterQueue } : {}),
    }
    const existing = (await this.listQueueConsumers(accountId, queueId)).find(
      c => (c.script_name ?? c.script) === consumer.scriptName
    )
    const base = `/accounts/${enc(accountId)}/queues/${enc(queueId)}/consumers`
    return existing
      ? this.call('PUT', `${base}/${enc(existing.consumer_id)}`, { json: body })
      : this.call('POST', base, { json: body })
  }

  async deleteQueueConsumer(accountId: string, queueId: string, consumerId: string): Promise<void> {
    await this.call(
      'DELETE',
      `/accounts/${enc(accountId)}/queues/${enc(queueId)}/consumers/${enc(consumerId)}`
    )
  }

  // ---- R2 (P2) ---------------------------------------------------------------------------------

  createR2Bucket(accountId: string, name: string): Promise<CloudflareR2Bucket> {
    return this.call('POST', `/accounts/${enc(accountId)}/r2/buckets`, { json: { name } })
  }

  /**
   * Delete every object, then the bucket (Cloudflare refuses a non-empty one). Returns how many
   * objects went. A missing bucket throws the 404 — the caller decides that means "done".
   */
  async emptyAndDeleteR2Bucket(
    accountId: string,
    name: string
  ): Promise<{ deletedObjects: number }> {
    const base = `/accounts/${enc(accountId)}/r2/buckets/${enc(name)}`
    let deletedObjects = 0
    for (let round = 0; round < 1000; round++) {
      const envelope = await this.request<{ key: string }[]>('GET', `${base}/objects?per_page=1000`)
      const keys = (envelope.result ?? []).map(o => o.key)
      if (keys.length === 0) break
      for (const key of keys) {
        await this.call('DELETE', `${base}/objects/${key.split('/').map(enc).join('/')}`)
        deletedObjects++
      }
    }
    await this.call('DELETE', base)
    return { deletedObjects }
  }

  // ---- Scripts (P2) ----------------------------------------------------------------------------

  /**
   * Create or replace a Worker script (multipart). This — not a version upload — is what applies
   * the toml's Durable Object `migrations`, which is why the pipeline's placeholder uses it.
   */
  putWorkerScript(
    accountId: string,
    scriptName: string,
    metadata: WorkerMetadata,
    modules: readonly WorkerModule[]
  ): Promise<CloudflareScript> {
    return this.call('PUT', `/accounts/${enc(accountId)}/workers/scripts/${enc(scriptName)}`, {
      form: workerForm(metadata, modules),
      timeoutMs: UPLOAD_TIMEOUT_MS,
    })
  }

  /** `force` also deletes a script that other Workers or consumers still reference. */
  async deleteWorkerScript(accountId: string, scriptName: string, force = true): Promise<void> {
    await this.call(
      'DELETE',
      `/accounts/${enc(accountId)}/workers/scripts/${enc(scriptName)}${force ? '?force=true' : ''}`
    )
  }

  /** Turn the script's `workers.dev` route (and its previews) on or off. */
  async setWorkersDevSubdomain(
    accountId: string,
    scriptName: string,
    enabled: boolean
  ): Promise<void> {
    await this.call(
      'POST',
      `/accounts/${enc(accountId)}/workers/scripts/${enc(scriptName)}/subdomain`,
      { json: { enabled, previews_enabled: enabled } }
    )
  }

  /** Set one `secret_text` on the script. The value goes to Cloudflare and nowhere else. */
  async putWorkerSecret(
    accountId: string,
    scriptName: string,
    name: string,
    value: string
  ): Promise<void> {
    await this.call(
      'PUT',
      `/accounts/${enc(accountId)}/workers/scripts/${enc(scriptName)}/secrets`,
      {
        json: { name, text: value, type: 'secret_text' },
      }
    )
  }

  // ---- Workflows and routes (P2) ---------------------------------------------------------------

  /** Register (or re-point) a Workflow name at a class in a script. */
  putWorkflow(
    accountId: string,
    workflowName: string,
    target: { scriptName: string; className: string }
  ): Promise<CloudflareWorkflow> {
    return this.call('PUT', `/accounts/${enc(accountId)}/workflows/${enc(workflowName)}`, {
      json: { class_name: target.className, script_name: target.scriptName },
    })
  }

  async deleteWorkflow(accountId: string, workflowName: string): Promise<void> {
    await this.call('DELETE', `/accounts/${enc(accountId)}/workflows/${enc(workflowName)}`)
  }

  createWorkerRoute(zoneId: string, pattern: string, scriptName: string): Promise<{ id: string }> {
    return this.call('POST', `/zones/${enc(zoneId)}/workers/routes`, {
      json: { pattern, script: scriptName },
    })
  }

  async deleteWorkerRoute(zoneId: string, routeId: string): Promise<void> {
    await this.call('DELETE', `/zones/${enc(zoneId)}/workers/routes/${enc(routeId)}`)
  }

  // ---- Deploys (P2, the deployer gateway) ------------------------------------------------------

  /** Open a static-assets upload for `scriptName`: which hashes to send, and the session jwt. */
  assetsUploadSession(
    accountId: string,
    scriptName: string,
    manifest: AssetsManifest
  ): Promise<CloudflareAssetsSession> {
    return this.call(
      'POST',
      `/accounts/${enc(accountId)}/workers/scripts/${enc(scriptName)}/assets-upload-session`,
      { json: { manifest } }
    )
  }

  /**
   * Upload one bucket of assets under the session `jwt` (NOT the API token). Returns the
   * completion jwt when Cloudflare answers with one — the last bucket's is what a version binds.
   */
  async uploadAssetBucket(
    accountId: string,
    jwt: string,
    files: readonly AssetUploadFile[]
  ): Promise<{ jwt: string | null }> {
    const form = new FormData()
    for (const f of files) {
      form.append(f.hash, new File([f.base64], f.hash, { type: f.contentType }), f.hash)
    }
    const result = await this.call<{ jwt?: string } | null>(
      'POST',
      `/accounts/${enc(accountId)}/workers/assets/upload?base64=true`,
      { form, bearer: jwt, timeoutMs: UPLOAD_TIMEOUT_MS }
    )
    return { jwt: result?.jwt ?? null }
  }

  /** Upload an UNDEPLOYED version (multipart, like a script). Nothing serves it until deployed. */
  createVersion(
    accountId: string,
    scriptName: string,
    metadata: WorkerMetadata,
    modules: readonly WorkerModule[]
  ): Promise<CloudflareVersion> {
    return this.call(
      'POST',
      `/accounts/${enc(accountId)}/workers/scripts/${enc(scriptName)}/versions`,
      { form: workerForm(metadata, modules), timeoutMs: UPLOAD_TIMEOUT_MS }
    )
  }

  /** Make `versionId` live at 100%. */
  createDeployment(
    accountId: string,
    scriptName: string,
    versionId: string,
    message?: string
  ): Promise<CloudflareDeployment> {
    return this.call(
      'POST',
      `/accounts/${enc(accountId)}/workers/scripts/${enc(scriptName)}/deployments`,
      {
        json: {
          strategy: 'percentage',
          versions: [{ version_id: versionId, percentage: 100 }],
          ...(message ? { annotations: { 'workers/message': message } } : {}),
        },
      }
    )
  }

  /** Replace the script's cron triggers (`[]` clears them). */
  putSchedules(
    accountId: string,
    scriptName: string,
    crons: readonly string[]
  ): Promise<{ schedules: { cron: string }[] }> {
    return this.call(
      'PUT',
      `/accounts/${enc(accountId)}/workers/scripts/${enc(scriptName)}/schedules`,
      { json: crons.map(cron => ({ cron })) }
    )
  }

  /** Script-level settings that are not part of a version (observability, logpush, tail). */
  patchScriptSettings(
    accountId: string,
    scriptName: string,
    settings: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return this.call(
      'PATCH',
      `/accounts/${enc(accountId)}/workers/scripts/${enc(scriptName)}/script-settings`,
      { json: settings }
    )
  }
}
