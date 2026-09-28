/**
 * The bootstrap preload (`NOT_ROOT_PRELOAD_SCRIPT`, Launch P3 + fast resume) run under REAL Node,
 * the way the sandbox runs it (`node --import <preload> scripts/bootstrap.mjs`): the kit's
 * bootstrap sees a non-root uid, and a resume's `LAUNCH_BOOTSTRAP_SKIP` answers the kit's
 * `pnpm seed` / `pnpm db:migrate` / `pnpm web db:check` children with what its steps check for —
 * through a NAMED `spawn` import, which is how the kit's bootstrap imports it.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  BOOTSTRAP_SKIP_ENV,
  MIGRATIONS_HASH_COMMAND,
  NOT_ROOT_PRELOAD_SCRIPT,
} from '@/api/services/sessions/rocketflare-dev'

const dir = mkdtempSync(path.join(tmpdir(), 'launch-preload-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const preload = path.join(dir, 'bootstrap-in-sandbox.mjs')
writeFileSync(preload, NOT_ROOT_PRELOAD_SCRIPT)

/** A stand-in for the kit's bootstrap: its uid check and its three `pnpm` children. */
const script = path.join(dir, 'bootstrap.mjs')
writeFileSync(
  script,
  `import { spawn } from 'node:child_process'
import os from 'node:os'
const run = (cmd, args) => new Promise(resolve => {
  let output = ''
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', d => { output += d })
  child.stderr.on('data', d => { output += d })
  child.on('error', e => resolve({ code: 127, output: e.message }))
  child.on('close', code => resolve({ code, output }))
})
const results = {
  uid: os.userInfo().uid,
  seed: await run('pnpm', ['seed', '--demo']),
  migrate: await run('pnpm', ['db:migrate']),
  check: await run('pnpm', ['web', 'db:check']),
  other: await run(process.execPath, ['-e', 'console.log("real child")']),
}
console.log(JSON.stringify(results))
`
)

function bootstrap(skip: string | undefined) {
  // PATH without pnpm: a child the preload does NOT answer fails fast (127) instead of running.
  const env = { PATH: path.dirname(process.execPath) } as unknown as NodeJS.ProcessEnv
  if (skip !== undefined) env[BOOTSTRAP_SKIP_ENV] = skip
  const res = spawnSync(process.execPath, ['--import', preload, script], { env, encoding: 'utf8' })
  expect(res.status, res.stderr).toBe(0)
  return JSON.parse(res.stdout.trim().split('\n').at(-1) ?? '{}')
}

describe('the bootstrap preload', () => {
  it('reports a non-root uid, and leaves every child alone without a skip list', () => {
    const r = bootstrap(undefined)
    expect(r.uid).toBe(1000)
    expect(r.seed.code).not.toBe(0)
    expect(r.migrate.code).not.toBe(0)
    expect(r.other).toMatchObject({ code: 0, output: 'real child\n' })
  })

  it('answers the seed, the migrate and the database check a resume skips', () => {
    const r = bootstrap('seed,migrate,db-check')
    expect(r.seed.code).toBe(0)
    expect(r.migrate.code).toBe(0)
    // What the kit's migrate step looks for in the output.
    expect(r.migrate.output).toContain('Migrations applied')
    expect(r.check.code).toBe(0)
    expect(r.other).toMatchObject({ code: 0, output: 'real child\n' })
  })

  it('still runs the migrate when only the seed and the check are skipped', () => {
    const r = bootstrap('seed,db-check')
    expect(r.seed.code).toBe(0)
    expect(r.check.code).toBe(0)
    expect(r.migrate.code).not.toBe(0)
  })
})

describe('the migrations hash', () => {
  it('prints one sha256 over the migrations directory', () => {
    expect(MIGRATIONS_HASH_COMMAND).toContain('apps/web/migrations')
    expect(MIGRATIONS_HASH_COMMAND).toContain('echo "migrations=$h"')
  })
})
