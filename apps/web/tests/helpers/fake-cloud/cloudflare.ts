/**
 * FakeCloudflare — the v4 API surface Launch touches, stateful. One account (`accountId`) and one
 * zone (`zoneId` / `zoneName`); any other account or zone is a 403 / 404. Every resource is kept
 * by id and a deleted one answers 404, exactly as Cloudflare does. See `index.ts` for the API.
 *
 * Secrets (Launch P5): `PUT …/secrets`, `DELETE …/secrets/{name}` and `GET …/secrets` (names and
 * types only). On a script with a LIVE version, a secret write or delete creates AND deploys a new
 * version carrying the active one's bindings (as Cloudflare does), and a secret whose name is
 * already a `plain_text` / `json` binding of the live version is refused 10053 "Binding name
 * already in use" (`secretNameClash = false` turns that off). Each version snapshots the secret
 * VALUES it carries, so `envOf(script)` answers what the running Worker's `env` would hold.
 */
import {
  belongsTo,
  type FakeRequest,
  type IdSource,
  json,
  type ResourceLabel,
  type VendorHandler,
} from './core'

export interface FakeKvNamespace {
  id: string
  title: string
}

export interface FakeQueueConsumer {
  consumer_id: string
  script_name: string
  type: string
  settings: Record<string, unknown>
  dead_letter_queue?: string
}

export interface FakeQueue {
  queue_id: string
  queue_name: string
  consumers: Map<string, FakeQueueConsumer>
}

export interface FakeR2Bucket {
  name: string
  objects: Map<string, string>
}

export interface FakeVersion {
  id: string
  metadata: Record<string, unknown>
  modules: Record<string, string>
  /** The bindings as uploaded, plus `secret_text` kept from the script when `keep_bindings` says so. */
  bindings: Record<string, unknown>[]
  /** The values of the `secret_text` bindings as of this version (P5 — `envOf` reads them). */
  secrets?: Record<string, string>
  createdAt: Date
}

export interface FakeDeployment {
  id: string
  versions: { version_id: string; percentage: number }[]
  createdAt: Date
}

export interface FakeScript {
  name: string
  /** The metadata of the last `PUT` (the placeholder), or of the version last deployed. */
  metadata: Record<string, unknown>
  modules: Record<string, string>
  /** Secret NAME → value. `secretPuts` / `secretDeletes` record only the names, in order. */
  secrets: Map<string, string>
  secretPuts: string[]
  secretDeletes: string[]
  /** The newest DO migration tag applied by a script PUT (`metadata.migrations.new_tag`). */
  migrationTag: string | null
  workersDev: boolean
  schedules: string[]
  settings: Record<string, unknown>
  versions: FakeVersion[]
  deployments: FakeDeployment[]
  /** The version live at 100%, or null for a script only ever PUT (the placeholder). */
  activeVersionId: string | null
}

export interface FakeWorkflowReg {
  name: string
  class_name: string
  script_name: string
}

export interface FakeRoute {
  id: string
  zoneId: string
  pattern: string
  script: string
}

interface AssetSession {
  scriptName: string
  manifest: Record<string, { hash: string; size: number }>
  pending: Set<string>
}

export interface FakeDnsRecord {
  id: string
  type: string
  name: string
  content: string
  proxied: boolean
}

export interface FakeCloudflareOptions {
  accountId: string
  zoneId: string
  zoneName: string
  /** The token the fake accepts; any bearer is accepted when omitted. */
  apiToken?: string
}

const BASE = '/client/v4'

const ok = (result: unknown, status = 200, extra: Record<string, unknown> = {}) =>
  json({ success: true, errors: [], messages: [], result, ...extra }, status)

export const cfError = (status: number, code: number, message: string) =>
  json({ success: false, errors: [{ code, message }], messages: [], result: null }, status)

const notFound = (what: string) => cfError(404, 10007, `${what} not found`)

function formText(value: FormDataEntryValue | null): Promise<string> {
  if (value === null) return Promise.resolve('')
  return typeof value === 'string' ? Promise.resolve(value) : value.text()
}

