/**
 * FakeResend — API keys (created, listed, deleted) and the fleet's one verified domain. See
 * `index.ts`.
 */
import {
  belongsTo,
  type FakeRequest,
  type IdSource,
  json,
  type ResourceLabel,
  type VendorHandler,
} from './core'

export interface FakeResendKey {
  id: string
  name: string
  /** The secret, as Resend showed it once. */
  token: string
  permission: string
  domain_id: string | null
}

const resendError = (status: number, name: string, message: string) =>
  json({ statusCode: status, name, message }, status)

export class FakeResend implements VendorHandler {
  readonly apiKeys = new Map<string, FakeResendKey>()
  readonly domains: { id: string; name: string; status: string; region: string }[]

  constructor(
    private readonly ids: IdSource,
    opts: { notificationsDomain: string; domainId: string }
  ) {
    this.domains = [
      {
        id: opts.domainId,
        name: opts.notificationsDomain,
        status: 'verified',
        region: 'eu-west-1',
      },
    ]
  }

  resourcesFor(slug: string): ResourceLabel[] {
    return [...this.apiKeys.values()]
      .filter(k => belongsTo(slug, k.name))
      .map(k => `resend:key:${k.name}`)
  }

  handle(req: FakeRequest): Response | null {
    if (req.url.hostname !== 'api.resend.com') return null
    const path = req.url.pathname
    const m = req.method
    const body = (req.json ?? {}) as Record<string, unknown>
    if (path === '/domains' && m === 'GET') return json({ data: this.domains })
    if (path === '/api-keys' && m === 'GET') {
      return json({ data: [...this.apiKeys.values()].map(k => ({ id: k.id, name: k.name })) })
    }
    if (path === '/api-keys' && m === 'POST') {
      const domainId = body.domain_id ? String(body.domain_id) : null
      if (domainId && !this.domains.some(d => d.id === domainId)) {
        return resendError(422, 'validation_error', 'domain_id not found')
      }
      const key: FakeResendKey = {
        id: crypto.randomUUID(),
        name: String(body.name ?? ''),
        token: this.ids.secret('re_'),
        permission: String(body.permission ?? 'full_access'),
        domain_id: domainId,
      }
      this.apiKeys.set(key.id, key)
      return json({ id: key.id, token: key.token }, 201)
    }
    const match = path.match(/^\/api-keys\/([^/]+)$/)
    if (match && m === 'DELETE') {
      if (!this.apiKeys.delete(match[1])) return resendError(404, 'not_found', 'API key not found')
      return json({})
    }
    return resendError(404, 'not_found', `${m} ${path} not found`)
  }
}
