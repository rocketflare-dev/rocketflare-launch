/**
 * The ship gate's contract with the kit (issue #1, `services/sessions/gate.ts`): the commands
 * Launch runs, in order, and the environment the test step hands `pnpm test:ephemeral` — fixed in
 * Launch, with no per-app config, and pinned HERE to the kit release that defines them
 * (`SHIP_GATE_KIT_VERSION`, Rocketflare 0.15.7: root `package.json` `test:ephemeral`,
 * `apps/web/tests/helpers/db-safety.ts`). A kit release that changes a name or the branch pattern
 * must change this file and `gate.ts` together — and the default pin may not fall behind the kit
 * the gate needs.
 */
import {
  newSessionShortId,
  SHIP_GATE_ATTEMPTS,
  SHIP_GATE_STEP_LABELS,
  SHIP_GATE_STEPS,
} from '@launch/shared/launch-sessions'
import { DEFAULT_TEMPLATE_PIN } from '@launch/shared/launch-setup'
import { describe, expect, it } from 'vitest'
import {
  GATE_FORBIDDEN_ENV,
  GATE_OUTPUT_MAX_CHARS,
  GATE_TEST_ENV_VARS,
  GATE_TEST_SCRIPT,
  gateBaseEnv,
  gateEgressHosts,
  gateEndpointId,
  gateOutputTail,
  gateTestEnv,
  SHIP_GATE_COMMANDS,
  SHIP_GATE_KIT_VERSION,
  shipGateCommands,
  uriSecrets,
} from '@/api/services/sessions/gate'
import {
  GATE_BRANCH_MAX_AGE_MS,
  GATE_BRANCH_RE,
  gateBranchName,
  isGateBranch,
  isGateBranchOf,
} from '@/api/services/sessions/gate-branch'
import { SESSION_KIT_TAG } from '@/api/services/sessions/rocketflare-dev'
import { DEFAULT_SHIP_ATTEMPTS } from '@/api/services/sessions/ship'

/** `a.b.c` as numbers, for a release comparison. */
const semver = (tag: string) => tag.split('.').map(n => Number.parseInt(n, 10))
const atLeast = (tag: string, min: string) => {
  const [a, b] = [semver(tag), semver(min)]
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  }
  return true
}

const BRANCH = {
  name: 'gate-abcdefgh2345-2',
  branchId: 'br-gate-1',
  endpointId: 'ep-cool-darkness-123456',
  host: 'ep-cool-darkness-123456.us-east-2.aws.neon.tech',
}
const URI =
  'postgresql://session_owner:npg_S3cretPassw0rd@ep-cool-darkness-123456.us-east-2.aws.neon.tech/session_app?sslmode=require'

describe('the ship gate is the kit’s commands, fixed in Launch', () => {
  it('is written against kit 0.15.7', () => {
    expect(SHIP_GATE_KIT_VERSION).toBe('0.15.7')
  })

  it('runs lint, typecheck and test:ephemeral, in that order — and not build', () => {
    expect(SHIP_GATE_STEPS).toEqual(['lint', 'typecheck', 'test'])
    expect(shipGateCommands().map(c => c.command)).toEqual([
      'pnpm lint',
      'pnpm typecheck',
      `pnpm ${GATE_TEST_SCRIPT}`,
    ])
    expect(GATE_TEST_SCRIPT).toBe('test:ephemeral')
    // Only the tests need a database; build is the PR's CI's (see gate.ts).
    expect(
      shipGateCommands()
        .filter(c => c.database)
        .map(c => c.step)
    ).toEqual(['test'])
    expect(shipGateCommands().some(c => /\bbuild\b/.test(c.command))).toBe(false)
    for (const step of SHIP_GATE_STEPS) {
      expect(SHIP_GATE_COMMANDS[step].step).toBe(step)
      expect(SHIP_GATE_STEP_LABELS[step]).toBeTruthy()
      // A hard deadline on every step, within a Workflow step's reach.
      expect(SHIP_GATE_COMMANDS[step].timeoutMs).toBeGreaterThan(0)
      expect(SHIP_GATE_COMMANDS[step].timeoutMs).toBeLessThanOrEqual(30 * 60_000)
    }
    expect(DEFAULT_SHIP_ATTEMPTS).toBe(SHIP_GATE_ATTEMPTS)
  })

  it('names the kit’s variables and branch pattern verbatim (kit tests/helpers/db-safety.ts)', () => {
    expect(GATE_TEST_ENV_VARS).toEqual({
      url: 'DATABASE_URL',
      branch: 'TEST_DATABASE_BRANCH',
      endpoint: 'TEST_DATABASE_ENDPOINT',
    })
    expect(GATE_BRANCH_RE.source).toBe('^gate-[a-z0-9]+-\\d+$')
    expect(GATE_FORBIDDEN_ENV).toEqual(['NEON_LOCAL_PROXY', 'APP_DATABASE_URL'])
  })

  it('the default pin and the image’s warm store are at least the kit the gate needs', () => {
    expect(atLeast(DEFAULT_TEMPLATE_PIN.tag ?? '0.0.0', SHIP_GATE_KIT_VERSION)).toBe(true)
    expect(atLeast(SESSION_KIT_TAG, SHIP_GATE_KIT_VERSION)).toBe(true)
  })
})

