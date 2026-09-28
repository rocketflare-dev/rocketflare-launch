/**
 * `pnpm dev` serves the UI from Vite (:3000), and the tunnel points there too — so every path the
 * Worker owns must be proxied to wrangler, or a caller reaching Launch on the UI port gets the SPA's
 * `index.html` instead of the API. `/ci` was missing, which is how a scaffold job calling back
 * through the tunnel (`POST /ci/scaffold/token`) could never reach Launch locally.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { API_PREFIXES } from '@/api/utils/routes/api-prefixes'

const VITE_CONFIG = fs.readFileSync(path.resolve(__dirname, '../../vite.config.ts'), 'utf8')

/** The keys of `server.proxy`, read from the source (comments stripped). */
function proxiedPrefixes(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  const block = code.match(/proxy:\s*\{([\s\S]*?)\n\s{4}\}/)?.[1] ?? ''
  return [...block.matchAll(/'([^']+)':\s*proxyTo\(/g)].map(m => m[1] as string)
}

describe('the dev server proxies every Worker path', () => {
  it.each(API_PREFIXES)('%s', prefix => {
    expect(proxiedPrefixes(VITE_CONFIG)).toContain(prefix)
  })
})
