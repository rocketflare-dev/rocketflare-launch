/**
 * `launch api ls|show|call` (issue #6) — what the server's API does and what JSON each route takes,
 * for an agent with no access to the server's source, and the escape hatch for a route no command
 * covers yet (like `gh api`).
 *
 * Everything but `call` reads the generated catalog `../generated/api-catalog.json`, written by
 * `pnpm api:catalog` from the live route table (summaries from the doc comment above each route
 * registration; params, query and body as JSON Schema from the `validate()` schemas) and checked by
 * `apps/web/tests/config/api-catalog.test.ts`, so it cannot drift from the routes it describes.
 *
 * `schema` prints a route's full JSON Schema (params, query, body, response) for an agent that
 * wants the raw contract rather than the rendered fields.
 *
 * `call` validates first, with the SAME zod objects the route validates with — the generated
 * registry `../generated/api-schemas.ts` (`API_SCHEMAS`, imports from `@launch/shared`, loaded
 * lazily): the path params, `--query` and `--data` (no `--data` is `{}`, as the server sees a
 * request with no JSON body). Any issue is exit 1 listing each as `path: message`, nothing sent;
 * `--no-validate` sends it anyway. What is sent is what was given — the server parses it again.
 * It then goes through `api.ts`'s `raw` request (the one fetch site), authenticated with the active
 * server's key; a refusal's envelope (with zod's `details`) is printed as the server sent it.
 *
 * `cli.ts` calls `registerApiCommands(program, action)` once; it registers `launch commands`
 * (`commands.ts`) too, the other half of agent discovery.
 */
import chalk from 'chalk'
import type { Command } from 'commander'
import type { ZodIssue, ZodTypeAny } from 'zod'
import { CliApiError, type HttpMethod, type QueryValue } from '../api'
import { type CommandContext, requireClient } from '../context'
import { CliError } from '../errors'
import catalogJson from '../generated/api-catalog.json'
import type { ApiSchemaEntry } from '../generated/api-schemas'
import type { ActionWrapper } from '../plugins/types'
import { readDataArg } from '../utils/input'
import { formatJson, renderTable } from '../utils/output'
import { registerCommandsCommand } from './commands'

export type JsonSchema = {
  type?: string | string[]
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema
  enum?: unknown[]
  const?: unknown
  anyOf?: JsonSchema[]
  oneOf?: JsonSchema[]
  allOf?: JsonSchema[]
  description?: string
  default?: unknown
  format?: string
  minLength?: number
  maxLength?: number
  minimum?: number
  maximum?: number
  pattern?: string
  additionalProperties?: boolean | JsonSchema
  unresolved?: string
  unvalidated?: boolean
}

/** A body read as multipart form data: the field names the route reads. */
export type MultipartBody = { multipart: true; fields: string[] }
/** A body whose schema depends on a path param (`variants[<param value>]`). */
export type ByParamBody = { byParam: string; variants: Record<string, JsonSchema> }
/** A body read as raw bytes, with why (the GitHub webhook). */
export type RawBody = { raw: true; reason: string }
export type CatalogBody = JsonSchema | MultipartBody | ByParamBody | RawBody

export const isMultipart = (b: CatalogBody | undefined): b is MultipartBody =>
  Boolean(b && 'multipart' in b && b.multipart)
export const isByParam = (b: CatalogBody | undefined): b is ByParamBody =>
  Boolean(b && 'byParam' in b && b.byParam)
export const isRaw = (b: CatalogBody | undefined): b is RawBody => Boolean(b && 'raw' in b && b.raw)

export interface CatalogRoute {
  method: string
  path: string
  summary: string
  description?: string
  auth: string
  params?: JsonSchema
  query?: JsonSchema
  body?: CatalogBody
  /** The body may be omitted entirely. */
  bodyOptional?: true
  /** The success body, when the route's response type pairs with a shared schema. */
  response?: JsonSchema
  /** The `@launch/shared` export (`<module>#<export>`) each schema above is. */
  zod?: { params?: string; query?: string; body?: string; response?: string }
  source?: string
  cli?: string[]
  cliExcluded?: string
}

export interface ApiCatalog {
  routes: CatalogRoute[]
}

export const API_CATALOG = catalogJson as unknown as ApiCatalog

const METHODS: readonly HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']

