/**
 * HTTP client for the kit's API (D13, D26). Sends `Authorization: Bearer <key>`, turns the error
 * envelope `{ error, statusCode, code?, details? }` into `CliApiError` (401 → exit 2, 403 → exit 3)
 * and validates success bodies with the zod contract from `@launch/shared`. Network failures are a
 * `CliApiError` with `status: 0` so callers only ever handle one error type.
 */
import { apiErrorSchema } from '@launch/shared/errors'
import type { z } from 'zod'
import { CliError, EXIT_ERROR, EXIT_FORBIDDEN, EXIT_NOT_LOGGED_IN } from './errors'
import { BIN_NAME, VERSION } from './package-info'

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface ApiClientOptions {
  serverUrl: string
  apiKey?: string
  fetch?: FetchLike
  timeoutMs?: number
}

export type QueryValue = string | number | boolean | undefined | null

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export interface RequestOptions<T> {
  /**
   * The contract to validate a success body with. `T` is its OUTPUT type: the input is `unknown`,
   * so a schema with `.default()`s or `z.coerce` (whose input is looser than its output) needs no
   * cast at the call site.
   */
  schema?: z.ZodType<T, z.ZodTypeDef, unknown>
  query?: Record<string, QueryValue>
  body?: unknown
}

export interface ApiResponse<T> {
  status: number
  /** The body exactly as the server sent it — what `--json` prints. */
  raw: unknown
  /** The body validated by `schema` (or `raw` when no schema was given). */
  data: T
}

export class CliApiError extends CliError {
  readonly status: number
  readonly code?: string
  readonly body?: unknown

  constructor(options: {
    status: number
    message: string
    code?: string
    body?: unknown
    hint?: string
    cause?: unknown
  }) {
    super(options.message, {
      exitCode: exitCodeForStatus(options.status),
      hint: options.hint ?? defaultHint(options.status),
      cause: options.cause,
    })
    this.name = 'CliApiError'
    this.status = options.status
    this.code = options.code
    this.body = options.body
  }
}

export function exitCodeForStatus(status: number): number {
  if (status === 401) return EXIT_NOT_LOGGED_IN
  if (status === 403) return EXIT_FORBIDDEN
  return EXIT_ERROR
}

function defaultHint(status: number): string | undefined {
  if (status === 401) return `Run \`${BIN_NAME} login\` to authenticate.`
  if (status === 403) return 'Your role in this tenant does not allow that.'
  return undefined
}

/** A success body as text (`ApiClient.raw`), for `launch api call`. */
export interface RawResponse {
  status: number
  contentType: string | null
  text: string
}

/** A streamed success body (`ApiClient.download` / `stream`): read it once, chunk by chunk. */
export interface DownloadResponse {
  status: number
  contentType: string | null
  /** The body as it arrives — never buffered whole, so a large export costs one chunk of memory. */
  body: AsyncIterable<Uint8Array>
}

export interface ApiClient {
  readonly serverUrl: string
  /**
   * `GET` a body that may be large (the audit export) and hand it back as a stream. Errors are the
   * same `CliApiError`s as `request`; the timeout covers reaching the server and the headers, not
   * the length of the download.
   */
  download(
    path: string,
    options?: { query?: Record<string, QueryValue> }
  ): Promise<DownloadResponse>
  /**
   * Any method with a JSON body whose success body is a STREAM (`chat send`: an AG-UI SSE body
   * from a POST). Same `CliApiError`s as `request` for a non-2xx; the timeout covers reaching the
   * server and the headers, never the length of the stream. `accept` defaults to
   * `text/event-stream`.
   */
  stream(
    method: HttpMethod,
    path: string,
    options?: { query?: Record<string, QueryValue>; body?: unknown; accept?: string }
  ): Promise<DownloadResponse>
  /**
   * Any method and path with no contract (`launch api call`, the escape hatch): the success body
   * comes back as text. A non-2xx is the same `CliApiError` as `request`, its `body` the envelope.
   */
  raw(
    method: HttpMethod,
    path: string,
    options?: { query?: Record<string, QueryValue | QueryValue[]>; body?: unknown }
  ): Promise<RawResponse>
  request<T = unknown>(
    method: HttpMethod,
    path: string,
    options?: RequestOptions<T>
  ): Promise<ApiResponse<T>>
  get<T = unknown>(path: string, options?: RequestOptions<T>): Promise<T>
  post<T = unknown>(path: string, options?: RequestOptions<T>): Promise<T>
  del<T = unknown>(path: string, options?: RequestOptions<T>): Promise<T>
}

