/**
 * Login handoff (D26). The CLI listens on the first free port in 8765–8770 at
 * `http://127.0.0.1:<port>/callback`, opens `${serverUrl}/auth/cli?redirect_uri=<callback>` in the
 * browser, and the server — after login + tenant selection — redirects back with
 * `?key=<api key>&tenant_id=<uuid>&tenant_name=<name>` (or `?error=<code>`). The callback answers
 * a tiny self-closing page, the CLI fetches `/api/me` with the new key to learn who signed in, and
 * writes the config. Five-minute timeout. The key is never printed in full — prefix only.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tenantSchema } from '@launch/shared/tenants'
import { meResponseSchema as sharedMeResponseSchema } from '@launch/shared/user-settings'
import type { z } from 'zod'
import { type ApiClient, CliApiError, createApiClient, type FetchLike } from './api'
import { type ConfigStore, type Profile, redactKey } from './config'
import type { OpenLike } from './context'
import { CliError } from './errors'
import { BIN_NAME } from './package-info'
import type { Logger } from './utils/logger'

export const CALLBACK_PORT_START = 8765
export const CALLBACK_PORT_END = 8770
export const CALLBACK_PATH = '/callback'
export const LOGIN_TIMEOUT_MS = 5 * 60 * 1000
/** Server route that starts the browser side of the handoff. */
export const AUTH_CLI_PATH = '/auth/cli'

/** Tolerant: the CLI only needs email/name, and the server may add fields. */
/** `/api/me` is the flat `meResponseSchema` from `@launch/shared/user-settings` (D13). */
export const meResponseSchema = sharedMeResponseSchema.partial()
export type MeResponse = z.infer<typeof meResponseSchema>
export const tenantResponseSchema = tenantSchema.partial()

export interface CallbackData {
  key: string
  tenantId: string
  tenantName?: string
}

export interface LoginOptions {
  serverUrl: string
  /** The server (profile) name the credentials are stored under. */
  profile: string
  store: ConfigStore
  log: Logger
  open: OpenLike
  fetch?: FetchLike
  timeoutMs?: number
  /** Ask for an admin-scoped key (`/auth/cli?scope=admin`): it also reaches `/api/admin` and `/api/platform`. */
  admin?: boolean
}

export interface LoginResult {
  profile: string
  serverUrl: string
  keyPrefix: string
  tenantId: string
  tenantName?: string
  user?: Profile['user']
}

export async function loginFlow(options: LoginOptions): Promise<LoginResult> {
  const { serverUrl, profile, store, log } = options
  const callback = await startCallbackServer(options.timeoutMs ?? LOGIN_TIMEOUT_MS)
  try {
    const authUrl = buildAuthUrl(serverUrl, callback.url, { admin: options.admin })
    log.info(`Opening your browser to sign in at ${serverUrl} (server "${profile}")`)
    log.hint(`If it does not open, visit: ${authUrl}`)
    try {
      await options.open(authUrl)
    } catch (error) {
      log.warn(
        `Could not open a browser (${(error as Error).message}); open the URL above manually.`
      )
    }
    log.info('Waiting for the browser to complete sign-in (5-minute timeout)…')

    const data = await callback.result
    const client = createApiClient({ serverUrl, apiKey: data.key, fetch: options.fetch })
    const user = await fetchUser(client, log)

    await store.updateProfile(profile, {
      serverUrl,
      apiKey: data.key,
      tenantId: data.tenantId,
      tenantName: data.tenantName,
      user,
    })

    const keyPrefix = redactKey(data.key)
    log.success(`Signed in${user?.email ? ` as ${user.email}` : ''}`)
    if (data.tenantName) log.hint(`Tenant: ${data.tenantName} (${data.tenantId})`)
    else log.hint(`Tenant: ${data.tenantId}`)
    log.hint(`Server: ${profile} · ${serverUrl}`)
    log.hint(`API key: ${keyPrefix} (stored in ${store.file})`)
    return {
      profile,
      serverUrl,
      keyPrefix,
      tenantId: data.tenantId,
      tenantName: data.tenantName,
      user,
    }
  } finally {
    callback.close()
  }
}

/**
 * Drop the stored key, tenant and user of `profiles` (the selected server, or every server with
 * `--all`); their URLs stay so `login` can sign in again.
 */
export async function logoutFlow(options: {
  store: ConfigStore
  log: Logger
  profiles: readonly string[]
}): Promise<string[]> {
  const cleared: string[] = []
  for (const name of options.profiles) {
    if (await options.store.clearCredentials(name)) cleared.push(name)
  }
  if (cleared.length === 0) {
    options.log.info('Not logged in — nothing to do')
    return cleared
  }
  options.log.success(
    `Logged out of ${cleared.map(name => `"${name}"`).join(', ')}; credentials removed`
  )
  options.log.hint(`Server URLs kept in ${options.store.file}`)
  return cleared
}

/** `{ user, tenant }` for whoami — tenant is null when the request is refused or the route is missing. */
export async function whoAmI(client: ApiClient): Promise<{
  user: MeResponse
  tenant: z.infer<typeof tenantResponseSchema> | null
  raw: { me: unknown; tenant: unknown }
}> {
  const me = await client.request('GET', '/api/me', { schema: meResponseSchema })
  let tenant: z.infer<typeof tenantResponseSchema> | null = null
  let tenantRaw: unknown = null
  try {
    const res = await client.request('GET', '/api/tenant', { schema: tenantResponseSchema })
    tenant = res.data
    tenantRaw = res.raw
  } catch (error) {
    if (!(error instanceof CliApiError) || error.status === 401) throw error
  }
  return { user: me.data, tenant, raw: { me: me.raw, tenant: tenantRaw } }
}