const AUTH_WORDS: Record<string, string> = {
  public: 'public — no key needed',
  'signed-in': 'signed in — any API key or the browser session; the route may also check a role',
  'platform-admin':
    'platform admin — an admin-scoped key (`login --admin`) or the browser session of one',
  'global-admin':
    'global admin — an admin-scoped key (`login --admin`) or the operator’s browser session',
}

function parseMethod(value: string): HttpMethod {
  const method = value.toUpperCase() as HttpMethod
  if (!METHODS.includes(method))
    throw new CliError(`Unknown method ${value}`, { hint: `Use one of ${METHODS.join(', ')}.` })
  return method
}

const segments = (p: string) =>
  p
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '')
    .split('/')

/**
 * The catalog route a method + path names. `path` may be the pattern itself or a concrete path
 * (`/api/sessions/abc/end` → `/api/sessions/:id/end`); the most specific match (most literal
 * segments) wins, so `/api/apps/new` prefers a literal `new` over `:id`.
 */
export function matchRoute(
  catalog: ApiCatalog,
  method: string,
  path: string
): CatalogRoute | undefined {
  const want = segments(path)
  let best: { route: CatalogRoute; score: number } | undefined
  for (const route of catalog.routes) {
    if (route.method !== method.toUpperCase()) continue
    if (route.path === path) return route
    const have = segments(route.path)
    if (have.length !== want.length) continue
    let score = 0
    let ok = true
    for (let i = 0; i < have.length; i++) {
      const pattern = have[i] as string
      if (pattern.startsWith(':')) {
        if (!want[i]) ok = false
      } else if (pattern === want[i]) score++
      else ok = false
      if (!ok) break
    }
    if (ok && (!best || score > best.score)) best = { route, score }
  }
  return best?.route
}

/** A plain JSON Schema (not multipart, per-param, raw or unresolved). */
const isSchema = (s: CatalogBody | undefined): s is JsonSchema =>
  Boolean(s) &&
  !isMultipart(s) &&
  !isByParam(s) &&
  !isRaw(s) &&
  !(s as JsonSchema).unresolved &&
  !(s as JsonSchema).unvalidated

/** `string`, `"a" | "b"`, `string[]`, `number | null` — a one-line type for a field. */
export function typeOf(schema: JsonSchema): string {
  if (schema.enum) return schema.enum.map(v => JSON.stringify(v)).join(' | ')
  if (schema.const !== undefined) return JSON.stringify(schema.const)
  const union = schema.anyOf ?? schema.oneOf
  if (union) return union.map(typeOf).join(' | ')
  if (schema.allOf) return schema.allOf.map(typeOf).join(' & ')
  const t = Array.isArray(schema.type) ? schema.type.join(' | ') : schema.type
  if (t === 'array') return `${schema.items ? typeOf(schema.items) : 'unknown'}[]`
  if (t === 'string' && schema.format) return `string (${schema.format})`
  return t ?? 'any'
}

function constraints(schema: JsonSchema): string {
  const out: string[] = []
  if (schema.minLength !== undefined || schema.maxLength !== undefined)
    out.push(`${schema.minLength ?? 0}–${schema.maxLength ?? '∞'} chars`)
  if (schema.minimum !== undefined || schema.maximum !== undefined)
    out.push(`${schema.minimum ?? '-∞'}–${schema.maximum ?? '∞'}`)
  if (schema.default !== undefined) out.push(`default ${JSON.stringify(schema.default)}`)
  return out.join(', ')
}

export interface Field {
  name: string
  type: string
  required: boolean
  notes: string
  description?: string
}

/** An object schema's fields, nested objects as `a.b` (to three levels). */
export function fieldsOf(schema: JsonSchema, prefix = '', depth = 0): Field[] {
  const out: Field[] = []
  const required = new Set(schema.required ?? [])
  for (const [name, prop] of Object.entries(schema.properties ?? {})) {
    const full = `${prefix}${name}`
    out.push({
      name: full,
      type: typeOf(prop),
      required: required.has(name),
      notes: constraints(prop),
      description: prop.description,
    })
    if (prop.properties && depth < 2) out.push(...fieldsOf(prop, `${full}.`, depth + 1))
    if (prop.items?.properties && depth < 2)
      out.push(...fieldsOf(prop.items, `${full}[].`, depth + 1))
  }
  return out
}