export class FakeCloudflare implements VendorHandler {
  readonly kv = new Map<string, FakeKvNamespace>()
  readonly queues = new Map<string, FakeQueue>()
  readonly r2 = new Map<string, FakeR2Bucket>()
  readonly scripts = new Map<string, FakeScript>()
  readonly workflows = new Map<string, FakeWorkflowReg>()
  readonly routes = new Map<string, FakeRoute>()
  /**
   * The zone's DNS records by id, FQDN names. Seeded with the proxied wildcard a set-up zone has;
   * a test clears it to see the setup check create one (`POST …/dns_records`).
   */
  readonly dnsRecords = new Map<string, FakeDnsRecord>()
  /** Asset content hash → base64 body, across every upload. */
  readonly assetBlobs = new Map<string, string>()
  private readonly sessions = new Map<string, AssetSession>()
  /**
   * Refuse a secret whose name is a `plain_text` / `json` binding of the live version (Cloudflare's
   * 10053). On by default; a test of something else may turn it off.
   */
  secretNameClash = true
  /** Completion jwt → the manifest it completes, so a version can bind it. */
  readonly completions = new Map<
    string,
    { scriptName: string; manifest: Record<string, unknown> }
  >()

  constructor(
    private readonly ids: IdSource,
    readonly opts: FakeCloudflareOptions
  ) {
    this.dnsRecords.set('dns-wildcard', {
      id: 'dns-wildcard',
      type: 'AAAA',
      name: `*.${opts.zoneName}`,
      content: '100::',
      proxied: true,
    })
  }

  /** The script serving `host`, through a route whose pattern is `<host>/*`, or null. */
  scriptForHost(host: string): FakeScript | null {
    for (const route of this.routes.values()) {
      const pattern = route.pattern.replace(/\/\*$/, '')
      if (pattern === host) return this.scripts.get(route.script) ?? null
    }
    return null
  }

  /** The active version of a script, or null. */
  activeVersion(scriptName: string): FakeVersion | null {
    const script = this.scripts.get(scriptName)
    if (!script?.activeVersionId) return null
    return script.versions.find(v => v.id === script.activeVersionId) ?? null
  }

  /**
   * What the running Worker's `env` holds as strings (P5): the ACTIVE version's `plain_text` and
   * `json` bindings and its `secret_text` values, by name — null when the script has no live
   * version (a placeholder, or no script). Other bindings (KV, queues…) are not strings and are
   * left out.
   */
  envOf(scriptName: string): Record<string, string> | null {
    const version = this.activeVersion(scriptName)
    if (!version) return null
    const script = this.scripts.get(scriptName)
    const out: Record<string, string> = {}
    for (const b of version.bindings) {
      const name = String(b.name ?? '')
      if (b.type === 'plain_text') out[name] = String(b.text ?? '')
      else if (b.type === 'json') out[name] = JSON.stringify(b.json ?? null)
      else if (b.type === 'secret_text') {
        out[name] = version.secrets?.[name] ?? script?.secrets.get(name) ?? ''
      }
    }
    return out
  }

  /**
   * A secret write on a live script: a new version with the active one's bindings, `name` replaced
   * (or removed when `value` is null), deployed at 100% — Cloudflare's "each secret change is a
   * version" (plan §5).
   */
  private secretVersion(script: FakeScript, name: string, value: string | null): void {
    const active = script.activeVersionId
      ? script.versions.find(v => v.id === script.activeVersionId)
      : undefined
    if (!active) return
    const bindings = active.bindings.filter(b => b.name !== name)
    const secrets = { ...(active.secrets ?? {}) }
    delete secrets[name]
    if (value !== null) {
      bindings.push({ type: 'secret_text', name })
      secrets[name] = value
    }
    const version: FakeVersion = {
      id: crypto.randomUUID(),
      metadata: {
        ...active.metadata,
        bindings,
        annotations: { 'workers/triggered_by': value === null ? 'secret_delete' : 'secret' },
      },
      modules: active.modules,
      bindings,
      secrets,
      createdAt: new Date(),
    }
    script.versions.push(version)
    script.deployments.push({
      id: this.ids.hex32(),
      versions: [{ version_id: version.id, percentage: 100 }],
      createdAt: new Date(),
    })
    script.activeVersionId = version.id
  }