export function buildUrl(
  serverUrl: string,
  path: string,
  query?: Record<string, QueryValue | QueryValue[]>
) {
  const url = new URL(`${serverUrl.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`)
  for (const [key, value] of Object.entries(query ?? {})) {
    if (Array.isArray(value)) {
      for (const v of value)
        if (v !== undefined && v !== null) url.searchParams.append(key, String(v))
    } else if (value !== undefined && value !== null) url.searchParams.set(key, String(value))
  }
  return url.toString()
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const serverUrl = options.serverUrl.replace(/\/+$/, '')
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => fetch(input, init))
  const timeoutMs = options.timeoutMs ?? 30_000

  function baseHeaders(accept: string): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: accept,
      'User-Agent': `${BIN_NAME}-cli/${VERSION}`,
    }
    if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`
    return headers
  }

  async function send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetchImpl(url, init)
    } catch (cause) {
      throw new CliApiError({
        status: 0,
        code: 'network_error',
        message: `Could not reach ${serverUrl} (${describeCause(cause)})`,
        hint: 'Is the server running? Check the URL with `--server` or `LAUNCH_URL`.',
        cause,
      })
    }
  }

  async function request<T>(
    method: HttpMethod,
    path: string,
    reqOptions: RequestOptions<T> = {}
  ): Promise<ApiResponse<T>> {
    const url = buildUrl(serverUrl, path, reqOptions.query)
    const headers = baseHeaders('application/json')
    // A `FormData` body (an upload) goes as multipart: fetch sets the boundary's Content-Type.
    const multipart = reqOptions.body instanceof FormData
    if (reqOptions.body !== undefined && !multipart) headers['Content-Type'] = 'application/json'

    const response = await send(url, {
      method,
      headers,
      body:
        reqOptions.body === undefined
          ? undefined
          : multipart
            ? (reqOptions.body as FormData)
            : JSON.stringify(reqOptions.body),
      signal: AbortSignal.timeout(timeoutMs),
    })

    const raw = await readBody(response)
    if (!response.ok) throw errorFromResponse(response.status, raw, method, path)
    if (!reqOptions.schema) return { status: response.status, raw, data: raw as T }

    const parsed = reqOptions.schema.safeParse(raw)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      const where = issue?.path.length ? ` at ${issue.path.join('.')}` : ''
      throw new CliApiError({
        status: response.status,
        code: 'invalid_response',
        body: raw,
        message: `Unexpected response from ${method} ${path}${where}: ${issue?.message ?? 'invalid'}`,
        hint: 'The server and CLI contracts may be out of sync — update both from the same commit.',
      })
    }
    return { status: response.status, raw, data: parsed.data }
  }

  async function raw(
    method: HttpMethod,
    path: string,
    rawOptions: { query?: Record<string, QueryValue | QueryValue[]>; body?: unknown } = {}
  ): Promise<RawResponse> {
    const headers = baseHeaders('application/json')
    if (rawOptions.body !== undefined) headers['Content-Type'] = 'application/json'
    const response = await send(buildUrl(serverUrl, path, rawOptions.query), {
      method,
      headers,
      body: rawOptions.body === undefined ? undefined : JSON.stringify(rawOptions.body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok)
      throw errorFromResponse(response.status, await readBody(response), method, path)
    return {
      status: response.status,
      contentType: response.headers.get('content-type'),
      text: response.status === 204 ? '' : await response.text(),
    }
  }

  /** Send, then hand the success body back unread; the timeout stops once the headers are in. */
  async function streamed(
    method: HttpMethod,
    path: string,
    init: { query?: Record<string, QueryValue>; body?: unknown; accept: string }
  ): Promise<DownloadResponse> {
    // An abort mid-body would cut a long stream short, so the timer is cleared at the headers.
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('timed out')), timeoutMs)
    const headers = baseHeaders(init.accept)
    if (init.body !== undefined) headers['Content-Type'] = 'application/json'
    let response: Response
    try {
      response = await send(buildUrl(serverUrl, path, init.query), {
        method,
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }
    if (!response.ok)
      throw errorFromResponse(response.status, await readBody(response), method, path)
    return {
      status: response.status,
      contentType: response.headers.get('content-type'),
      body: chunksOf(response.body),
    }
  }

  function download(
    path: string,
    downloadOptions: { query?: Record<string, QueryValue> } = {}
  ): Promise<DownloadResponse> {
    return streamed('GET', path, { query: downloadOptions.query, accept: '*/*' })
  }

  function stream(
    method: HttpMethod,
    path: string,
    streamOptions: { query?: Record<string, QueryValue>; body?: unknown; accept?: string } = {}
  ): Promise<DownloadResponse> {
    return streamed(method, path, {
      query: streamOptions.query,
      body: streamOptions.body,
      accept: streamOptions.accept ?? 'text/event-stream',
    })
  }

  return {
    serverUrl,
    request,
    raw,
    download,
    stream,
    get: (path, o) => request('GET', path, o).then(r => r.data),
    post: (path, o) => request('POST', path, o).then(r => r.data),
    del: (path, o) => request('DELETE', path, o).then(r => r.data),
  }
}

async function* chunksOf(body: ReadableStream<Uint8Array> | null): AsyncIterable<Uint8Array> {
  if (!body) return
  const reader = body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return
      if (value && value.byteLength > 0) yield value
    }
  } finally {
    reader.releaseLock()
  }
}

async function readBody(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined
  const text = await response.text()
  if (text === '') return undefined
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function errorFromResponse(status: number, body: unknown, method: string, path: string) {
  const envelope = apiErrorSchema.safeParse(body)
  if (envelope.success) {
    return new CliApiError({
      status,
      code: envelope.data.code,
      body,
      message: envelope.data.error,
    })
  }
  return new CliApiError({
    status,
    body,
    message: `${method} ${path} failed with HTTP ${status}`,
  })
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) {
    const inner = (cause as { cause?: unknown }).cause
    if (inner instanceof Error && 'code' in inner) return String((inner as { code: unknown }).code)
    if (cause.name === 'TimeoutError') return 'timed out'
    return cause.message
  }
  return String(cause)
}