/** A skeleton value for a schema — what to fill in, not a valid request by itself. */
export function exampleOf(schema: JsonSchema, depth = 0): unknown {
  if (schema.default !== undefined) return schema.default
  if (schema.const !== undefined) return schema.const
  if (schema.enum?.length) return schema.enum[0]
  const union = schema.anyOf ?? schema.oneOf
  if (union?.length) return exampleOf(union.find(s => s.type !== 'null') ?? union[0] ?? {}, depth)
  const t = Array.isArray(schema.type) ? schema.type.find(x => x !== 'null') : schema.type
  if (t === 'object' || schema.properties) {
    if (depth > 3) return {}
    return Object.fromEntries(
      Object.entries(schema.properties ?? {}).map(([k, v]) => [k, exampleOf(v, depth + 1)])
    )
  }
  if (t === 'array') return schema.items ? [exampleOf(schema.items, depth + 1)] : []
  if (t === 'string') return `<${schema.format ?? 'string'}>`
  if (t === 'integer' || t === 'number') return schema.minimum ?? 0
  if (t === 'boolean') return false
  return null
}

/** Path params from the schema when the route validates them, else from the `:names`. */
function paramFields(route: CatalogRoute): Field[] {
  if (isSchema(route.params)) return fieldsOf(route.params)
  return segments(route.path)
    .filter(s => s.startsWith(':'))
    .map(s => ({ name: s.slice(1), type: 'string', required: true, notes: '' }))
}

function renderFields(fields: Field[]): string {
  if (fields.length === 0) return chalk.dim('  (none)')
  return renderTable(fields, [
    { header: '  NAME', value: f => `  ${f.name}` },
    { header: 'TYPE', value: f => f.type },
    { header: 'REQUIRED', value: f => (f.required ? 'yes' : 'no') },
    { header: 'NOTES', value: f => [f.notes, f.description].filter(Boolean).join(' · ') || '' },
  ])
}

function schemaSection(
  title: string,
  schema: CatalogBody | undefined,
  zodRef?: string,
  optional?: boolean
): string[] {
  if (!schema) return []
  const via = zodRef ? `  ${chalk.dim(`validated locally with ${zodRef}`)}` : ''
  const heading = `${chalk.bold(title)}${optional ? chalk.dim(' (optional)') : ''}${via}`
  if (isMultipart(schema))
    return [
      `${chalk.bold(title)}  multipart/form-data — fields: ${schema.fields.join(', ') || '(none read)'}`,
    ]
  if (isRaw(schema)) return [`${chalk.bold(title)}  raw bytes, no schema: ${schema.reason}`]
  if (isByParam(schema))
    return [
      heading,
      ...Object.entries(schema.variants).flatMap(([value, variant]) => [
        `  ${chalk.bold(`when :${schema.byParam} = ${value}`)}`,
        renderFields(fieldsOf(variant)),
      ]),
    ]
  const plain = schema as JsonSchema
  if (plain.unvalidated)
    return [
      `${chalk.bold(title)}  ${chalk.yellow('read without a schema — see the source for its shape')}`,
    ]
  if (plain.unresolved)
    return [`${chalk.bold(title)}  ${chalk.yellow(`not resolvable: ${plain.unresolved}`)}`]
  return [heading, renderFields(fieldsOf(plain))]
}

/** `/api/apps/:id/sessions` → `/api/apps/<id>/sessions` (or the concrete path the caller gave). */
const fillPath = (pattern: string) => pattern.replace(/:(\w+)/g, '<$1>')

export function callLine(route: CatalogRoute, path = fillPath(route.path)): string {
  const parts = ['launch api call', route.method, path]
  if (isSchema(route.body)) parts.push(`--data '${JSON.stringify(exampleOf(route.body))}'`)
  if (isSchema(route.query)) {
    const first = Object.keys(route.query.properties ?? {})[0]
    if (first) parts.push(`--query ${first}=…`)
  }
  return parts.join(' ')
}

const cliCell = (route: CatalogRoute) =>
  route.cli?.length ? `✓ ${route.cli.join(', ')}` : 'launch api call'

export interface ApiLsOptions {
  method?: string
}

