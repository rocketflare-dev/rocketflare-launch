/**
 * The API catalog (issue #6): every route in the CLI-parity scope (`/api/*`, `/cubejs-api*`,
 * `/mcp`) with its one-line summary, what it takes (params, query, body as JSON Schema), what it
 * returns when that is pairable, who may call it and which `launch` command covers it. Written by
 * `pnpm api:catalog` to two committed files the CLI reads:
 *
 * - `apps/cli/src/generated/api-catalog.json` — the human/agent-readable half (`launch api ls|show|
 *   schema`): JSON Schema rendered with zod-to-json-schema, plus `zod: { body: '<module>#<export>' }`
 *   naming the `@launch/shared` export each one came from;
 * - `apps/cli/src/generated/api-schemas.ts` — `API_SCHEMAS`, the SAME zod objects the server
 *   validates with, imported from `@launch/shared/<module>`, so `launch api call` validates a body
 *   exactly as the route will before sending it.
 *
 * How a full path finds its source — by HANDLER IDENTITY, never by re-deriving mount prefixes:
 *
 * 1. Every route module (`src/api/routes/**`, `src/plugins/<id>/api/routes/*`) is imported, and each
 *    exported Hono router's `.routes` (method, local path, handler) is read. A handler composed into
 *    a parent (`appsRouter.route('/', appSessionsRouter)`) appears in both; its ORIGIN is the router
 *    with the fewest routes that holds it — a composing router holds everything its child does.
 * 2. Each router's own entries, grouped by consecutive method + path (one registration's
 *    `validate(...)` middleware and handler are separate entries), are paired in order with the
 *    registrations parsed out of the file's source on that router's identifier.
 * 3. `app.routes` (the assembled app) holds the very same handler functions under their FULL path,
 *    so each in-scope `METHOD /full/path` looks its handlers up and finds its registration.
 *
 * From the registration's source: `summary`/`description` are the doc comment directly above it;
 * `params`/`query`/`body` are the identifiers given to `validate('param'|'query'|'json', X)`,
 * resolved through the file's imports to a zod object, and that object is found BY IDENTITY among
 * the exports of every `packages/shared/src` module — so a schema re-exported through a service or
 * a barrel still names the module that defines it. One that is not an `@launch/shared` export
 * (local to the route, inline, not zod) is a VIOLATION (contracts first).
 *
 * The body rule: a route that reads its body — `c.req.json|parseBody|text|arrayBuffer|formData|
 * blob()` or the raw request's body, in the registration or in a same-file helper it calls — must
 * either `validate('json', …)` it, read multipart form data (recorded as `{ multipart, fields }`),
 * or be listed in `api-catalog-manual-bodies.ts` with the reason it parses by hand. Every other
 * route is bodiless. A violation names the route.
 *
 * Responses are best-effort: `c.json(x satisfies XResponse)`, `c.json<XResponse>(…)` or
 * `c.json(body)` with `const body: XResponse` pair with an `xResponseSchema` export of
 * `@launch/shared`; nothing is refactored to make one pairable.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import type { Hono } from 'hono'
import type { ZodTypeAny } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import { app } from '@/api/index'
import { serverPlugins } from '@/plugins/server'
import { MANUAL_BODIES } from './api-catalog-manual-bodies'
import {
  callShape,
  cliCallSites,
  excluded,
  inScope,
  METHODS,
  normalisePath,
} from './cli-parity-lib'

const WEB_ROOT = path.resolve(__dirname, '../..')
const REPO_ROOT = path.resolve(WEB_ROOT, '../..')
const SHARED_SRC = path.join(REPO_ROOT, 'packages/shared/src')
export const CATALOG_PATH = path.join(REPO_ROOT, 'apps/cli/src/generated/api-catalog.json')
export const REGISTRY_PATH = path.join(REPO_ROOT, 'apps/cli/src/generated/api-schemas.ts')

const DESCRIPTION_MAX = 600

export type JsonSchema = Record<string, unknown>
/** A body read as multipart form data: the field names the handler reads, in order. */
export type MultipartBody = { multipart: true; fields: string[] }
/** A body whose schema depends on a path param (`credentialPayloadSchemas[kind]`). */
export type ByParamBody = { byParam: string; variants: Record<string, JsonSchema> }
/** A body read as raw bytes (the webhook's signature) — no schema; `reason` says why. */
export type RawBody = { raw: true; reason: string }
export type CatalogBody = JsonSchema | MultipartBody | ByParamBody | RawBody

/** `<module>#<export>` — e.g. `@launch/shared/launch-sessions#createSessionRequestSchema`. */
export type ZodRef = string