  resourcesFor(slug: string): ResourceLabel[] {
    const out: ResourceLabel[] = []
    for (const ns of this.kv.values())
      if (belongsTo(slug, ns.title)) out.push(`cloudflare:kv:${ns.title}`)
    for (const q of this.queues.values()) {
      if (belongsTo(slug, q.queue_name)) out.push(`cloudflare:queue:${q.queue_name}`)
      for (const c of q.consumers.values()) {
        if (belongsTo(slug, c.script_name))
          out.push(`cloudflare:consumer:${q.queue_name}->${c.script_name}`)
      }
    }
    for (const b of this.r2.values())
      if (belongsTo(slug, b.name)) out.push(`cloudflare:r2:${b.name}`)
    for (const s of this.scripts.values())
      if (belongsTo(slug, s.name)) out.push(`cloudflare:script:${s.name}`)
    for (const w of this.workflows.values())
      if (belongsTo(slug, w.name)) out.push(`cloudflare:workflow:${w.name}`)
    for (const r of this.routes.values()) {
      if (belongsTo(slug, r.pattern) || belongsTo(slug, r.script))
        out.push(`cloudflare:route:${r.pattern}`)
    }
    return out
  }

  async handle(req: FakeRequest): Promise<Response | null> {
    if (req.url.hostname !== 'api.cloudflare.com') return null
    if (!req.url.pathname.startsWith(BASE)) return notFound('path')
    const path = req.url.pathname.slice(BASE.length)
    const m = req.method

    // The assets upload authenticates with the SESSION jwt, not the API token.
    if (m === 'POST' && /^\/accounts\/[^/]+\/workers\/assets\/upload$/.test(path)) {
      return this.uploadAssets(req)
    }
    if (this.opts.apiToken && req.bearer !== this.opts.apiToken) {
      return cfError(401, 10000, 'Authentication error')
    }

    let match: RegExpMatchArray | null
    match = path.match(/^\/accounts\/([^/]+)(\/.*)$/)
    if (match) {
      if (match[1] !== this.opts.accountId) return cfError(403, 10000, 'Authentication error')
      return this.account(m, match[2], req)
    }
    match = path.match(/^\/zones\/([^/]+)\/workers\/routes(?:\/([^/]+))?$/)
    if (match) {
      if (match[1] !== this.opts.zoneId) return notFound('zone')
      return this.zoneRoutes(m, match[1], match[2] ?? null, req)
    }
    if (m === 'GET' && path === '/zones') {
      const name = req.url.searchParams.get('name')
      return ok(
        !name || name === this.opts.zoneName
          ? [
              {
                id: this.opts.zoneId,
                name: this.opts.zoneName,
                status: 'active',
                account: { id: this.opts.accountId },
              },
            ]
          : []
      )
    }
    match = path.match(/^\/zones\/([^/]+)\/dns_records$/)
    if (match && m === 'GET') {
      if (match[1] !== this.opts.zoneId) return notFound('zone')
      const name = req.url.searchParams.get('name')
      return ok([...this.dnsRecords.values()].filter(r => !name || r.name === name))
    }
    if (match && m === 'POST') {
      if (match[1] !== this.opts.zoneId) return notFound('zone')
      const body = (req.json ?? {}) as Record<string, unknown>
      const rel = String(body.name ?? '')
      // A name is relative to the zone unless it already ends with it, as Cloudflare reads it.
      const name =
        rel === '@'
          ? this.opts.zoneName
          : rel.endsWith(this.opts.zoneName)
            ? rel
            : `${rel}.${this.opts.zoneName}`
      const type = String(body.type ?? '')
      if ([...this.dnsRecords.values()].some(r => r.name === name && r.type === type)) {
        return cfError(400, 81058, 'An identical record already exists.')
      }
      const record = {
        id: this.ids.hex32(),
        type,
        name,
        content: String(body.content ?? ''),
        proxied: body.proxied === true,
      }
      this.dnsRecords.set(record.id, record)
      return ok(record)
    }
    return notFound(`${m} ${path}`)
  }