export async function runApiLs(
  ctx: CommandContext,
  filter: string | undefined,
  options: ApiLsOptions = {},
  catalog: ApiCatalog = API_CATALOG
): Promise<void> {
  const method = options.method ? parseMethod(options.method) : undefined
  const needle = filter?.toLowerCase()
  const routes = catalog.routes.filter(
    r =>
      (!method || r.method === method) &&
      (!needle || r.path.toLowerCase().includes(needle) || r.summary.toLowerCase().includes(needle))
  )
  ctx.out.data(routes, () =>
    [
      renderTable(routes, [
        { header: 'METHOD', value: r => r.method },
        { header: 'PATH', value: r => r.path },
        {
          header: 'SUMMARY',
          value: r => (r.summary.length > 70 ? `${r.summary.slice(0, 69)}…` : r.summary),
        },
        { header: 'CLI', value: cliCell },
      ]),
      chalk.dim(`${routes.length} route(s) · \`${ctx.binName} api show <METHOD> <path>\` for one`),
    ].join('\n')
  )
}

export async function runApiShow(
  ctx: CommandContext,
  methodArg: string,
  path: string,
  catalog: ApiCatalog = API_CATALOG
): Promise<void> {
  const method = parseMethod(methodArg)
  const route = matchRoute(catalog, method, path)
  if (!route)
    throw new CliError(`No route ${method} ${path} in the catalog`, {
      hint: `Find one with \`${ctx.binName} api ls <word>\`.`,
    })
  ctx.out.data(route, () => {
    const lines = [chalk.bold(`${route.method} ${route.path}`)]
    lines.push(route.summary ? `  ${route.summary}` : chalk.dim('  (no summary comment yet)'))
    if (route.description) lines.push('', ...route.description.split('\n').map(l => `  ${l}`))
    lines.push('', `${chalk.bold('Auth')}    ${AUTH_WORDS[route.auth] ?? route.auth}`)
    if (route.source) lines.push(`${chalk.bold('Source')}  ${route.source}`)
    const paramsVia = route.zod?.params
      ? `  ${chalk.dim(`validated locally with ${route.zod.params}`)}`
      : ''
    lines.push('', `${chalk.bold('Path params')}${paramsVia}`, renderFields(paramFields(route)))
    for (const [title, schema, ref, optional] of [
      ['Query', route.query, route.zod?.query, false],
      ['Body (JSON)', route.body, route.zod?.body, route.bodyOptional],
    ] as const) {
      const section = schemaSection(title, schema, ref, optional)
      if (section.length) lines.push('', ...section)
    }
    if (!route.body && ['POST', 'PUT', 'PATCH'].includes(route.method))
      lines.push('', `${chalk.bold('Body')}  ${chalk.dim('none — the route reads no body')}`)
    if (isSchema(route.body))
      lines.push(
        '',
        chalk.bold('Example body'),
        ...formatJson(exampleOf(route.body))
          .split('\n')
          .map(l => `  ${l}`)
      )
    if (route.response)
      lines.push(
        '',
        `${chalk.bold('Response')}  ${chalk.dim(route.zod?.response ?? '')}`,
        renderFields(fieldsOf(route.response))
      )
    const concrete = path === route.path ? undefined : path
    lines.push('')
    if (route.cli?.length)
      lines.push(
        `${chalk.bold('CLI')}     ${route.cli.join(', ')} — \`${ctx.binName} commands\` lists the commands`
      )
    else if (route.cliExcluded)
      lines.push(`${chalk.bold('CLI')}     none by design: ${route.cliExcluded}`)
    lines.push(`${chalk.bold('Call')}    ${callLine(route, concrete)}`)
    return lines.join('\n')
  })
}

export async function runApiSchema(
  ctx: CommandContext,
  methodArg: string,
  path: string,
  catalog: ApiCatalog = API_CATALOG
): Promise<void> {
  const method = parseMethod(methodArg)
  const route = matchRoute(catalog, method, path)
  if (!route)
    throw new CliError(`No route ${method} ${path} in the catalog`, {
      hint: `Find one with \`${ctx.binName} api ls <word>\`.`,
    })
  const schema = {
    method: route.method,
    path: route.path,
    ...(route.params ? { params: route.params } : {}),
    ...(route.query ? { query: route.query } : {}),
    ...(route.body ? { body: route.body } : {}),
    ...(route.bodyOptional ? { bodyOptional: true } : {}),
    ...(route.response ? { response: route.response } : {}),
    ...(route.zod ? { zod: route.zod } : {}),
  }
  ctx.out.data(schema, () => formatJson(schema))
}

