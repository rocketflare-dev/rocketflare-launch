import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SPIKES_DIR } from './env.mjs'

// Every external resource a spike creates is recorded here by id, the same rule the spec sets
// for Launch (spec/06): teardown acts on recorded ids, never on names looked up later.
const file = join(SPIKES_DIR, '.created.json')

export const PREFIX = 'rfspike'

export function listCreated() {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : []
}

/** kind: cf.token | cf.worker | cf.domain | cf.route | cf.dns | cf.hyperdrive | cf.kv | neon.project | resend.domain | resend.key | gh.repo */
export function record(kind, id, meta = {}) {
  const all = listCreated()
  if (!all.some((r) => r.kind === kind && r.id === id)) {
    all.push({ kind, id, ...meta, at: new Date().toISOString() })
    writeFileSync(file, JSON.stringify(all, null, 2))
  }
}

export function forget(kind, id) {
  writeFileSync(file, JSON.stringify(listCreated().filter((r) => !(r.kind === kind && r.id === id)), null, 2))
}