  private async account(m: string, path: string, req: FakeRequest): Promise<Response> {
    let match: RegExpMatchArray | null
    const body = (req.json ?? {}) as Record<string, unknown>

    if (m === 'GET' && path === '/tokens/verify') return ok({ id: 'fake-token', status: 'active' })

    // ---- KV
    if (path === '/storage/kv/namespaces') {
      if (m === 'GET') {
        const page = Number(req.url.searchParams.get('page') ?? '1')
        const perPage = Number(req.url.searchParams.get('per_page') ?? '20')
        const all = [...this.kv.values()]
        const slice = all.slice((page - 1) * perPage, page * perPage)
        return ok(slice, 200, {
          result_info: {
            page,
            per_page: perPage,
            total_pages: Math.max(1, Math.ceil(all.length / perPage)),
          },
        })
      }
      if (m === 'POST') {
        const title = String(body.title ?? '')
        if ([...this.kv.values()].some(ns => ns.title === title)) {
          return cfError(400, 10014, 'A namespace with this account ID and title already exists.')
        }
        const ns = { id: this.ids.hex32(), title }
        this.kv.set(ns.id, ns)
        return ok(ns)
      }
    }
    match = path.match(/^\/storage\/kv\/namespaces\/([^/]+)$/)
    if (match && m === 'DELETE') {
      if (!this.kv.delete(match[1])) return notFound('namespace')
      return ok(null)
    }

    // ---- Queues
    if (path === '/queues') {
      if (m === 'GET') return ok([...this.queues.values()].map(q => this.queueJson(q)))
      if (m === 'POST') {
        const name = String(body.queue_name ?? '')
        if ([...this.queues.values()].some(q => q.queue_name === name)) {
          return cfError(409, 11009, 'Queue name already taken')
        }
        const queue: FakeQueue = {
          queue_id: this.ids.hex32(),
          queue_name: name,
          consumers: new Map(),
        }
        this.queues.set(queue.queue_id, queue)
        return ok(this.queueJson(queue))
      }
    }
    match = path.match(/^\/queues\/([^/]+)$/)
    if (match) {
      const queue = this.queues.get(match[1])
      if (!queue) return notFound('queue')
      if (m === 'GET') return ok(this.queueJson(queue))
      if (m === 'DELETE') {
        this.queues.delete(queue.queue_id)
        return ok(null)
      }
    }
    match = path.match(/^\/queues\/([^/]+)\/consumers(?:\/([^/]+))?$/)
    if (match) {
      const queue = this.queues.get(match[1])
      if (!queue) return notFound('queue')
      const consumerId = match[2]
      if (!consumerId && m === 'GET') return ok([...queue.consumers.values()])
      if (!consumerId && m === 'POST') {
        const script = String(body.script_name ?? '')
        if ([...queue.consumers.values()].some(c => c.script_name === script)) {
          return cfError(409, 11010, 'This queue already has a consumer for that script')
        }
        const consumer: FakeQueueConsumer = {
          consumer_id: this.ids.hex32(),
          script_name: script,
          type: String(body.type ?? 'worker'),
          settings: (body.settings as Record<string, unknown>) ?? {},
          ...(body.dead_letter_queue ? { dead_letter_queue: String(body.dead_letter_queue) } : {}),
        }
        queue.consumers.set(consumer.consumer_id, consumer)
        return ok(consumer)
      }
      if (consumerId) {
        const consumer = queue.consumers.get(consumerId)
        if (!consumer) return notFound('consumer')
        if (m === 'PUT') {
          consumer.settings = (body.settings as Record<string, unknown>) ?? consumer.settings
          if (body.dead_letter_queue) consumer.dead_letter_queue = String(body.dead_letter_queue)
          return ok(consumer)
        }
        if (m === 'DELETE') {
          queue.consumers.delete(consumerId)
          return ok(null)
        }
      }
    }

    // ---- R2
    if (path === '/r2/buckets') {
      if (m === 'GET') return ok({ buckets: [...this.r2.values()].map(b => ({ name: b.name })) })
      if (m === 'POST') {
        const name = String(body.name ?? '')
        if (this.r2.has(name))
          return cfError(409, 10004, 'The bucket you tried to create already exists')
        this.r2.set(name, { name, objects: new Map() })
        return ok({ name, location: 'WEUR', creation_date: new Date().toISOString() })
      }
    }
    match = path.match(/^\/r2\/buckets\/([^/]+)$/)
    if (match) {
      const bucket = this.r2.get(decodeURIComponent(match[1]))
      if (!bucket) return notFound('bucket')
      if (m === 'GET') return ok({ name: bucket.name })
      if (m === 'DELETE') {
        if (bucket.objects.size > 0)
          return cfError(409, 10008, 'The bucket you tried to delete is not empty')
        this.r2.delete(bucket.name)
        return ok(null)
      }
    }
    match = path.match(/^\/r2\/buckets\/([^/]+)\/objects(?:\/(.+))?$/)
    if (match) {
      const bucket = this.r2.get(decodeURIComponent(match[1]))
      if (!bucket) return notFound('bucket')
      const key = match[2] ? decodeURIComponent(match[2]) : null
      if (!key && m === 'GET') {
        const perPage = Number(req.url.searchParams.get('per_page') ?? '1000')
        return ok([...bucket.objects.keys()].slice(0, perPage).map(k => ({ key: k })))
      }
      if (key && m === 'PUT') {
        bucket.objects.set(key, req.text)
        return ok({ key })
      }
      if (key && m === 'DELETE') {
        bucket.objects.delete(key)
        return ok(null)
      }
    }

    // ---- Scripts
    if (m === 'GET' && path === '/workers/scripts') {
      return ok([...this.scripts.values()].map(s => ({ id: s.name })))
    }
    match = path.match(/^\/workers\/scripts\/([^/]+)$/)
    if (match) {
      const name = decodeURIComponent(match[1])
      if (m === 'PUT') return this.putScript(name, req)
      const script = this.scripts.get(name)
      if (!script) return notFound('script')
      if (m === 'DELETE') {
        const bound = [...this.queues.values()].some(q =>
          [...q.consumers.values()].some(c => c.script_name === name)
        )
        if (bound && req.url.searchParams.get('force') !== 'true') {
          return cfError(400, 10064, 'Cannot delete a script that is a queue consumer; use force')
        }
        this.scripts.delete(name)
        for (const q of this.queues.values()) {
          for (const [id, c] of q.consumers) if (c.script_name === name) q.consumers.delete(id)
        }
        return ok(null)
      }
    }
    match = path.match(/^\/workers\/scripts\/([^/]+)\/(.+)$/)
    if (match) {
      const name = decodeURIComponent(match[1])
      const sub = match[2]
      const script = this.scripts.get(name)
      if (sub === 'assets-upload-session' && m === 'POST') {
        // A session may precede the script's first version, as for `wrangler deploy`.
        return this.assetsSession(name, body)
      }
      if (!script) return notFound('script')
      if (sub === 'subdomain' && m === 'POST') {
        script.workersDev = Boolean(body.enabled)
        return ok({ enabled: script.workersDev, previews_enabled: Boolean(body.previews_enabled) })
      }
      if (sub === 'secrets' && m === 'PUT') {
        const secretName = String(body.name ?? '')
        const live = this.activeVersion(name)
        if (
          this.secretNameClash &&
          live?.bindings.some(
            b => b.name === secretName && (b.type === 'plain_text' || b.type === 'json')
          )
        ) {
          return cfError(
            400,
            10053,
            `Binding name '${secretName}' already in use. Please use a different name and try again.`
          )
        }
        const text = String(body.text ?? '')
        script.secrets.set(secretName, text)
        script.secretPuts.push(secretName)
        this.secretVersion(script, secretName, text)
        return ok({ name: secretName, type: 'secret_text' })
      }
      if (sub === 'secrets' && m === 'GET') {
        return ok([...script.secrets.keys()].map(n => ({ name: n, type: 'secret_text' })))
      }
      const secretMatch = sub.match(/^secrets\/([^/]+)$/)
      if (secretMatch && m === 'DELETE') {
        const secretName = decodeURIComponent(secretMatch[1])
        if (!script.secrets.has(secretName)) return cfError(404, 10056, 'secret not found')
        script.secrets.delete(secretName)
        script.secretDeletes.push(secretName)
        this.secretVersion(script, secretName, null)
        return ok(null)
      }
      if (sub === 'versions' && m === 'POST') return this.createVersion(script, req)
      if (sub === 'versions' && m === 'GET') {
        return ok({ items: script.versions.map(v => ({ id: v.id, metadata: v.metadata })) })
      }
      if (sub === 'deployments' && m === 'POST') {
        const versions = (body.versions as { version_id: string; percentage: number }[]) ?? []
        for (const v of versions) {
          if (!script.versions.some(x => x.id === v.version_id)) return notFound('version')
        }
        const deployment: FakeDeployment = { id: this.ids.hex32(), versions, createdAt: new Date() }
        script.deployments.push(deployment)
        const full = versions.find(v => v.percentage === 100)
        if (full) script.activeVersionId = full.version_id
        return ok(deployment)
      }
      if (sub === 'deployments' && m === 'GET') return ok({ deployments: script.deployments })
      if (sub === 'schedules' && m === 'PUT') {
        const list = (Array.isArray(req.json) ? req.json : []) as { cron: string }[]
        script.schedules = list.map(s => s.cron)
        return ok({ schedules: script.schedules.map(cron => ({ cron })) })
      }
      if (sub === 'schedules' && m === 'GET') {
        return ok({ schedules: script.schedules.map(cron => ({ cron })) })
      }
      if (sub === 'script-settings' && m === 'PATCH') {
        script.settings = { ...script.settings, ...body }
        return ok(script.settings)
      }
    }

    // ---- Workflows
    match = path.match(/^\/workflows\/([^/]+)$/)
    if (match) {
      const name = decodeURIComponent(match[1])
      if (m === 'PUT') {
        const scriptName = String(body.script_name ?? '')
        if (!this.scripts.has(scriptName))
          return cfError(400, 10021, `script ${scriptName} not found`)
        const reg = { name, class_name: String(body.class_name ?? ''), script_name: scriptName }
        this.workflows.set(name, reg)
        return ok({ id: name, ...reg })
      }
      const reg = this.workflows.get(name)
      if (!reg) return notFound('workflow')
      if (m === 'GET') return ok(reg)
      if (m === 'DELETE') {
        this.workflows.delete(name)
        return ok(null)
      }
    }

    return notFound(`${m} ${path}`)
  }