export interface ApiCallOptions {
  data?: string
  query?: string[]
  raw?: boolean
  /** `--no-validate`: send without checking against the route's schemas. */
  validate?: boolean
  /** Injected for tests: the whole of stdin (`--data -`). */
  readStdin?: () => Promise<string>
  /** Injected for tests: read `--data @file`. */
  readFile?: (path: string) => Promise<string>
  catalog?: ApiCatalog
  /** Injected for tests: the zod registry (default: the generated `API_SCHEMAS`). */
  schemas?: Readonly<Record<string, ApiSchemaEntry>>
}

function parseQuery(pairs: string[] = []): Record<string, QueryValue[]> {
  const out: Record<string, QueryValue[]> = {}
  for (const pair of pairs) {
    const eq = pair.indexOf('=')
    if (eq < 1) throw new CliError(`--query ${pair} is not key=value`)
    const key = pair.slice(0, eq)
    out[key] = [...(out[key] ?? []), pair.slice(eq + 1)]
  }
  return out
}

/** The path params a concrete path gives a pattern (`undefined` for a pattern segment left as is). */
export function pathParams(pattern: string, path: string): Record<string, string> | undefined {
  const have = segments(pattern)
  const want = segments(path)
  const out: Record<string, string> = {}
  for (let i = 0; i < have.length; i++) {
    const p = have[i] as string
    if (!p.startsWith(':')) continue
    const value = want[i] ?? ''
    if (value.startsWith(':') || /^<.*>$/.test(value)) return undefined
    out[p.slice(1)] = decodeURIComponent(value)
  }
  return out
}

export interface RequestIssue {
  /** Where: the path params, `--query` or `--data`. */
  in: 'params' | 'query' | 'body'
  path: (string | number)[]
  message: string
}

const issuesOf = (where: RequestIssue['in'], issues: readonly ZodIssue[]): RequestIssue[] =>
  issues.map(i => ({ in: where, path: [...i.path], message: i.message }))

function check(where: RequestIssue['in'], schema: ZodTypeAny, value: unknown): RequestIssue[] {
  const parsed = schema.safeParse(value)
  return parsed.success ? [] : issuesOf(where, parsed.error.issues)
}

/**
 * Every issue the route's own schemas find in a request, the way the server would see it: the
 * path's params, the query (one value → a string, repeated → an array, as Hono hands it to zod),
 * and the body — `{}` when none is given, which is what `validate('json')` checks then.
 */
export function requestIssues(
  route: CatalogRoute,
  entry: ApiSchemaEntry | undefined,
  input: { path: string; query: Record<string, QueryValue[]>; body: unknown }
): RequestIssue[] {
  const out: RequestIssue[] = []
  const params = pathParams(route.path, input.path)
  if (entry?.params && params) out.push(...check('params', entry.params, params))
  if (entry?.query) {
    const query = Object.fromEntries(
      Object.entries(input.query).map(([k, v]) => [
        k,
        v.length === 1 ? String(v[0]) : v.map(String),
      ])
    )
    out.push(...check('query', entry.query, query))
  }
  const given = input.body !== undefined
  if (isMultipart(route.body))
    out.push({
      in: 'body',
      path: [],
      message: `this route takes multipart/form-data (fields: ${route.body.fields.join(', ')}), which \`api call\` does not send${route.cli?.length ? ` — use the command in ${route.cli.join(', ')}` : ''}`,
    })
  else if (isRaw(route.body)) {
    // Raw bytes with no schema (the webhook): nothing to check.
  } else if (entry?.bodyByParam) {
    const key = params?.[entry.bodyByParam.param]
    const schema = key === undefined ? undefined : entry.bodyByParam.schemas[key]
    // The route parses `await c.req.json().catch(() => null)`: no body is `null`.
    if (schema) out.push(...check('body', schema, given ? input.body : null))
  } else if (entry?.body) {
    if (given || !entry.bodyOptional)
      out.push(...check('body', entry.body, given ? input.body : {}))
  } else if (given && !route.body)
    out.push({ in: 'body', path: [], message: 'this route reads no body' })
  return out
}

const WHERE: Record<RequestIssue['in'], string> = {
  params: 'path',
  query: '--query',
  body: '--data',
}