export interface CatalogRoute {
  method: string
  path: string
  summary: string
  description?: string
  /** Coarse, from the mount: `public` · `signed-in` · `platform-admin` · `global-admin`. */
  auth: 'public' | 'signed-in' | 'platform-admin' | 'global-admin'
  params?: JsonSchema
  query?: JsonSchema
  body?: CatalogBody
  /** The body may be omitted entirely (a hand-parsed optional body). */
  bodyOptional?: true
  /** The success body, when the handler's response type pairs with a shared schema. */
  response?: JsonSchema
  /** The `@launch/shared` export each schema above is (the registry imports the same object). */
  zod?: { params?: ZodRef; query?: ZodRef; body?: ZodRef; response?: ZodRef }
  /** The route's source file, relative to the repository root. */
  source?: string
  /** CLI files (relative to `apps/cli/src`) that call it. */
  cli?: string[]
  /** Why the CLI deliberately does not call it (`cli-parity-exclusions.ts`). */
  cliExcluded?: string
}

export interface ApiCatalog {
  $comment: string
  routes: CatalogRoute[]
}

export interface CatalogBuild {
  catalog: ApiCatalog
  /** The source of `apps/cli/src/generated/api-schemas.ts`. */
  registry: string
  /** `METHOD /path: why` — a schema that is not an `@launch/shared` export (contracts first). */
  schemaViolations: string[]
  /** `METHOD /path: why` — a body read without `validate('json')`, multipart or an allowlist entry. */
  bodyViolations: string[]
  /** `MANUAL_BODIES` keys no route needs any more. */
  staleManualBodies: string[]
}

// ---- source scanning ------------------------------------------------------------------------

function walk(dir: string): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap(name => {
      const p = path.join(dir, name)
      return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []
    })
}

/** Route modules: the kit's routes (incl. `auth/`) and every plugin's `api/routes`. */
export function routeFiles(): string[] {
  const kit = walk(path.join(WEB_ROOT, 'src/api/routes'))
  const pluginsDir = path.join(WEB_ROOT, 'src/plugins')
  const plugins = readdirSync(pluginsDir)
    .sort()
    .map(id => path.join(pluginsDir, id, 'api/routes'))
    .filter(dir => {
      try {
        return statSync(dir).isDirectory()
      } catch {
        return false
      }
    })
    .flatMap(walk)
  return [...kit, ...plugins].filter(f => !f.endsWith('.test.ts'))
}

const REGEX_PREV = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-'])

/**
 * Index just past the code that starts at `i` and runs until `closer` at depth 0 (the closer's own
 * index is returned). Skips strings, templates (with nested `${}`), comments and regex literals.
 * `commas` collects the depth-0 comma positions.
 */
function scanCode(src: string, i: number, closer: string, commas?: number[]): number {
  const stack: string[] = []
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' }
  let prev = '('
  while (i < src.length) {
    const ch = src[i] as string
    const next = src[i + 1]
    if (ch === '/' && next === '/') {
      i = src.indexOf('\n', i)
      if (i < 0) return src.length
      continue
    }
    if (ch === '/' && next === '*') {
      i = src.indexOf('*/', i + 2) + 2
      continue
    }
    if (ch === "'" || ch === '"') {
      i = skipString(src, i + 1, ch)
      prev = 'x'
      continue
    }
    if (ch === '`') {
      i = skipTemplate(src, i + 1)
      prev = 'x'
      continue
    }
    if (ch === '/' && REGEX_PREV.has(prev)) {
      i = skipRegex(src, i + 1)
      prev = 'x'
      continue
    }
    if (stack.length === 0 && ch === closer) return i
    if (ch in pairs) stack.push(pairs[ch] as string)
    else if (ch === ')' || ch === ']' || ch === '}') stack.pop()
    else if (ch === ',' && stack.length === 0) commas?.push(i)
    if (!/\s/.test(ch)) prev = ch
    i++
  }
  return i
}

function skipString(src: string, i: number, quote: string): number {
  while (i < src.length && src[i] !== quote) i += src[i] === '\\' ? 2 : 1
  return i + 1
}

function skipTemplate(src: string, i: number): number {
  while (i < src.length) {
    if (src[i] === '\\') i += 2
    else if (src[i] === '`') return i + 1
    else if (src[i] === '$' && src[i + 1] === '{') i = scanCode(src, i + 2, '}') + 1
    else i++
  }
  return i
}

function skipRegex(src: string, i: number): number {
  let inClass = false
  while (i < src.length) {
    const ch = src[i]
    if (ch === '\\') i += 2
    else if (ch === '\n') return i
    else if (inClass) {
      if (ch === ']') inClass = false
      i++
    } else if (ch === '[') {
      inClass = true
      i++
    } else if (ch === '/') {
      i++
      while (/[a-z]/i.test(src[i] ?? '')) i++
      return i
    } else i++
  }
  return i
}

export interface Registration {
  file: string
  router: string
  method: string
  path: string
  /** Every argument but the first, as source text; the last is the handler. */
  args: string[]
  comment: string
}

