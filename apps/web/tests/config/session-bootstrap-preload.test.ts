/**
 * The bootstrap preload (`NOT_ROOT_PRELOAD_SCRIPT`, Launch P3 + fast resume) run under REAL Node,
 * the way the sandbox runs it (`node --import <preload> scripts/bootstrap.mjs`): the kit's
 * bootstrap sees a non-root uid, `LAUNCH_BOOTSTRAP_SKIP` answers the kit's `pnpm seed` /
 * `pnpm db:migrate` / `pnpm web db:check` / `pnpm install` / `pnpm web exec wrangler whoami`
 * children with what its steps check for, and a
 * `db:migrate` that runs is the kit's migrator alone — through a NAMED `spawn` import, which is
 * how the kit's bootstrap imports it.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  ALWAYS_SKIPPED,
  BOOTSTRAP_SKIP_ENV,
  MIGRATIONS_HASH_COMMAND,
  NOT_ROOT_PRELOAD_SCRIPT,
} from '@/api/services/sessions/rocketflare-dev'

const dir = mkdtempSync(path.join(tmpdir(), 'launch-preload-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const preload = path.join(dir, 'bootstrap-in-sandbox.mjs')
writeFileSync(preload, NOT_ROOT_PRELOAD_SCRIPT)

/** A stand-in for the kit's bootstrap: its uid check and its `pnpm` children. */
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
  install: await run('pnpm', ['install', '--prefer-offline']),
  whoami: await run('pnpm', ['web', 'exec', 'wrangler', 'whoami']),
  cliWhoami: await run('pnpm', ['--silent', 'cli', 'whoami']),
  other: await run(process.execPath, ['-e', 'console.log("real child")']),
}
console.log(JSON.stringify(results))
`
)

/** A stand-in `pnpm` that prints how it was called and fails: a child the preload let through. */
const bin = path.join(dir, 'bin')
mkdirSync(bin)
writeFileSync(path.join(bin, 'pnpm'), '#!/bin/sh\necho "pnpm $*"\nexit 3\n')
chmodSync(path.join(bin, 'pnpm'), 0o755)

function bootstrap(skip: string | undefined) {
  const env = { PATH: `${bin}:${path.dirname(process.execPath)}` } as unknown as NodeJS.ProcessEnv
  if (skip !== undefined) env[BOOTSTRAP_SKIP_ENV] = skip
  const res = spawnSync(process.execPath, ['--import', preload, script], { env, encoding: 'utf8' })
  expect(res.status, res.stderr).toBe(0)
  return JSON.parse(res.stdout.trim().split('\n').at(-1) ?? '{}')
}

describe('the bootstrap preload', () => {
  it('reports a non-root uid, and runs the seed and the check as the kit wrote them', () => {
    const r = bootstrap(undefined)
    expect(r.uid).toBe(1000)
    expect(r.seed).toMatchObject({ code: 3, output: 'pnpm seed --demo\n' })
    expect(r.check).toMatchObject({ code: 3, output: 'pnpm web db:check\n' })
    expect(r.other).toMatchObject({ code: 0, output: 'real child\n' })
  })

  it('runs the kit’s migrator alone for db:migrate — never its db-roles', () => {
    const r = bootstrap(undefined)
    expect(r.migrate).toMatchObject({
      code: 3,
      output: 'pnpm web exec dotenv -e .dev.vars -- tsx scripts/migrate.ts\n',
    })
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
    expect(r.migrate.output).toContain('tsx scripts/migrate.ts')
  })
})

/**
 * The kit's `parseWhoami` (`scripts/lib/bootstrap-lib.mjs`, unchanged 0.15.0 → 0.17.3): logged in
 * only when the output says "You are logged in with" — its exit code is never read.
 */
const kitLoggedIn = (output: string) => /You are logged in with/i.test(output)

describe('the kit’s second install and its wrangler login check', () => {
  it('run as the kit wrote them when not skipped, and `cli whoami` is never touched', () => {
    const r = bootstrap(undefined)
    expect(r.install).toMatchObject({ code: 3, output: 'pnpm install --prefer-offline\n' })
    expect(r.whoami).toMatchObject({ code: 3, output: 'pnpm web exec wrangler whoami\n' })
    expect(r.cliWhoami).toMatchObject({ code: 3, output: 'pnpm --silent cli whoami\n' })
  })

  it('install: a no-op success, which is all the kit’s install step checks (with wrangler’s bin)', () => {
    const r = bootstrap('install')
    expect(r.install.code).toBe(0)
    expect(r.install.output).toContain('install skipped by Launch')
    // Only what was named is answered.
    expect(r.whoami.code).toBe(3)
    expect(r.seed.code).toBe(3)
  })

  it('whoami: wrangler’s "not authenticated", so --offline takes its not-logged-in branch', () => {
    const r = bootstrap('whoami')
    expect(r.whoami.code).toBe(0)
    expect(r.whoami.output).toContain('You are not authenticated')
    expect(kitLoggedIn(r.whoami.output)).toBe(false)
    // The CLI's own whoami (step 9, never reached under --no-dev) is not wrangler's.
    expect(r.cliWhoami).toMatchObject({ code: 3, output: 'pnpm --silent cli whoami\n' })
    expect(r.install.code).toBe(3)
  })

  it('every session bootstrap skips the check, the second install and whoami', () => {
    expect([...ALWAYS_SKIPPED].sort()).toEqual(['db-check', 'install', 'whoami'])
    const r = bootstrap(ALWAYS_SKIPPED.join(','))
    expect([r.check.code, r.install.code, r.whoami.code]).toEqual([0, 0, 0])
    expect(r.migrate.output).toContain('tsx scripts/migrate.ts')
    expect(r.seed.code).toBe(3)
  })
})

describe('the migrations hash', () => {
  it('prints one sha256 over the migrations directory', () => {
    expect(MIGRATIONS_HASH_COMMAND).toContain('apps/web/migrations')
    expect(MIGRATIONS_HASH_COMMAND).toContain('echo "migrations=$h"')
  })
})
