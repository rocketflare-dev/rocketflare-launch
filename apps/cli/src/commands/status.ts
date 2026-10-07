/**
 * `launch status [--all] [--ready]` — `GET /api/health` on the selected server plus its local
 * login state (D26); `--all` checks every configured server at once (short timeout each, never
 * fails the command for one that is down).
 *
 * The single-server form also reads `GET /api/ready` (readiness: the database answers `SELECT 1`).
 * It is reported, never fatal, unless `--ready` asks for it: then a server that is up but not
 * ready (a 503 `database_unavailable`) exits 1, so a script can wait on it.
 */
import chalk from 'chalk'
import { z } from 'zod'
import { CliApiError, createApiClient } from '../api'
import { redactKey } from '../config'
import { type CommandContext, publicClient } from '../context'
import { CliError, EXIT_ERROR } from '../errors'
import { renderTable } from '../utils/output'
import { serverLabel } from './servers'

export const healthSchema = z
  .object({ status: z.string(), version: z.string().optional(), env: z.string().optional() })
  .passthrough()

/** Per-server timeout of `status --all`. */
export const STATUS_ALL_TIMEOUT_MS = 5_000

/** `GET /api/ready` → `{ status: 'ready' }`; not ready is the 503 error envelope. */
export const readySchema = z.object({ status: z.string() }).passthrough()

export interface StatusReadiness {
  ready: boolean
  status: string
  code?: string
  error?: string
}

/** Readiness as a value: an error answer (503, or a server without the probe) is "not ready". */
async function readReadiness(ctx: CommandContext): Promise<StatusReadiness> {
  try {
    const { data } = await publicClient(ctx).request('GET', '/api/ready', { schema: readySchema })
    return { ready: data.status === 'ready', status: data.status }
  } catch (error) {
    if (!(error instanceof CliApiError)) throw error
    return {
      ready: false,
      status: error.status === 404 ? 'unknown' : 'not ready',
      code: error.code,
      error: error.message,
    }
  }
}

export interface StatusOptions {
  all?: boolean
  /** Exit 1 unless the server is ready (database reachable). */
  ready?: boolean
}

export async function runStatus(ctx: CommandContext, options: StatusOptions = {}): Promise<void> {
  if (options.all) return runStatusAll(ctx)
  const { data, raw } = await publicClient(ctx).request('GET', '/api/health', {
    schema: healthSchema,
  })
  const ready = await readReadiness(ctx)
  const loggedIn = Boolean(ctx.config.apiKey)
  ctx.out.data(
    {
      profile: ctx.config.profile ?? null,
      serverUrl: ctx.config.serverUrl,
      health: raw,
      ready,
      loggedIn,
      tenantName: ctx.config.tenantName,
      user: ctx.config.user,
      apiKey: redactKey(ctx.config.apiKey),
    },
    () =>
      [
        `${chalk.bold('Server:')}  ${serverLabel(ctx)} ${chalk.dim(`(from ${ctx.config.serverUrlSource})`)}`,
        `${chalk.bold('Health:')}  ${data.status === 'ok' ? chalk.green(data.status) : chalk.yellow(data.status)}${data.version ? ` · v${data.version}` : ''}${data.env ? ` · ${data.env}` : ''}`,
        `${chalk.bold('Ready:')}   ${ready.ready ? chalk.green(ready.status) : chalk.yellow(ready.status)}${ready.error ? chalk.dim(` — ${ready.error}${ready.code ? ` (${ready.code})` : ''}`) : ''}`,
        `${chalk.bold('Login:')}   ${
          loggedIn
            ? `${chalk.green('signed in')}${ctx.config.user?.email ? ` as ${ctx.config.user.email}` : ''}${ctx.config.tenantName ? ` · ${ctx.config.tenantName}` : ''} ${chalk.dim(`(key ${redactKey(ctx.config.apiKey)} from ${ctx.config.apiKeySource})`)}`
            : `${chalk.yellow('not signed in')} ${chalk.dim(`— run \`${ctx.binName} login\``)}`
        }`,
      ].join('\n')
  )
  if (options.ready && !ready.ready) {
    throw new CliError(`server is not ready: ${ready.error ?? ready.status}`, {
      exitCode: EXIT_ERROR,
      hint: 'GET /api/ready checks the database; is it running and reachable from the Worker?',
    })
  }
}

interface ServerStatus {
  name: string
  serverUrl: string
  default: boolean
  active: boolean
  loggedIn: boolean
  health: string
  version: string | null
  error: string | null
}

async function runStatusAll(ctx: CommandContext): Promise<void> {
  const config = await ctx.store.load()
  const rows: ServerStatus[] = await Promise.all(
    Object.entries(config.profiles)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(async ([name, profile]) => {
        const base = {
          name,
          serverUrl: profile.serverUrl,
          default: name === config.defaultProfile,
          active: name === ctx.config.profile,
          loggedIn: Boolean(profile.apiKey),
        }
        try {
          const client = createApiClient({
            serverUrl: profile.serverUrl,
            fetch: ctx.fetch,
            timeoutMs: STATUS_ALL_TIMEOUT_MS,
          })
          const health = await client.get('/api/health', { schema: healthSchema })
          return { ...base, health: health.status, version: health.version ?? null, error: null }
        } catch (error) {
          return { ...base, health: 'down', version: null, error: (error as Error).message }
        }
      })
  )
  ctx.out.data({ servers: rows }, () =>
    renderTable(rows, [
      { header: '', value: r => `${r.default ? '*' : ' '}${r.active ? '>' : ' '}` },
      { header: 'NAME', value: r => r.name },
      { header: 'URL', value: r => r.serverUrl },
      {
        header: 'HEALTH',
        value: r => (r.health === 'ok' ? chalk.green('ok') : chalk.yellow(r.health)),
      },
      { header: 'VERSION', value: r => r.version },
      { header: 'LOGIN', value: r => (r.loggedIn ? 'signed in' : 'not signed in') },
      { header: 'ERROR', value: r => r.error },
    ])
  )
}
