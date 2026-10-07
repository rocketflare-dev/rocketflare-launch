/**
 * The API catalog (issue #6) is generated and committed — `apps/cli/src/generated/api-catalog.json`
 * (read by `launch api ls|show|schema`) and `apps/cli/src/generated/api-schemas.ts` (the zod
 * registry `launch api call` validates with) — so neither may drift from the routes. This
 * regenerates both in memory (`api-catalog-lib.ts`) and compares; `pnpm api:catalog` (this file
 * with `API_CATALOG_WRITE=1`) rewrites them.
 *
 * It also holds every route to three rules, each failure naming the route:
 *
 * - a one-line summary comment above its registration;
 * - contracts first: every `validate()` schema is an export of `@launch/shared`;
 * - a route that reads its body validates it (`validate('json', …)`), reads multipart form data,
 *   or is listed with its reason in `api-catalog-manual-bodies.ts` — anything else is bodiless.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BODY_READ,
  blankComments,
  buildCatalog,
  CATALOG_PATH,
  type CatalogBuild,
  formatCatalog,
  REGISTRY_PATH,
  routeFiles,
  sharedSpecifier,
} from './api-catalog-lib'

const WRITE = Boolean(process.env.API_CATALOG_WRITE)

describe('API catalog (issue #6)', async () => {
  const build: CatalogBuild = await buildCatalog()
  const { catalog, registry } = build
  const text = formatCatalog(catalog)

  if (WRITE) {
    mkdirSync(path.dirname(CATALOG_PATH), { recursive: true })
    writeFileSync(CATALOG_PATH, text)
    writeFileSync(REGISTRY_PATH, registry)
  }

  it('reads the route table', () => {
    expect(catalog.routes.length).toBeGreaterThan(100)
  })

  it('apps/cli/src/generated/api-catalog.json is up to date', () => {
    const committed = existsSync(CATALOG_PATH) ? readFileSync(CATALOG_PATH, 'utf8') : ''
    expect(
      committed === text,
      'apps/cli/src/generated/api-catalog.json is stale — run `pnpm api:catalog` and commit it'
    ).toBe(true)
  })

  it('apps/cli/src/generated/api-schemas.ts is up to date', () => {
    const committed = existsSync(REGISTRY_PATH) ? readFileSync(REGISTRY_PATH, 'utf8') : ''
    expect(
      committed === registry,
      'apps/cli/src/generated/api-schemas.ts is stale — run `pnpm api:catalog` and commit it'
    ).toBe(true)
  })

  it('every route has a one-line summary comment', () => {
    expect(
      catalog.routes.filter(r => !r.summary).map(r => `${r.method} ${r.path}`),
      'these routes have no doc comment above their registration — add a one-line `/** … */` summary'
    ).toEqual([])
  })

  it('every validate() schema is an export of @launch/shared (contracts first)', () => {
    expect(
      build.schemaViolations,
      'move the schema to packages/shared/src/<module>.ts, export it, and import it in the route'
    ).toEqual([])
  })

  it('every route that reads its body validates it, takes multipart, or says why not', () => {
    expect(build.bodyViolations).toEqual([])
    expect(
      build.staleManualBodies,
      'these api-catalog-manual-bodies.ts entries match no hand-parsed body — delete them'
    ).toEqual([])
  })

  it('the registry names every request schema the catalog records', () => {
    const withZod = catalog.routes.filter(r => r.zod?.body || r.zod?.query || r.zod?.params)
    expect(withZod.length).toBeGreaterThan(100)
    for (const r of withZod) expect(registry).toContain(`'${r.method} ${r.path}': {`)
  })
})

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const p = path.join(dir, name)
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []
  })
}

describe('api-catalog-lib helpers', () => {
  it('only route files read a request body, so the body rule sees every read', () => {
    // The body rule reads a registration and the same-file helpers it calls. A helper elsewhere
    // that read `c.req` would hide a body from it — so none may exist.
    const src = path.resolve(__dirname, '../../src')
    const routes = new Set(routeFiles())
    const offenders = [...walk(path.join(src, 'api')), ...walk(path.join(src, 'plugins'))]
      .filter(f => !routes.has(f) && !/\.test\.tsx?$/.test(f) && !f.includes('/tests/'))
      .filter(f => BODY_READ.test(readFileSync(f, 'utf8')))
      .map(f => path.relative(src, f))
      // The SPA catch-all hands non-API requests to ASSETS; it is no `/api` route.
      .filter(f => f !== 'api/index.ts')
    expect(offenders).toEqual([])
  })

  it('maps a shared file to the specifier the package exports it under', () => {
    expect(sharedSpecifier('index.ts')).toBe('@launch/shared')
    expect(sharedSpecifier('ai/index.ts')).toBe('@launch/shared/ai')
    expect(sharedSpecifier('ai/chat.ts')).toBe('@launch/shared/ai/chat')
    expect(sharedSpecifier('plugins/api.ts')).toBe('@launch/shared/plugin-api')
    expect(sharedSpecifier('launch-sessions.ts')).toBe('@launch/shared/launch-sessions')
  })

  it('blanks comments but keeps strings and line positions', () => {
    const src = "a.post('/x') // router.post('/y')\n/* router.get('/z')\n*/ const s = '//keep'"
    const out = blankComments(src)
    expect(out).toHaveLength(src.length)
    expect(out).not.toContain("'/y'")
    expect(out).not.toContain("'/z'")
    expect(out).toContain("'//keep'")
    expect(out.split('\n')).toHaveLength(3)
  })
})