/** The doc comment directly above `start`: a block comment, or consecutive `//` lines. */
function commentAbove(src: string, start: number): string {
  const before = src.slice(0, start).replace(/[ \t]*$/, '')
  if (!before.endsWith('\n')) return ''
  const text = before.replace(/\s+$/, '')
  // A blank line between the comment and the registration detaches it.
  if (/\n[ \t]*\n[ \t]*$/.test(before)) return ''
  if (text.endsWith('*/')) {
    const open = text.lastIndexOf('/*')
    return text
      .slice(open + 2, -2)
      .replace(/^\*/, '')
      .split('\n')
      .map(l => l.replace(/^\s*\* ?/, '').trimEnd())
      .join('\n')
      .trim()
  }
  const lines = text.split('\n')
  const out: string[] = []
  for (let k = lines.length - 1; k >= 0; k--) {
    const m = /^\s*\/\/ ?(.*)$/.exec(lines[k] as string)
    if (!m) break
    out.unshift(m[1] as string)
  }
  return out.join('\n').trim()
}

/** `src` with every comment replaced by spaces (newlines kept), so indexes still line up. */
export function blankComments(src: string): string {
  let out = ''
  let i = 0
  while (i < src.length) {
    const ch = src[i] as string
    const next = src[i + 1]
    let end = i + 1
    if (ch === '/' && next === '/') {
      end = src.indexOf('\n', i)
      if (end < 0) end = src.length
      out += ' '.repeat(end - i)
      i = end
      continue
    }
    if (ch === '/' && next === '*') {
      end = src.indexOf('*/', i + 2)
      end = end < 0 ? src.length : end + 2
      out += src.slice(i, end).replace(/[^\n]/g, ' ')
      i = end
      continue
    }
    if (ch === "'" || ch === '"') end = skipString(src, i + 1, ch)
    else if (ch === '`') end = skipTemplate(src, i + 1)
    out += src.slice(i, end)
    i = end
  }
  return out
}

