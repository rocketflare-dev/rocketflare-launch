import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SPIKES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')

const envPath = join(SPIKES_DIR, '.env')
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
  }
}

/** Read required env vars; exit with a clear message listing any that are missing. */
export function need(...names) {
  const missing = names.filter((n) => !process.env[n])
  if (missing.length) {
    console.error(`Missing in spikes/.env: ${missing.join(', ')}`)
    process.exit(2)
  }
  return Object.fromEntries(names.map((n) => [n, process.env[n]]))
}

export const optional = (name) => process.env[name] || undefined
