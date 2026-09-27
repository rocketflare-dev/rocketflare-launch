/**
 * The plumbing every FakeCloud vendor shares: a parsed request, recorded calls, one-shot failures,
 * JSON answers and deterministic ids. See `index.ts` for the API a test uses.
 */
import { jsonResponse } from '../vendor-fetch'

export type Vendor =
  | 'cloudflare'
  | 'neon'
  | 'neon-sql'
  | 'resend'
  | 'github'
  | 'actions-oidc'
  | 'app'

/** One request as a vendor handler sees it. The body is read once, up front. */
export interface FakeRequest {
  method: string
  url: URL
  headers: Headers
  /** The parsed JSON body, or null. */
  json: unknown
  /** The multipart body, or null. */
  form: FormData | null
  /** The raw text body ('' for none or a form). */
  text: string
  /** `Authorization: Bearer <x>` → x, or null. */
  bearer: string | null
}

/** What the fake records for every call, in order. `body` is the parsed JSON (or `'[form]'`). */
export interface FakeCall {
  vendor: Vendor
  method: string
  url: string
  host: string
  path: string
  authorization: string | null
  body: unknown
  status: number
}

/** A matcher for `failNext`: a substring of `"<METHOD> <url>"`, a RegExp over it, or a predicate. */
export type CallMatch = string | RegExp | ((call: { method: string; url: string }) => boolean)

export function matches(match: CallMatch, method: string, url: string): boolean {
  const line = `${method} ${url}`
  if (typeof match === 'string') return line.includes(match)
  if (match instanceof RegExp) return match.test(line)
  return match({ method, url })
}

export async function toFakeRequest(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<FakeRequest> {
  const request = input instanceof Request ? input : null
  const url = new URL(request ? request.url : String(input))
  const method = (init?.method ?? request?.method ?? 'GET').toUpperCase()
  const headers = new Headers(init?.headers ?? request?.headers)
  let json: unknown = null
  let form: FormData | null = null
  let text = ''
  const body = init?.body ?? null
  if (body instanceof FormData) form = body
  else if (typeof body === 'string') text = body
  else if (body instanceof Uint8Array || body instanceof ArrayBuffer) {
    text = new TextDecoder().decode(body)
  } else if (request && method !== 'GET' && method !== 'HEAD') {
    const type = request.headers.get('content-type') ?? ''
    if (type.includes('multipart/form-data')) form = await request.formData()
    else text = await request.text()
  }
  if (text) {
    try {
      json = JSON.parse(text)
    } catch {
      json = null
    }
  }
  const auth = headers.get('authorization')
  const bearer = auth && /^Bearer\s+/i.test(auth) ? auth.replace(/^Bearer\s+/i, '') : null
  return { method, url, headers, json, form, text, bearer }
}

export const json = jsonResponse

export function noContent(): Response {
  return new Response(null, { status: 204 })
}

/** Deterministic ids, unique per FakeCloud instance. */
export class IdSource {
  private n = 0
  /** 32 lower-case hex characters, Cloudflare-style. */
  hex32(): string {
    this.n++
    return this.n.toString(16).padStart(32, '0')
  }
  /** A short readable id: `prefix-000123`. */
  short(prefix: string): string {
    this.n++
    return `${prefix}-${String(this.n).padStart(6, '0')}`
  }
  number(): number {
    this.n++
    return 100_000 + this.n
  }
  /** A 40-hex git sha. */
  sha(): string {
    this.n++
    return this.n.toString(16).padStart(40, 'a')
  }
  secret(prefix: string): string {
    this.n++
    return `${prefix}${this.n.toString(36)}${crypto.randomUUID().replace(/-/g, '')}`
  }
}

/** A resource the invariant helper `resourcesFor(slug)` reports: `"<vendor>:<kind>:<name>"`. */
export type ResourceLabel = string

/** Whether a resource named `name` belongs to the app `slug` (`<slug>`, `<slug>-…`, `<slug>.…`). */
export function belongsTo(slug: string, name: string): boolean {
  return name === slug || name.startsWith(`${slug}-`) || name.startsWith(`${slug}.`)
}

export interface VendorHandler {
  handle(req: FakeRequest): Promise<Response | null> | Response | null
}
