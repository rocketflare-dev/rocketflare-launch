/**
 * The Resend API client Launch acts with (spec/03, spec/04) — Worker-safe, and every call takes an
 * injected `fetch`. `apps/web/scripts/provision/resend.ts` is the Node-side sibling; a reference,
 * never an import.
 *
 * API facts (resend.com/docs/api-reference, checked 2026-09-27, and spike S4):
 *
 * - Base `https://api.resend.com`, `Authorization: Bearer re_…`.
 * - `GET /api-keys` answers only a **full-access** key; a `sending_access` key gets 401
 *   (`restricted_api_key`). That is the setup check's proof Launch can mint per-app keys.
 * - `GET /domains` → `{ data: [{ id, name, status, region }] }`, status ∈ not_started | pending |
 *   verified | failed | temporary_failure. The one fleet domain is `notifications.<apps domain>`,
 *   verified once in the wizard (87 s in S4).
 * - P2: `POST /api-keys {name, permission:'sending_access', domain_id}` → `{ id, token }` — a key
 *   that can send only from the fleet domain. `token` is shown once; the pipeline puts it on the
 *   Worker in the same step and keeps only `id`. `DELETE /api-keys/{id}` revokes it.
 */

export const RESEND_API_BASE = 'https://api.resend.com'
const TIMEOUT_MS = 10_000

export interface ResendOptions {
  fetch?: typeof fetch
  apiBase?: string
}

/** A failed Resend call. `message` is Resend's own `message`, never the key. */
export class ResendApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly path: string,
    /** Resend's error `name`, e.g. `restricted_api_key`. */
    readonly errorName: string | null = null
  ) {
    super(message)
    this.name = 'ResendApiError'
  }
}

export interface ResendDomain {
  id: string
  name: string
  status: 'not_started' | 'pending' | 'verified' | 'failed' | 'temporary_failure' | string
  region?: string
}

export class ResendClient {
  constructor(
    private readonly apiKey: string,
    private readonly opts: ResendOptions = {}
  ) {}

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path)
  }

  async request<T>(method: string, path: string, json?: unknown): Promise<T> {
    const doFetch = this.opts.fetch ?? fetch
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: 'application/json',
    }
    if (json !== undefined) headers['Content-Type'] = 'application/json'
    const res = await doFetch(`${this.opts.apiBase ?? RESEND_API_BASE}${path}`, {
      method,
      headers,
      body: json === undefined ? undefined : JSON.stringify(json),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const body = (await res.json().catch(() => ({}))) as { message?: unknown; name?: unknown }
    if (!res.ok) {
      const message = typeof body.message === 'string' ? body.message : `Resend ${res.status}`
      throw new ResendApiError(
        res.status,
        message,
        path,
        typeof body.name === 'string' ? body.name : null
      )
    }
    return body as T
  }

  async listApiKeys(): Promise<{ id: string; name: string }[]> {
    const body = await this.get<{ data?: { id: string; name: string }[] }>('/api-keys')
    return body.data ?? []
  }

  async listDomains(): Promise<ResendDomain[]> {
    const body = await this.get<{ data?: ResendDomain[] }>('/domains')
    return body.data ?? []
  }

  /**
   * A `sending_access` key restricted to one domain. The `token` is a SECRET shown only here:
   * put it where it goes in the same breath, keep only the `id`.
   */
  createSendingKey(name: string, domainId: string): Promise<{ id: string; token: string }> {
    return this.request('POST', '/api-keys', {
      name,
      permission: 'sending_access',
      domain_id: domainId,
    })
  }

  async deleteApiKey(id: string): Promise<void> {
    await this.request('DELETE', `/api-keys/${encodeURIComponent(id)}`)
  }
}

/** True for a Resend 404 — what teardown counts as "already gone". */
export function isResendNotFound(err: unknown): boolean {
  return err instanceof ResendApiError && err.status === 404
}