  private queueJson(q: FakeQueue) {
    return { queue_id: q.queue_id, queue_name: q.queue_name, consumers: [...q.consumers.values()] }
  }

  private async readWorkerForm(req: FakeRequest) {
    if (!req.form) return null
    const metadata = JSON.parse(await formText(req.form.get('metadata'))) as Record<string, unknown>
    const modules: Record<string, string> = {}
    for (const [key, value] of req.form.entries()) {
      if (key === 'metadata') continue
      modules[key] = await formText(value)
    }
    return { metadata, modules }
  }

  private async putScript(name: string, req: FakeRequest): Promise<Response> {
    const parsed = await this.readWorkerForm(req)
    if (!parsed) return cfError(400, 10021, 'Expected a multipart body with a metadata part')
    const { metadata, modules } = parsed
    const main = String(metadata.main_module ?? '')
    if (!(main in modules)) return cfError(400, 10021, `main_module ${main} is not among the parts`)
    const existing = this.scripts.get(name)
    const migrations = metadata.migrations as { new_tag?: string; old_tag?: string } | undefined
    // As the real API: migrations apply on top of the script's current tag, named as `old_tag`.
    // Re-sending an applied tag (a retry that forgot it) is refused.
    const current = existing?.migrationTag ?? null
    if (migrations?.new_tag && (migrations.old_tag ?? null) !== current) {
      return cfError(
        400,
        10079,
        `Migration tag precondition failed: the script is at ${current ?? 'no tag'}, ` +
          `the upload says ${migrations.old_tag ?? 'none'}`
      )
    }
    const script: FakeScript = existing ?? {
      name,
      metadata: {},
      modules: {},
      secrets: new Map(),
      secretPuts: [],
      secretDeletes: [],
      migrationTag: null,
      workersDev: true,
      schedules: [],
      settings: {},
      versions: [],
      deployments: [],
      activeVersionId: null,
    }
    script.metadata = metadata
    script.modules = modules
    if (migrations?.new_tag) script.migrationTag = migrations.new_tag
    this.scripts.set(name, script)
    return ok({ id: name, etag: this.ids.hex32(), modified_on: new Date().toISOString() })
  }