/** The route registrations in a file's source, in order, on the routers the file creates. */
export function parseRegistrations(file: string, src: string): Registration[] {
  const routers = new Set<string>()
  for (const m of src.matchAll(/\bconst\s+(\w+)\s*(?::[^=]+)?=\s*(?:createRouter\(|new Hono\b)/g))
    routers.add(m[1] as string)
  const out: Registration[] = []
  const re = /^([ \t]*)(\w+)\.(get|post|put|patch|delete)\(/gm
  // Matched on the source with its comments blanked: an example in a comment is not a route.
  for (const m of blankComments(src).matchAll(re)) {
    const router = m[2] as string
    if (!routers.has(router)) continue
    const start = (m.index ?? 0) + (m[1] as string).length
    const open = (m.index ?? 0) + m[0].length
    const commas: number[] = []
    const close = scanCode(src, open, ')', commas)
    const bounds = [open - 1, ...commas, close]
    const args = bounds.slice(1).map((end, k) => src.slice((bounds[k] as number) + 1, end).trim())
    const first = /^(['"`])([^'"`$]*)\1$/.exec(args[0] ?? '')
    if (!first) continue
    out.push({
      file,
      router,
      method: (m[3] as string).toUpperCase(),
      path: normalisePath(first[2] as string),
      args: args.slice(1).filter(a => a !== ''),
      comment: commentAbove(src, start),
    })
  }
  return out
}

/** `{ local: { spec, name } }` for every named import in the file. */
function importsOf(src: string): Map<string, { spec: string; name: string }> {
  const out = new Map<string, { spec: string; name: string }>()
  for (const m of src.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    for (const part of (m[1] as string).split(',')) {
      const t = part
        .trim()
        .replace(/^type\s+/, '')
        .trim()
      if (!t) continue
      const [name, local] = t.split(/\s+as\s+/) as [string, string?]
      out.set((local ?? name).trim(), { spec: m[2] as string, name: name.trim() })
    }
  }
  return out
}

// ---- the @launch/shared export index ----------------------------------------------------------

interface SharedRef {
  module: string
  name: string
  /** The module declares it (`export const name`), rather than re-exporting it. */
  defines: boolean
  barrel: boolean
  value: unknown
}

const refString = (r: SharedRef): ZodRef => `${r.module}#${r.name}`

/** `ai/chat.ts` → `@launch/shared/ai/chat`, honouring the package's explicit exports. */
export function sharedSpecifier(rel: string): string {
  const posix = rel.split(path.sep).join('/')
  if (posix === 'index.ts') return '@launch/shared'
  if (posix === 'ai/index.ts') return '@launch/shared/ai'
  if (posix === 'plugins/index.ts') return '@launch/shared/plugins'
  if (posix === 'plugins/api.ts') return '@launch/shared/plugin-api'
  return `@launch/shared/${posix.replace(/\.ts$/, '')}`
}

/**
 * A plugin's shared half is reached only through its entry, `@launch/shared/plugins/<id>/index`
 * (D31, `plugins.test.ts`): every other module under it is private.
 */
const isPluginPrivate = (module: string) =>
  /^@launch\/shared\/plugins\/[^/]+\/(?!index$)/.test(module)

/**
 * Better first: importable (not a plugin's private module), the module that declares it, not a
 * barrel, the shortest specifier, then by name.
 */
function preferRef(a: SharedRef, b: SharedRef): number {
  return (
    Number(isPluginPrivate(a.module)) - Number(isPluginPrivate(b.module)) ||
    Number(b.defines) - Number(a.defines) ||
    Number(a.barrel) - Number(b.barrel) ||
    a.module.length - b.module.length ||
    a.module.localeCompare(b.module) ||
    a.name.localeCompare(b.name)
  )
}

interface SharedIndex {
  /** Every exported object (zod schema, or a record of them) → where it is best imported from. */
  byValue: Map<unknown, SharedRef>
  /** Every export name → each module exporting it, best first. */
  byName: Map<string, SharedRef[]>
}

async function sharedIndex(): Promise<SharedIndex> {
  const all = new Map<unknown, SharedRef[]>()
  const byName = new Map<string, SharedRef[]>()
  for (const file of walk(SHARED_SRC)) {
    const rel = path.relative(SHARED_SRC, file)
    const module = sharedSpecifier(rel)
    const src = readFileSync(file, 'utf8')
    const mod = (await import(/* @vite-ignore */ module)) as Record<string, unknown>
    for (const [name, value] of Object.entries(mod)) {
      if (typeof value !== 'object' || value === null) continue
      const ref: SharedRef = {
        module,
        name,
        defines: new RegExp(`\\bexport\\s+const\\s+${name}\\b`).test(src),
        barrel: path.basename(rel) === 'index.ts' || rel === 'plugins/api.ts',
        value,
      }
      all.set(value, [...(all.get(value) ?? []), ref])
      byName.set(name, [...(byName.get(name) ?? []), ref])
    }
  }
  const byValue = new Map<unknown, SharedRef>()
  for (const [value, refs] of all) byValue.set(value, refs.sort(preferRef)[0] as SharedRef)
  for (const refs of byName.values()) refs.sort(preferRef)
  return { byValue, byName }
}

// ---- schemas --------------------------------------------------------------------------------

function isZod(value: unknown): value is ZodTypeAny {
  return typeof value === 'object' && value !== null && '_def' in value && 'safeParse' in value
}

export function toJsonSchema(schema: ZodTypeAny): JsonSchema {
  const json = zodToJsonSchema(schema, {
    $refStrategy: 'none',
    target: 'jsonSchema7',
  }) as JsonSchema
  delete json.$schema
  return json
}

type Resolved = { ok: true; value: unknown; ref: SharedRef } | { ok: false; why: string }

/** An identifier in a route file → the object it names → the `@launch/shared` export it is. */
async function resolveIdent(
  expr: string,
  file: string,
  src: string,
  mod: Record<string, unknown>,
  shared: SharedIndex
): Promise<Resolved> {
  const rel = path.relative(REPO_ROOT, file)
  if (!/^[A-Za-z_$][\w$]*$/.test(expr)) return { ok: false, why: `\`${expr}\` is inline` }
  const imported = importsOf(src).get(expr)
  let value: unknown
  if (imported) {
    const spec = imported.spec.startsWith('.')
      ? path.resolve(path.dirname(file), imported.spec)
      : imported.spec
    value = (await import(/* @vite-ignore */ spec))[imported.name]
  } else value = mod[expr]
  if (value === undefined) return { ok: false, why: `\`${expr}\` is local to ${rel}` }
  const ref = shared.byValue.get(value)
  if (!ref) return { ok: false, why: `\`${expr}\` is not an export of @launch/shared` }
  return { ok: true, value, ref }
}

// ---- reading the handler's source ---------------------------------------------------------------

export const BODY_READ =
  /\bc\.req\.(?:json|parseBody|text|arrayBuffer|formData|blob)\s*\(|\.req\.raw\.(?:body|json|text|arrayBuffer|formData|blob|clone)\b|\bfetch\(\s*c\.req\.raw\b/
const MULTIPART_READ = /\bc\.req\.(?:formData|parseBody)\s*\(/
const FORM_FIELD = /\b(?:form\??\.(?:get|getAll)\(\s*|\w+Field\(\s*form\s*,\s*)'([\w-]+)'/g

/**
 * The file's top-level functions (`function f(` / `const f = (…) =>`), each with its text up to
 * the next top-level statement — enough to see what a helper the handler calls reads.
 */
function topLevelFunctions(src: string): Map<string, string> {
  const out = new Map<string, string>()
  const re =
    /^(?:export\s+)?(?:async\s+function\s*\*?\s*(\w+)|function\s*\*?\s*(\w+)|const\s+(\w+)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*(?::[^=]+)?=>)/gm
  for (const m of src.matchAll(re)) {
    const name = (m[1] ?? m[2] ?? m[3]) as string
    const start = m.index ?? 0
    const rest = src.slice(start + m[0].length)
    const next = /\n(?=[^\s})\]])/.exec(rest)
    out.set(name, src.slice(start, start + m[0].length + (next ? next.index : rest.length)))
  }
  return out
}

/** The helpers (by name) whose text — or a helper they call — matches `re`. */
function helpersMatching(fns: Map<string, string>, re: RegExp): Set<string> {
  const hit = new Set([...fns].filter(([, text]) => re.test(text)).map(([name]) => name))
  for (let changed = true; changed; ) {
    changed = false
    for (const [name, text] of fns) {
      if (hit.has(name)) continue
      if ([...hit].some(h => new RegExp(`(?<![\\w.])${h}\\(`).test(text))) {
        hit.add(name)
        changed = true
      }
    }
  }
  return hit
}

/** The registration's own text plus every same-file helper it calls (transitively). */
function reachableText(reg: Registration, fns: Map<string, string>): string {
  const seen = new Set<string>()
  const texts = [reg.args.join(',\n')]
  for (let k = 0; k < texts.length; k++) {
    for (const [name, text] of fns) {
      if (seen.has(name)) continue
      if (new RegExp(`(?<![\\w.])${name}\\(`).test(texts[k] as string)) {
        seen.add(name)
        texts.push(text)
      }
    }
  }
  return texts.join('\n')
}

/** Each `c.json(` call's first argument, as source text. */
function jsonCallArgs(text: string): { arg: string; typeArg?: string }[] {
  const out: { arg: string; typeArg?: string }[] = []
  for (const m of text.matchAll(/\bc\.json\s*(?:<\s*([A-Z]\w*)\s*>)?\s*\(/g)) {
    const open = (m.index ?? 0) + m[0].length
    const commas: number[] = []
    const close = scanCode(text, open, ')', commas)
    const arg = text.slice(open, commas[0] ?? close).trim()
    out.push(m[1] ? { arg, typeArg: m[1] } : { arg })
  }
  return out
}

/** The response type names a handler states for its whole `c.json(…)` body. */
function responseTypes(handler: string): string[] {
  const typed = new Map<string, string>()
  for (const m of handler.matchAll(/\b(?:const|let)\s+(\w+)\s*:\s*([A-Z]\w*)\s*=/g))
    typed.set(m[1] as string, m[2] as string)
  const out = new Set<string>()
  for (const { arg, typeArg } of jsonCallArgs(handler)) {
    if (typeArg) out.add(typeArg)
    const sat = /\bsatisfies\s+([A-Z]\w*)\s*$/.exec(arg)
    // Only a `satisfies` at the argument's top level types the whole body.
    if (sat) {
      const head = arg.slice(0, sat.index)
      const opens = (head.match(/[({[]/g) ?? []).length
      const closes = (head.match(/[)}\]]/g) ?? []).length
      if (opens === closes) out.add(sat[1] as string)
    }
    const ident = /^(\w+)$/.exec(arg)?.[1]
    if (ident && typed.has(ident)) out.add(typed.get(ident) as string)
  }
  return [...out]
}

const schemaNameOf = (type: string) => `${type[0]?.toLowerCase()}${type.slice(1)}Schema`

/** `XResponse` → the `xResponseSchema` export, from the module the type came from when shared. */
function pairResponse(type: string, src: string, shared: SharedIndex): SharedRef | undefined {
  const refs = shared.byName.get(schemaNameOf(type))
  if (!refs?.length) return undefined
  const spec = importsOf(src).get(type)?.spec
  const definers = refs.filter(r => r.defines)
  const pick =
    refs.find(r => r.module === spec) ?? (definers.length === 1 ? definers[0] : undefined)
  // The same object, from where it is best imported (a plugin's entry, not its private module).
  return pick && shared.byValue.get(pick.value)
}

// ---- the join ---------------------------------------------------------------------------------

type AnyHono = Hono<any, any, any>
type HonoRoute = { method: string; path: string; handler: unknown }

function isHono(value: unknown): value is AnyHono {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { routes?: unknown }).routes) &&
    typeof (value as { fetch?: unknown }).fetch === 'function'
  )
}

/** A handler re-wrapped by `route()` when the child has its own `onError` keeps the original. */
const unwrap = (h: unknown) =>
  ((h as Record<string, unknown> | null)?.__COMPOSED_HANDLER as unknown) ?? h

function summarise(comment: string): { summary: string; description?: string } {
  if (!comment) return { summary: '' }
  const paragraphs = comment.split(/\n\s*\n/)
  const first = (paragraphs[0] as string).replace(/\s+/g, ' ').trim()
  // The first sentence: a period followed by a space and a capital, backtick or end of paragraph.
  const m = /^(.+?[.!?])(?=\s+[A-Z`(]|$)/.exec(first)
  const summary = (m ? (m[1] as string) : first).trim()
  let rest = [first.slice(summary.length).trim(), ...paragraphs.slice(1).map(p => p.trim())]
    .filter(Boolean)
    .join('\n\n')
    .trim()
  if (rest.length > DESCRIPTION_MAX) rest = `${rest.slice(0, DESCRIPTION_MAX - 1).trimEnd()}…`
  return rest ? { summary, description: rest } : { summary }
}

const METHOD_ORDER = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']

/** One registry entry: field → the `@launch/shared` export (by ref). */
type RegistryEntry = {
  params?: SharedRef
  query?: SharedRef
  body?: SharedRef
  bodyByParam?: { param: string; schemas: SharedRef }
  bodyOptional?: true
  multipart?: string[]
  response?: SharedRef
}

export async function buildCatalog(): Promise<CatalogBuild> {
  const shared = await sharedIndex()
  const files = routeFiles()
  const sources = new Map<string, string>()
  const functions = new Map<string, Map<string, string>>()
  const modules = new Map<string, Record<string, unknown>>()
  const registrations = new Map<string, Registration[]>()
  /** router → where it is created (file + identifier). */
  const homes = new Map<AnyHono, { file: string; ident: string }>()

  for (const file of files) {
    const src = readFileSync(file, 'utf8')
    sources.set(file, src)
    functions.set(file, topLevelFunctions(src))
    const mod = (await import(/* @vite-ignore */ file)) as Record<string, unknown>
    modules.set(file, mod)
    const regs = parseRegistrations(file, src)
    registrations.set(file, regs)
    for (const [name, value] of Object.entries(mod)) {
      if (!isHono(value) || homes.has(value)) continue
      if (
        new RegExp(`\\bconst\\s+${name}\\s*(?::[^=]+)?=\\s*(?:createRouter\\(|new Hono\\b)`).test(
          src
        )
      )
        homes.set(value, { file, ident: name })
    }
  }

  // 1. Origin router of every handler: the smallest router that holds it.
  const origin = new Map<unknown, AnyHono>()
  for (const router of homes.keys()) {
    for (const r of router.routes as HonoRoute[]) {
      const h = unwrap(r.handler)
      const current = origin.get(h)
      if (!current || router.routes.length < current.routes.length) origin.set(h, router)
    }
  }

  // 2. Pair each router's own entries (grouped by registration) with its parsed registrations.
  const regOf = new Map<unknown, Registration>()
  for (const [router, home] of homes) {
    const own = (router.routes as HonoRoute[]).filter(
      r => METHODS.has(r.method) && origin.get(unwrap(r.handler)) === router
    )
    const groups: HonoRoute[][] = []
    for (const r of own) {
      const last = groups.at(-1)?.at(-1)
      if (last && last.method === r.method && last.path === r.path) groups.at(-1)?.push(r)
      else groups.push([r])
    }
    const fileRegs = registrations.get(home.file) ?? []
    const mine = fileRegs.filter(r => r.router === home.ident)
    const used = new Set<Registration>()
    groups.forEach((group, k) => {
      const head = group[0] as HonoRoute
      const same = (reg: Registration | undefined) =>
        reg && !used.has(reg) && reg.method === head.method && reg.path === normalisePath(head.path)
      const reg =
        (same(mine[k]) ? mine[k] : undefined) ??
        mine.find(same) ??
        // A router the file composes but does not export: its registrations are on another name.
        fileRegs.find(same)
      if (!reg) return
      used.add(reg)
      for (const r of group) regOf.set(unwrap(r.handler), reg)
    })
  }

  // Public routers, by identity (the mount table in `api/index.ts` names them; this is coarse).
  const publicHandlers = new Set<unknown>()
  const publicRouters: AnyHono[] = serverPlugins.flatMap(p => (p.publicMounts ?? []).map(m => m[1]))
  for (const [file, mod] of modules) {
    const base = path.basename(file, '.ts')
    if (base === 'health') publicRouters.push(mod.healthRouter as AnyHono)
    if (base === 'invite') publicRouters.push(mod.inviteRouter as AnyHono)
    if (base === 'github-webhook') publicRouters.push(mod.githubWebhookRouter as AnyHono)
  }
  for (const router of publicRouters.filter(isHono))
    for (const r of router.routes as HonoRoute[]) publicHandlers.add(unwrap(r.handler))

  // 3. The app's full paths → registrations.
  const byRoute = new Map<string, { method: string; path: string; handlers: unknown[] }>()
  for (const r of app.routes as HonoRoute[]) {
    if (!METHODS.has(r.method) || r.path.includes('*')) continue
    const key = `${r.method} ${normalisePath(r.path)}`
    if (!inScope(key)) continue
    const entry = byRoute.get(key) ?? {
      method: r.method,
      path: normalisePath(r.path),
      handlers: [],
    }
    entry.handlers.push(unwrap(r.handler))
    byRoute.set(key, entry)
  }

  const callSites = cliCallSites()
  const routes: CatalogRoute[] = []
  const registry = new Map<string, RegistryEntry>()
  const schemaViolations: string[] = []
  const bodyViolations: string[] = []
  const manualUsed = new Set<string>()
  for (const [key, { method, path: fullPath, handlers }] of byRoute) {
    const reg = handlers
      .map(h => regOf.get(h))
      .filter(Boolean)
      .at(-1)
    const auth: CatalogRoute['auth'] = handlers.some(h => publicHandlers.has(h))
      ? 'public'
      : fullPath.startsWith('/api/platform/')
        ? 'platform-admin'
        : fullPath.startsWith('/api/admin/') || fullPath === '/api/admin'
          ? 'global-admin'
          : 'signed-in'
    const route: CatalogRoute = { method, path: fullPath, summary: '', auth }
    const entry: RegistryEntry = {}
    if (reg) {
      Object.assign(route, summarise(reg.comment))
      const src = sources.get(reg.file) as string
      const mod = modules.get(reg.file) as Record<string, unknown>
      const fns = functions.get(reg.file) as Map<string, string>
      const zod: NonNullable<CatalogRoute['zod']> = {}
      const middle = reg.args.slice(0, -1).join(',\n')
      for (const m of middle.matchAll(/validate\(\s*'(json|query|param)'\s*,\s*([^)]+?)\s*\)/g)) {
        const field = m[1] === 'json' ? 'body' : m[1] === 'query' ? 'query' : 'params'
        const r = await resolveIdent(m[2] as string, reg.file, src, mod, shared)
        if (!r.ok) {
          schemaViolations.push(`${key}: validate('${m[1]}', …) — ${r.why}`)
          continue
        }
        if (!isZod(r.value)) {
          schemaViolations.push(`${key}: validate('${m[1]}', ${m[2]}) is not a zod schema`)
          continue
        }
        route[field] = toJsonSchema(r.value)
        zod[field] = refString(r.ref)
        entry[field] = r.ref
      }

      // The body rule.
      const text = reachableText(reg, fns)
      const readers = helpersMatching(fns, BODY_READ)
      const callsReader = [...readers].some(n => new RegExp(`(?<![\\w.])${n}\\(`).test(text))
      const readsBody = BODY_READ.test(text) || callsReader
      const manual = MANUAL_BODIES[key]
      if (manual) {
        manualUsed.add(key)
        if (manual.schema) {
          const r = await resolveIdent(manual.schema, reg.file, src, mod, shared)
          if (!r.ok || !isZod(r.value))
            schemaViolations.push(`${key}: the manual body's schema — ${r.ok ? 'not zod' : r.why}`)
          else {
            route.body = toJsonSchema(r.value)
            zod.body = refString(r.ref)
            entry.body = r.ref
          }
        } else if (manual.byParam) {
          const r = await resolveIdent(manual.byParam.schemas, reg.file, src, mod, shared)
          const record = r.ok ? (r.value as Record<string, unknown>) : undefined
          if (!r.ok || !record || !Object.values(record).every(isZod))
            schemaViolations.push(
              `${key}: the manual body's schemas — ${r.ok ? 'not a record of zod schemas' : r.why}`
            )
          else {
            route.body = {
              byParam: manual.byParam.param,
              variants: Object.fromEntries(
                Object.entries(record).map(([k, v]) => [k, toJsonSchema(v as ZodTypeAny)])
              ),
            }
            zod.body = refString(r.ref)
            entry.bodyByParam = { param: manual.byParam.param, schemas: r.ref }
          }
        } else route.body = { raw: true, reason: manual.reason }
        if (manual.optional) {
          route.bodyOptional = true
          entry.bodyOptional = true
        }
      } else if (readsBody && !route.body) {
        const multipart =
          MULTIPART_READ.test(text) ||
          [...helpersMatching(fns, MULTIPART_READ)].some(n =>
            new RegExp(`(?<![\\w.])${n}\\(`).test(text)
          )
        if (multipart) {
          const fields = [...new Set([...text.matchAll(FORM_FIELD)].map(m => m[1] as string))]
          route.body = { multipart: true, fields }
          entry.multipart = fields
        } else
          bodyViolations.push(
            `${key}: reads its body without validate('json', …) — validate it with an @launch/shared schema, or list it in api-catalog-manual-bodies.ts with the reason`
          )
      }

      // Responses, best-effort: one stated type that pairs with a shared schema.
      const handler = reg.args.at(-1) ?? ''
      const paired = [
        ...new Map(
          responseTypes(handler)
            .map(t => pairResponse(t, src, shared))
            .filter((r): r is SharedRef => Boolean(r))
            .map(r => [refString(r), r] as const)
        ).values(),
      ]
      if (paired.length === 1) {
        const ref = paired[0] as SharedRef
        const value = (await import(/* @vite-ignore */ ref.module))[ref.name]
        if (isZod(value)) {
          route.response = toJsonSchema(value)
          zod.response = refString(ref)
          entry.response = ref
        }
      }

      if (Object.keys(zod).length) route.zod = zod
      route.source = path.relative(REPO_ROOT, reg.file).split(path.sep).join('/')
    }
    if (Object.keys(entry).length) registry.set(key, entry)
    const cli = callSites.get(callShape(key))
    if (cli) route.cli = [...cli].sort()
    const reason = excluded(key)
    if (reason) route.cliExcluded = reason
    routes.push(route)
  }
  routes.sort(
    (a, b) =>
      a.path.localeCompare(b.path) ||
      METHOD_ORDER.indexOf(a.method) - METHOD_ORDER.indexOf(b.method)
  )
  const order = routes.map(r => `${r.method} ${r.path}`)
  return {
    catalog: {
      $comment:
        'Generated by `pnpm api:catalog` from the API route table and the route files. Do not edit.',
      routes,
    },
    registry: renderRegistry(order, registry),
    schemaViolations: schemaViolations.sort(),
    bodyViolations: bodyViolations.sort(),
    staleManualBodies: Object.keys(MANUAL_BODIES)
      .filter(k => !manualUsed.has(k))
      .sort(),
  }
}

export const formatCatalog = (catalog: ApiCatalog) => `${JSON.stringify(catalog, null, 2)}\n`

// ---- the zod registry -------------------------------------------------------------------------

/**
 * `apps/cli/src/generated/api-schemas.ts`: one import line per module (sorted), a name aliased
 * only when two modules export the same one, and one entry per route in catalog order.
 */
function renderRegistry(order: string[], registry: Map<string, RegistryEntry>): string {
  const refs: SharedRef[] = []
  for (const e of registry.values())
    refs.push(
      ...[e.params, e.query, e.body, e.bodyByParam?.schemas, e.response].filter(
        (r): r is SharedRef => Boolean(r)
      )
    )
  const unique = new Map(refs.map(r => [refString(r), r]))
  const modulesByName = new Map<string, Set<string>>()
  for (const r of unique.values())
    modulesByName.set(r.name, (modulesByName.get(r.name) ?? new Set()).add(r.module))
  const localOf = (r: SharedRef) =>
    (modulesByName.get(r.name)?.size ?? 0) > 1
      ? `${r.name}_${r.module
          .replace(/^@launch\/shared\/?/, '')
          .replace(/[^\w]+(\w)/g, (_, c: string) => c.toUpperCase())}`
      : r.name
  const byModule = new Map<string, string[]>()
  for (const r of unique.values()) {
    const local = localOf(r)
    byModule.set(r.module, [
      ...(byModule.get(r.module) ?? []),
      local === r.name ? r.name : `${r.name} as ${local}`,
    ])
  }
  const imports = [...byModule]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([module, names]) => {
      const list = names.sort((a, b) => a.localeCompare(b))
      const one = `import { ${list.join(', ')} } from '${module}'`
      return one.length <= 100
        ? one
        : `import {\n${list.map(n => `  ${n},`).join('\n')}\n} from '${module}'`
    })
  const entries = order
    .filter(k => registry.has(k))
    .map(k => {
      const e = registry.get(k) as RegistryEntry
      const parts: string[] = []
      if (e.params) parts.push(`params: ${localOf(e.params)}`)
      if (e.query) parts.push(`query: ${localOf(e.query)}`)
      if (e.body) parts.push(`body: ${localOf(e.body)}`)
      if (e.bodyByParam)
        parts.push(
          `bodyByParam: { param: '${e.bodyByParam.param}', schemas: ${localOf(e.bodyByParam.schemas)} }`
        )
      if (e.bodyOptional) parts.push('bodyOptional: true')
      if (e.multipart) parts.push(`multipart: [${e.multipart.map(f => `'${f}'`).join(', ')}]`)
      if (e.response) parts.push(`response: ${localOf(e.response)}`)
      return `  '${k}': { ${parts.join(', ')} },`
    })
  return `/**
 * Generated by \`pnpm api:catalog\` (apps/web/tests/config/api-catalog-lib.ts). Do not edit.
 *
 * Every API route's request schemas — the SAME \`@launch/shared\` zod objects the route's
 * \`validate()\` uses — and, where the handler's response type pairs with one, its response schema.
 * \`launch api call\` validates \`--data\` / \`--query\` with these before sending.
 */
import type { ZodTypeAny } from 'zod'
${imports.join('\n')}

export interface ApiSchemaEntry {
  params?: ZodTypeAny
  query?: ZodTypeAny
  body?: ZodTypeAny
  /** The body's schema is \`schemas[<the path param>]\`. */
  bodyByParam?: { param: string; schemas: Readonly<Record<string, ZodTypeAny>> }
  /** The body may be omitted entirely. */
  bodyOptional?: true
  /** A multipart upload: the form fields the route reads. */
  multipart?: readonly string[]
  response?: ZodTypeAny
}

export const API_SCHEMAS = {
${entries.join('\n')}
} as const satisfies Record<string, ApiSchemaEntry>
`
}