/** `--data title: Required` — one line per issue. Pure. */
export function requestIssueLines(issues: readonly RequestIssue[]): string[] {
  return issues.map(
    i => `${WHERE[i.in]}${i.path.length ? ` ${i.path.join('.')}` : ''}: ${i.message}`
  )
}

async function loadSchemas(): Promise<Readonly<Record<string, ApiSchemaEntry>>> {
  return (await import('../generated/api-schemas')).API_SCHEMAS
}

export async function runApiCall(
  ctx: CommandContext,
  methodArg: string,
  path: string,
  options: ApiCallOptions = {}
): Promise<void> {
  const method = parseMethod(methodArg)
  if (!path.startsWith('/')) throw new CliError(`The path must start with /: ${path}`)
  const body = options.data === undefined ? undefined : await readDataArg(options.data, options)
  const query = parseQuery(options.query)
  const route = matchRoute(options.catalog ?? API_CATALOG, method, path)
  if (!route) ctx.log.warn(`${method} ${path} is not in this CLI's catalog — sending it unchecked.`)
  else if (options.validate !== false) {
    const schemas = options.schemas ?? (await loadSchemas())
    const issues = requestIssues(route, schemas[`${route.method} ${route.path}`], {
      path,
      query,
      body,
    })
    if (issues.length) {
      if (ctx.json)
        ctx.out.data(
          { error: 'Invalid request', code: 'validation_failed', details: issues },
          () => ''
        )
      throw new CliError(
        `Invalid request for ${route.method} ${route.path}:\n  ${requestIssueLines(issues).join('\n  ')}`,
        {
          hint: `Nothing was sent. \`${ctx.binName} api show ${route.method} ${route.path}\` lists what it takes; --no-validate sends it anyway.`,
        }
      )
    }
  }
  const client = requireClient(ctx)
  let response: Awaited<ReturnType<typeof client.raw>>
  try {
    response = await client.raw(method, path, { body, query })
  } catch (error) {
    // The server's envelope, `details` included, is the useful part of a refusal: print it whole.
    if (error instanceof CliApiError && error.body !== undefined)
      ctx.out.data(error.body, () =>
        typeof error.body === 'string' ? error.body : formatJson(error.body)
      )
    throw error
  }
  ctx.log.debug(`HTTP ${response.status} ${response.contentType ?? ''}`)
  if (response.text === '') {
    ctx.log.info(`HTTP ${response.status} (no body)`)
    return
  }
  let parsed: unknown = response.text
  try {
    parsed = JSON.parse(response.text)
  } catch {
    // Not JSON — printed as text.
  }
  ctx.out.data(parsed, () =>
    options.raw || typeof parsed === 'string'
      ? response.text.replace(/\n$/, '')
      : formatJson(parsed)
  )
}

const collect = (value: string, previous: string[] = []) => [...previous, value]

export function registerApiCommands(program: Command, action: ActionWrapper): void {
  const api = program
    .command('api')
    .description('the server API: find a route, see the JSON it takes, call any route')
  api
    .command('ls [filter]')
    .description('list API routes (filter matches the path or the summary)')
    .option('--method <method>', 'only this method: GET, POST, PUT, PATCH or DELETE')
    .action(action((ctx, cmd) => runApiLs(ctx, cmd.args[0], cmd.opts())))
  api
    .command('show <method> <path>')
    .description('what a route does and takes — <path> may be a pattern or a concrete path')
    .action(action((ctx, cmd) => runApiShow(ctx, cmd.args[0] ?? '', cmd.args[1] ?? '')))
  api
    .command('schema <method> <path>')
    .description('the full JSON Schema of a route: params, query, body and response')
    .action(action((ctx, cmd) => runApiSchema(ctx, cmd.args[0] ?? '', cmd.args[1] ?? '')))
  api
    .command('call <method> <path>')
    .description('call any route with the active server’s key and print the response')
    .option('--data <json|@file|->', 'the JSON body: inline, @file, or - for stdin')
    .option('--query <key=value>', 'a query parameter (repeatable)', collect)
    .option('--raw', 'print the response body exactly as sent')
    .option('--no-validate', 'send without checking params, --query and --data against the route')
    .action(action((ctx, cmd) => runApiCall(ctx, cmd.args[0] ?? '', cmd.args[1] ?? '', cmd.opts())))
  registerCommandsCommand(program, action)
}