  private async createVersion(script: FakeScript, req: FakeRequest): Promise<Response> {
    const parsed = await this.readWorkerForm(req)
    if (!parsed) return cfError(400, 10021, 'Expected a multipart body with a metadata part')
    const { metadata, modules } = parsed
    if (metadata.migrations) {
      return cfError(400, 10021, 'Durable Object migrations cannot be applied by a version upload')
    }
    const assets = metadata.assets as { jwt?: string } | undefined
    if (assets?.jwt && !this.completions.has(assets.jwt)) {
      return cfError(400, 10021, 'assets.jwt is not a completion token')
    }
    const uploaded = (metadata.bindings as Record<string, unknown>[] | undefined) ?? []
    const keep = (metadata.keep_bindings as string[] | undefined) ?? []
    const keepsSecrets = keep.includes('secret_text')
    // P5 plan §1.5: a var the upload declares under the name of a secret it keeps clashes — the
    // deploy gateway drops such a var (`shadowedVars`) before it gets here.
    const clash = uploaded.find(
      b =>
        (b.type === 'plain_text' || b.type === 'json') &&
        keepsSecrets &&
        script.secrets.has(String(b.name))
    )
    if (clash && this.secretNameClash) {
      return cfError(
        400,
        10053,
        `Binding name '${String(clash.name)}' already in use. Please use a different name and try again.`
      )
    }
    const kept = keepsSecrets
      ? [...script.secrets.keys()]
          .filter(name => !uploaded.some(b => b.name === name))
          .map(name => ({ type: 'secret_text', name }))
      : []
    // The secret values as of THIS upload: an uploaded `secret_text` carries its own text, a kept
    // one the script's current value (so a later secret write does not change this version).
    const secrets: Record<string, string> = {}
    for (const b of uploaded) {
      if (b.type === 'secret_text') secrets[String(b.name)] = String(b.text ?? '')
    }
    for (const b of kept) secrets[b.name] = script.secrets.get(b.name) ?? ''
    const version: FakeVersion = {
      id: crypto.randomUUID(),
      metadata,
      modules,
      bindings: [...uploaded, ...kept],
      secrets,
      createdAt: new Date(),
    }
    script.versions.push(version)
    return ok({ id: version.id, number: script.versions.length, metadata })
  }