describe('gate branch names', () => {
  it('gate-<short>-<attempt> matches the kit for every session short id', () => {
    for (let i = 0; i < 20; i++) {
      const short = newSessionShortId()
      const name = gateBranchName(short, i + 1)
      expect(name).toMatch(GATE_BRANCH_RE)
      expect(isGateBranchOf(name, short)).toBe(true)
    }
    expect(gateBranchName('abcdefgh2345', 3)).toBe('gate-abcdefgh2345-3')
  })

  it('tells one session’s gate branches from another’s, and from every other branch', () => {
    expect(isGateBranchOf('gate-abcdefgh2345-1', 'abcdefgh2345')).toBe(true)
    expect(isGateBranchOf('gate-zzzzzzzz2345-1', 'abcdefgh2345')).toBe(false)
    expect(isGateBranch('session-abcdefgh2345')).toBe(false)
    expect(isGateBranch('dev')).toBe(false)
    expect(isGateBranch('gate-abc')).toBe(false)
    expect(() => gateBranchName('Not-A-Short', 1)).toThrow()
    expect(GATE_BRANCH_MAX_AGE_MS).toBeGreaterThan(SHIP_GATE_COMMANDS.test.timeoutMs)
  })
})

describe('the test step’s environment', () => {
  it('is the base plus exactly the kit’s three variables — never a local proxy', () => {
    const env = gateTestEnv({ emulated: false }, BRANCH, URI)
    expect(env).toEqual({
      CI: '1',
      WRANGLER_SEND_METRICS: 'false',
      DATABASE_URL: URI,
      TEST_DATABASE_BRANCH: 'gate-abcdefgh2345-2',
      TEST_DATABASE_ENDPOINT: 'ep-cool-darkness-123456',
    })
    for (const name of GATE_FORBIDDEN_ENV) expect(env).not.toHaveProperty(name)
    // On a laptop's emulated amd64, esbuild's collector switches — nothing else.
    expect(gateBaseEnv({ emulated: true })).toEqual({
      CI: '1',
      WRANGLER_SEND_METRICS: 'false',
      GOGC: 'off',
      GOMEMLIMIT: '1536MiB',
    })
  })

  it('refuses a URL for another endpoint (the kit would), without printing it', () => {
    const other = URI.replace('ep-cool-darkness-123456', 'ep-other-000001')
    let message = ''
    try {
      gateTestEnv({}, BRANCH, other)
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toMatch(/another endpoint/)
    expect(message).not.toContain('npg_S3cret')
  })

  it('the endpoint id is the kit’s (the -pooler suffix ignored); the allow-list is exactly its hosts', () => {
    expect(gateEndpointId('ep-cool-darkness-123456-pooler.us-east-2.aws.neon.tech')).toBe(
      'ep-cool-darkness-123456'
    )
    expect(() => gateEndpointId('db.example.com')).toThrow()
    expect(gateEgressHosts(BRANCH)).toEqual([
      'ep-cool-darkness-123456.us-east-2.aws.neon.tech',
      'ep-cool-darkness-123456-pooler.us-east-2.aws.neon.tech',
      'api.us-east-2.aws.neon.tech',
    ])
    expect(
      gateEgressHosts({ host: 'ep-cool-darkness-123456-pooler.us-east-2.aws.neon.tech' })
    ).toEqual(gateEgressHosts(BRANCH))
  })
})

describe('the output tail', () => {
  it('never carries the URL, its password, a connection string or a key', () => {
    const log = [
      'RUN  v4.0.0 /workspace/app/apps/web',
      `connecting to ${URI}`,
      'password authentication failed: npg_S3cretPassw0rd',
      'other: postgres://u:hunter2secret@db.example.com:5432/x',
      'leaked sk-ant-api03-abcdefghijklmnopqrstuvwxyz',
      ' FAIL  tests/api/orders.test.ts > lists orders',
      'AssertionError: expected 2 to be 3',
    ].join('\n')
    const tail = gateOutputTail(log, uriSecrets(URI))
    expect(tail).not.toContain('npg_S3cretPassw0rd')
    expect(tail).not.toContain('hunter2secret')
    expect(tail).not.toContain('sk-ant-api03')
    expect(tail).toContain('<database url>')
    expect(tail).toContain('FAIL  tests/api/orders.test.ts')
    expect(tail).toContain('expected 2 to be 3')
  })

  it('is clipped from the front', () => {
    const long = Array.from({ length: 500 }, (_, i) => `line ${i} ${'x'.repeat(200)}`).join('\n')
    const tail = gateOutputTail(long)
    expect(tail.length).toBeLessThanOrEqual(GATE_OUTPUT_MAX_CHARS + 1)
    expect(tail).toContain('line 499')
    expect(tail).not.toContain('line 0 ')
  })
})