export function buildAuthUrl(
  serverUrl: string,
  callbackUrl: string,
  options: { admin?: boolean } = {}
): string {
  const url = new URL(AUTH_CLI_PATH, `${serverUrl.replace(/\/+$/, '')}/`)
  url.searchParams.set('redirect_uri', callbackUrl)
  if (options.admin) url.searchParams.set('scope', 'admin')
  return url.toString()
}

async function fetchUser(client: ApiClient, log: Logger): Promise<Profile['user'] | undefined> {
  try {
    const me = await client.get('/api/me', { schema: meResponseSchema })
    return { email: me.email, name: me.name }
  } catch (error) {
    // An invalid key must fail the login; a missing/unfinished `/api/me` should not.
    if (error instanceof CliApiError && error.status === 401) throw error
    log.warn(`Could not load your profile (${(error as Error).message}); continuing.`)
    return undefined
  }
}

// ---- Loopback callback server ------------------------------------------------------------

export interface CallbackServer {
  port: number
  url: string
  /** Resolves with the handoff data, rejects on `?error=`, bad params or timeout. */
  result: Promise<CallbackData>
  close(): void
}

export async function startCallbackServer(timeoutMs = LOGIN_TIMEOUT_MS): Promise<CallbackServer> {
  let settle: { resolve: (d: CallbackData) => void; reject: (e: Error) => void } | undefined
  let timer: NodeJS.Timeout | undefined
  const result = new Promise<CallbackData>((resolve, reject) => {
    settle = { resolve, reject }
  }).finally(() => clearTimeout(timer))
  // Mark handled: the browser may hit the callback before the caller awaits `result`.
  result.catch(() => {})

  const server = createServer((req, res) => handleCallback(req, res, port, settle))
  const port = await listenOnFreePort(server)
  timer = setTimeout(() => {
    settle?.reject(
      new CliError(
        `Timed out after ${Math.round(timeoutMs / 60_000) || 1} minute(s) waiting for the browser`,
        { hint: `Run \`${BIN_NAME} login\` again and finish signing in within 5 minutes.` }
      )
    )
  }, timeoutMs)

  return {
    port,
    url: `http://127.0.0.1:${port}${CALLBACK_PATH}`,
    result,
    close: () => {
      clearTimeout(timer)
      server.close()
      server.closeAllConnections?.()
    },
  }
}

function handleCallback(
  req: IncomingMessage,
  res: ServerResponse,
  port: number,
  settle: { resolve: (d: CallbackData) => void; reject: (e: Error) => void } | undefined
): void {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
  if (url.pathname !== CALLBACK_PATH) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found')
    return
  }
  const error = url.searchParams.get('error')
  if (error) {
    respondHtml(
      res,
      400,
      'Sign-in failed',
      `The server reported: ${escapeHtml(error)}. Return to the terminal and try again.`
    )
    settle?.reject(
      error === 'admin_key_forbidden'
        ? new CliError('Sign-in failed: an admin key needs a platform administrator.', {
            hint: `Sign in as one, or run \`${BIN_NAME} login\` for an ordinary key.`,
          })
        : new CliError(`Sign-in failed: ${error}`, {
            hint: `Run \`${BIN_NAME} login\` to try again.`,
          })
    )
    return
  }
  const key = url.searchParams.get('key')
  const tenantId = url.searchParams.get('tenant_id')
  const tenantName = url.searchParams.get('tenant_name') ?? undefined
  if (!key || !tenantId) {
    const missing = [!key && 'key', !tenantId && 'tenant_id'].filter(Boolean).join(', ')
    respondHtml(res, 400, 'Sign-in failed', `The callback was missing: ${escapeHtml(missing)}.`)
    settle?.reject(new CliError(`Callback missing required parameter(s): ${missing}`))
    return
  }
  respondHtml(
    res,
    200,
    'Signed in',
    `You can return to the terminal.${tenantName ? ` Tenant: ${escapeHtml(tenantName)}.` : ''}`,
    true
  )
  settle?.resolve({ key, tenantId, tenantName })
}

function respondHtml(
  res: ServerResponse,
  status: number,
  title: string,
  body: string,
  close = false
) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${BIN_NAME} — ${title}</title></head>
<body style="font-family:system-ui,sans-serif;padding:48px;text-align:center;color:#111">
<h1 style="font-size:1.5rem">${title}</h1><p>${body}</p>
${close ? '<script>setTimeout(function(){window.close()},800)</script>' : ''}
</body></html>`
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'close',
  })
  res.end(html)
}

function listenOnFreePort(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    let port = CALLBACK_PORT_START
    const tryNext = () => {
      if (port > CALLBACK_PORT_END) {
        reject(
          new CliError(
            `No free port in ${CALLBACK_PORT_START}–${CALLBACK_PORT_END} for the login callback`,
            {
              hint: 'Another login may be in progress; close it or free one of those ports.',
            }
          )
        )
        return
      }
      server.once('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE' || error.code === 'EACCES') {
          port += 1
          tryNext()
        } else reject(error)
      })
      server.listen(port, '127.0.0.1', () => {
        server.removeAllListeners('error')
        resolve(port)
      })
    }
    tryNext()
  })
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`)
}
