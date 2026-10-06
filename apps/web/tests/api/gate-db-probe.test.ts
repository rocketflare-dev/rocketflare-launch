/**
 * The ship gate's database probe (`services/sessions/gate-db-probe.ts`, rocketflare-launch#7), RUN
 * for real: the script Launch writes into a session's container, under `node` from `apps/web`, with
 * the app's own `@neondatabase/serverless`, against a local WebSocket relay to the test Postgres
 * (the driver speaks the Postgres protocol over the WebSocket; `NEON_LOCAL_PROXY` points it here).
 * The relay refuses the first upgrades it is told to — a dropped connection is exactly the empty
 * `ErrorEvent` a sandbox saw on 2026-10-06 — so the probe's retry, its give-up and its diagnosis are
 * proven on the real driver. And the classifier that decides the gate's one retry.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  GATE_DB_PROBE_REFUSED,
  GATE_DB_PROBE_SCRIPT,
  GATE_DB_PROBE_UNREACHABLE,
  gateDbProbeMessage,
  gateDbProbeVerdict,
  isSetupConnectionFailure,
} from '@/api/services/sessions/gate-db-probe'
import { relay } from '../helpers/ws-pg-relay'

const WEB_DIR = path.resolve(__dirname, '../..')
const SCRIPT = path.join(mkdtempSync(path.join(tmpdir(), 'gate-db-probe-')), 'probe.cjs')
writeFileSync(SCRIPT, GATE_DB_PROBE_SCRIPT)

function probe(env: Record<string, string>): Promise<{ code: number | null; out: string }> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [SCRIPT], {
      cwd: WEB_DIR,
      env: { PATH: process.env.PATH ?? '', ...env } as unknown as NodeJS.ProcessEnv,
    })
    let out = ''
    child.stdout.on('data', d => {
      out += d
    })
    child.stderr.on('data', d => {
      out += d
    })
    child.on('close', code => resolve({ code, out }))
  })
}

const closers: (() => void)[] = []
afterEach(() => {
  for (const close of closers.splice(0)) close()
})

describe('the gate database probe, run', () => {
  it('rides out refused connections and passes once the database answers', async () => {
    const r = await relay(2)
    closers.push(r.close)
    const { code, out } = await probe({
      DATABASE_URL: process.env.DATABASE_URL ?? '',
      NEON_LOCAL_PROXY: r.url,
      LAUNCH_PROBE_BUDGET_MS: '20000',
    })
    expect(out).toContain('attempt 1 failed')
    expect(out).toContain('the WebSocket failed before Postgres answered')
    expect(out).toContain('attempt 2 failed')
    expect(out).toMatch(/answered select 1 after 3 attempts/)
    expect(code).toBe(0)
    expect(r.upgrades()).toBe(3)
  }, 30_000)

  it('gives up with a verdict that says the network path is down — and never prints the URL', async () => {
    const r = await relay(1_000)
    closers.push(r.close)
    const url = 'postgresql://someone:s3cret-password@localhost/db'
    const { code, out } = await probe({
      DATABASE_URL: url,
      NEON_LOCAL_PROXY: r.url,
      LAUNCH_PROBE_BUDGET_MS: '1200',
    })
    expect(code).toBe(GATE_DB_PROBE_UNREACHABLE)
    expect(gateDbProbeVerdict(out)).toMatch(/cannot reach localhost over HTTPS either/)
    expect(out).not.toContain('s3cret-password')
    expect(out).not.toContain(url)
  }, 30_000)

  it('skips — exit 0 — when there is nothing to probe or no driver to probe with', async () => {
    expect((await probe({ DATABASE_URL: '' })).code).toBe(0)
    const elsewhere = await new Promise<{ code: number | null; out: string }>(resolve => {
      const child = spawn(process.execPath, [SCRIPT], {
        cwd: tmpdir(),
        env: {
          PATH: process.env.PATH ?? '',
          DATABASE_URL: 'postgresql://u:p@h/db',
        } as unknown as NodeJS.ProcessEnv,
      })
      let out = ''
      child.stdout.on('data', d => {
        out += d
      })
      child.on('close', code => resolve({ code, out }))
    })
    expect(elsewhere.code).toBe(0)
    expect(elsewhere.out).toContain('no @neondatabase/serverless')
  }, 30_000)
})

describe('the gate database probe, read', () => {
  it('says what to do for an unreachable endpoint, and less for a refusing database', () => {
    expect(gateDbProbeMessage(GATE_DB_PROBE_UNREACHABLE, 'the container cannot reach x')).toMatch(
      /could not reach its test database.*the container cannot reach x.*Suspend and resume/
    )
    expect(gateDbProbeMessage(GATE_DB_PROBE_REFUSED, null)).toMatch(/did not answer/)
    expect(gateDbProbeVerdict('gate db probe: attempt 1 failed\n')).toBeNull()
  })
})

describe('isSetupConnectionFailure — the one red the gate runs again', () => {
  const setup = [
    ' Tests  52 passed (52)',
    'No test files found, exiting with code 1',
    "ErrorEvent { type: 'error', defaultPrevented: false }",
    ' ❯ Object.query scripts/lib/sql.ts:39:42',
    ' ❯ prepareTestDatabase tests/setup.ts:23:3',
    ' ❯ TestProject._initializeGlobalSetup node_modules/vitest/dist/x.js:1:1',
  ].join('\n')

  it("the 2026-10-06 log: globalSetup's first query, an empty ErrorEvent", () => {
    expect(isSetupConnectionFailure(setup)).toBe(true)
    expect(isSetupConnectionFailure(`\u001b[31m${setup}\u001b[39m`)).toBe(true)
  })

  it('never a failed test, a setup error that is not a connection, or a connection error outside setup', () => {
    expect(
      isSetupConnectionFailure(`${setup}\n FAIL  api tests/api/orders.test.ts > lists orders`)
    ).toBe(false)
    expect(isSetupConnectionFailure(`${setup}\n Tests  1 failed | 3 passed (4)`)).toBe(false)
    expect(
      isSetupConnectionFailure(
        'Error: permission denied to alter role\n ❯ TestProject._initializeGlobalSetup x.js:1:1'
      )
    ).toBe(false)
    expect(isSetupConnectionFailure("ErrorEvent { type: 'error' }\n ❯ createTenantForUser")).toBe(
      false
    )
  })
})
