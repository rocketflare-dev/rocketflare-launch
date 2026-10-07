/**
 * The halves of the CLI-parity check (issue #6) that more than one test reads: the server's route
 * table, and the CLI's calls as read from its source. `cli-parity.test.ts` asserts every `/api`
 * route is called or excluded; `api-catalog-lib.ts` records, per route, which CLI file calls it.
 *
 * "Called" is read from the CLI's source: every path literal in `apps/cli/src` — a quoted string or
 * a template whose `${…}` parts become `:param` — after inlining the one-line path helpers
 * (`const sessionPath = (id) => \`/api/sessions/${…}\``), compared with the route's pattern. So a
 * command must name its path where it calls it (directly, or through such a helper); a path built
 * at run time out of variables is invisible here, and should not be.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { app } from '@/api/index'
import { CLI_PARITY_EXCLUSIONS, CLI_PARITY_PREFIX_EXCLUSIONS } from './cli-parity-exclusions'

export const CLI_SRC = path.resolve(__dirname, '../../../cli/src')
export const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])

/** `/api/sessions/:id/events` → `/api/sessions/:/events` — names do not matter, positions do. */
export const shape = (p: string) =>
  p
    .replace(/\/+$/, '')
    .split('/')
    .map(s => (s.startsWith(':') ? ':' : s))
    .join('/')

/** `/api/x/` → `/api/x`; `/` stays. */
export const normalisePath = (p: string) => p.replace(/\/+$/, '') || '/'

/** The parity surface: every concrete method + path the app mounts (wildcards skipped). */
export function serverRoutes(): string[] {
  const out = new Set<string>()
  for (const r of app.routes) {
    if (!METHODS.has(r.method)) continue
    if (r.path.includes('*')) continue
    out.add(`${r.method} ${normalisePath(r.path)}`)
  }
  return [...out].sort()
}

export const inScope = (route: string) => {
  const p = route.split(' ')[1] as string
  return p.startsWith('/api/') || p === '/api' || p.startsWith('/cubejs-api') || p === '/mcp'
}

export const callShape = (route: string) => {
  const [method, p] = route.split(' ') as [string, string]
  return `${method} ${shape(p)}`
}

export function excluded(route: string): string | undefined {
  if (route in CLI_PARITY_EXCLUSIONS) return CLI_PARITY_EXCLUSIONS[route]
  const [, p] = route.split(' ') as [string, string]
  return CLI_PARITY_PREFIX_EXCLUSIONS.find(e => p === e.prefix || p.startsWith(`${e.prefix}/`))
    ?.reason
}

function walk(dir: string): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap(name => {
      const p = path.join(dir, name)
      return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []
    })
}

/**
 * Every `METHOD shape` the CLI calls (`.get(` `.post(` `.del(` `.download(` `.request('M', `
 * `.stream('M', `),
 * with the files (relative to `apps/cli/src`) that call it. Helpers are collected across every
 * file first, since a command may call a path helper another file defines.
 */
export function cliCallSites(): Map<string, Set<string>> {
  const files = walk(CLI_SRC).map(f => ({
    rel: path.relative(CLI_SRC, f).split(path.sep).join('/'),
    text: readFileSync(f, 'utf8'),
  }))
  // One-line path helpers: `const x = (…) => \`/api/…\`` and `function x(…) { return \`/api/…\` }`.
  const helpers = new Map<string, string>()
  const helperRe =
    /(?:const\s+(\w+)\s*=\s*\([^)]*\)\s*(?::\s*\w+\s*)?=>\s*|function\s+(\w+)\s*\([^)]*\)\s*(?::\s*\w+\s*)?\{\s*return\s+)`(\/[^`]*)`/g
  for (const { text } of files) {
    for (const m of text.matchAll(helperRe)) helpers.set((m[1] ?? m[2]) as string, m[3] as string)
  }
  const args = '\\((?:[^()]|\\([^()]*\\))*\\)'
  // `${…}` with one level of nested braces/parens → a parameter segment.
  const param = /\$\{(?:[^{}]|\{[^{}]*\})*\}/g
  const lit = '([\'"`])(\\/(?:api|cubejs-api|mcp)\\b[^\'"`\\s]*)\\'
  const calls: Array<[RegExp, (m: RegExpMatchArray) => [string, string]]> = [
    [
      new RegExp(`\\.(get|post|del|download)\\(\\s*${lit}2`, 'g'),
      m => [
        m[1] === 'del' ? 'DELETE' : m[1] === 'download' ? 'GET' : (m[1] as string).toUpperCase(),
        m[3] as string,
      ],
    ],
    [
      new RegExp(`\\.(?:request|stream)(?:<[^>]*>)?\\(\\s*'([A-Z]+)'\\s*,\\s*${lit}2`, 'g'),
      m => [m[1] as string, m[3] as string],
    ],
  ]
  const out = new Map<string, Set<string>>()
  for (const file of files) {
    let text = file.text
    for (let pass = 0; pass < 3; pass++) {
      for (const [name, template] of helpers) {
        // Inside a template: `${sessionPath(id)}/end`; as an argument: `client.get(sessionPath(id)`.
        text = text.replace(new RegExp(`\\$\\{${name}${args}\\}`, 'g'), () => template)
        text = text.replace(new RegExp(`(?<![\\w.])${name}${args}`, 'g'), () => `\`${template}\``)
      }
    }
    for (const [re, pick] of calls) {
      for (const m of text.matchAll(re)) {
        const [method, raw] = pick(m)
        const p = raw.replace(param, ':').split('?')[0] as string
        const key = `${method} ${shape(p)}`
        const set = out.get(key) ?? new Set<string>()
        set.add(file.rel)
        out.set(key, set)
      }
    }
  }
  return out
}

/** The call shapes alone — what the parity test compares against. */
export function cliCalls(): Set<string> {
  return new Set(cliCallSites().keys())
}