  private assetsSession(scriptName: string, body: Record<string, unknown>): Response {
    const manifest = (body.manifest ?? {}) as Record<string, { hash: string; size: number }>
    const pending = new Set(
      Object.values(manifest)
        .map(e => e.hash)
        .filter(h => !this.assetBlobs.has(h))
    )
    const jwt = `session-${this.ids.hex32()}`
    this.sessions.set(jwt, { scriptName, manifest, pending })
    if (pending.size === 0) {
      this.completions.set(jwt, { scriptName, manifest })
      return ok({ jwt, buckets: [] })
    }
    // Two buckets when there is more than one file, so a client that uploads only the first fails.
    const hashes = [...pending]
    const half = Math.ceil(hashes.length / 2)
    const buckets = hashes.length > 1 ? [hashes.slice(0, half), hashes.slice(half)] : [hashes]
    return ok({ jwt, buckets })
  }

  private async uploadAssets(req: FakeRequest): Promise<Response> {
    const session = req.bearer ? this.sessions.get(req.bearer) : undefined
    if (!session) return cfError(401, 10000, 'Authentication error: not an upload session')
    if (req.url.searchParams.get('base64') !== 'true')
      return cfError(400, 10021, 'base64=true required')
    if (!req.form) return cfError(400, 10021, 'Expected multipart')
    for (const [hash, value] of req.form.entries()) {
      this.assetBlobs.set(hash, await formText(value))
      session.pending.delete(hash)
    }
    if (session.pending.size > 0) return ok({}, 202)
    const completion = `completion-${this.ids.hex32()}`
    this.completions.set(completion, { scriptName: session.scriptName, manifest: session.manifest })
    return ok({ jwt: completion }, 201)
  }

  private zoneRoutes(
    m: string,
    zoneId: string,
    routeId: string | null,
    req: FakeRequest
  ): Response {
    const body = (req.json ?? {}) as Record<string, unknown>
    if (!routeId && m === 'GET') {
      return ok(
        [...this.routes.values()]
          .filter(r => r.zoneId === zoneId)
          .map(r => ({ id: r.id, pattern: r.pattern, script: r.script }))
      )
    }
    if (!routeId && m === 'POST') {
      const pattern = String(body.pattern ?? '')
      if ([...this.routes.values()].some(r => r.pattern === pattern)) {
        return cfError(409, 10020, 'A route with the same pattern already exists')
      }
      const route: FakeRoute = {
        id: this.ids.hex32(),
        zoneId,
        pattern,
        script: String(body.script ?? ''),
      }
      this.routes.set(route.id, route)
      return ok({ id: route.id, pattern, script: route.script })
    }
    if (routeId && m === 'DELETE') {
      if (!this.routes.delete(routeId)) return notFound('route')
      return ok({ id: routeId })
    }
    return notFound(`${m} route`)
  }
}
