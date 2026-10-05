/**
 * The ship gate's contract with the kit (issue #1, rocketflare-launch#2,
 * `services/sessions/gate.ts`): the commands Launch runs, in order, how it tells which kit it is
 * on, and the environment the test step hands the kit's `pnpm test` — fixed in Launch, with no
 * per-app config, and pinned HERE to the kit release that defines them (`SHIP_GATE_KIT_VERSION`, Rocketflare 0.16.0: `pnpm gate`,
 * `pnpm gate --list --json` and its schema in `packages/shared/src/gate.ts`, `scripts/test.mjs`'s
 * target line; the database variables and branch pattern of 0.15.7's
 * `apps/web/tests/helpers/db-safety.ts`, unchanged). A kit release that changes a step, a name or
 * the branch pattern must change this file, the fixture and `gate.ts` together — and the default
 * pin may not fall behind the kit the gate needs.
 *
 * `tests/fixtures/kit-gate/0.16.0.json` is the pinned kit's `pnpm gate --list --json`, verbatim
 * (`gateList()` in its `scripts/lib/gate-lib.mjs`): the "same checks as the app's CI" assertion is
 * made against it.
 */
import { readFileSync } from 'node:fs'
import {
  isShipGateRunning,
  newSessionShortId,
  SHIP_GATE_ATTEMPTS,
  SHIP_GATE_STEP_LABELS,
  SHIP_GATE_STEPS,
  sessionShipGateDataSchema,
  sessionShipGateResultDataSchema,
  sessionShipGateRunningDataSchema,
} from '@launch/shared/launch-sessions'
import { DEFAULT_TEMPLATE_PIN } from '@launch/shared/launch-setup'
import { describe, expect, it } from 'vitest'
import {
  GATE_FORBIDDEN_ENV,
  GATE_KIT_PROBE,
  GATE_KIT_TOO_OLD_MESSAGE,
  GATE_LEGACY_TEST_SCRIPT,
  GATE_LIST_COMMAND,
  GATE_OUTPUT_MAX_CHARS,
  GATE_SCRIPT,
  GATE_TARGET_MAX_CHARS,
  GATE_TEST_ENV_VARS,
  gateBaseEnv,
  gateEgressHosts,
  gateEndpointId,
  gateOutputTail,
  gateTestEnv,
  gateTestTarget,
  kitGateListSchema,
  parseGateList,
  planGateFromList,
  SHIP_GATE_COMMANDS,
  SHIP_GATE_KIT_VERSION,
  SHIP_GATE_LEGACY_COMMANDS,
  SHIP_GATE_LEGACY_KIT_VERSION,
  SHIP_GATE_SKIPPED,
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

/** The pinned kit's `pnpm gate --list --json`, verbatim. */
const KIT_GATE_LIST_JSON = readFileSync(
  new URL('../fixtures/kit-gate/0.16.0.json', import.meta.url),
  'utf8'
)
const KIT_GATE_LIST = kitGateListSchema.parse(JSON.parse(KIT_GATE_LIST_JSON))

describe('the ship gate is the kit’s commands, fixed in Launch', () => {
  it('is written against kit 0.16.0 (pnpm gate), with 0.15.7 (test:ephemeral) the oldest', () => {
    expect(SHIP_GATE_KIT_VERSION).toBe('0.16.0')
    expect(SHIP_GATE_LEGACY_KIT_VERSION).toBe('0.15.7')
    expect(GATE_SCRIPT).toBe('gate')
    expect(GATE_LEGACY_TEST_SCRIPT).toBe('test:ephemeral')
  })

  it('runs `pnpm gate <step>` for lint, typecheck and test, in that order — and not build', () => {
    expect(SHIP_GATE_STEPS).toEqual(['lint', 'typecheck', 'test'])
    expect(shipGateCommands().map(c => c.command)).toEqual([
      'pnpm gate lint',
      'pnpm gate typecheck',
      'pnpm gate test',
    ])
    // Only the tests need a database; build is the PR's CI's (see gate.ts), the ONE skipped step.
    expect(
      shipGateCommands()
        .filter(c => c.database)
        .map(c => c.step)
    ).toEqual(['test'])
    expect(SHIP_GATE_SKIPPED).toEqual(['build'])
    expect(shipGateCommands().some(c => /\bbuild\b/.test(c.command))).toBe(false)
    // The deadlines did not move with the commands: 5 / 10 / 25 minutes.
    expect(shipGateCommands().map(c => c.timeoutMs / 60_000)).toEqual([5, 10, 25])
    for (const step of SHIP_GATE_STEPS) {
      expect(SHIP_GATE_COMMANDS[step].step).toBe(step)
      expect(SHIP_GATE_STEP_LABELS[step]).toBeTruthy()
      // A hard deadline on every step, within a Workflow step's reach.
      expect(SHIP_GATE_COMMANDS[step].timeoutMs).toBeGreaterThan(0)
      expect(SHIP_GATE_COMMANDS[step].timeoutMs).toBeLessThanOrEqual(30 * 60_000)
      expect(SHIP_GATE_LEGACY_COMMANDS[step]).toMatchObject({
        step,
        timeoutMs: SHIP_GATE_COMMANDS[step].timeoutMs,
        database: SHIP_GATE_COMMANDS[step].database,
      })
    }
    expect(DEFAULT_SHIP_ATTEMPTS).toBe(SHIP_GATE_ATTEMPTS)
  })

  it('keeps the legacy path for a kit that only has test:ephemeral (0.15.7 up to 0.16.0)', () => {
    expect(shipGateCommands('legacy').map(c => c.command)).toEqual([
      'pnpm lint',
      'pnpm typecheck',
      'pnpm test:ephemeral',
    ])
  })

  it('is exactly the pinned kit’s own gate steps minus the skipped ones — the same checks as CI', () => {
    // The fixture is what the kit prints: schema 1, in run order, and the schema's shape.
    expect(KIT_GATE_LIST.schema).toBe(1)
    expect(parseGateList(KIT_GATE_LIST_JSON)).toEqual(KIT_GATE_LIST)
    const kitSteps = KIT_GATE_LIST.steps.map(s => s.id)
    // Launch's steps plus the declared exception ARE the kit's list, nothing more or less…
    expect([...SHIP_GATE_STEPS, ...SHIP_GATE_SKIPPED].sort()).toEqual([...kitSteps].sort())
    // …in the kit's order, and the plan Launch makes from the list is exactly its commands.
    expect(kitSteps.filter(id => id !== 'build')).toEqual([...SHIP_GATE_STEPS])
    const plan = planGateFromList(KIT_GATE_LIST)
    expect(plan).toEqual({ ok: true, commands: shipGateCommands() })
    // The kit and Launch agree on which step needs a database.
    for (const step of KIT_GATE_LIST.steps) {
      if (step.id in SHIP_GATE_COMMANDS) {
        expect(SHIP_GATE_COMMANDS[step.id as keyof typeof SHIP_GATE_COMMANDS].database).toBe(
          step.database
        )
      }
    }
  })

  it('the default pin and the image’s warm store are at least the kit the gate is written for', () => {
    expect(atLeast(DEFAULT_TEMPLATE_PIN.tag ?? '0.0.0', SHIP_GATE_KIT_VERSION)).toBe(true)
    expect(atLeast(SESSION_KIT_TAG, SHIP_GATE_KIT_VERSION)).toBe(true)
  })
})

describe('which kit: the capability probe and the kit’s step list', () => {
  it('the probe answers gate, legacy or none from the root package.json', () => {
    expect(GATE_KIT_PROBE).toContain('require("./package.json")')
    expect(GATE_KIT_PROBE).toContain('s["gate"]?"gate"')
    expect(GATE_KIT_PROBE).toContain('s["test:ephemeral"]?"legacy":"none"')
    expect(GATE_LIST_COMMAND).toBe('pnpm --silent gate --list --json')
    expect(GATE_KIT_TOO_OLD_MESSAGE).toContain('0.15.7')
  })

  it('reads the list through a package manager’s noise, and refuses what is not one', () => {
    expect(parseGateList(`> app@0.1.0 gate\n${KIT_GATE_LIST_JSON}`)).toEqual(KIT_GATE_LIST)
    expect(parseGateList('')).toBeNull()
    expect(parseGateList('pnpm gate: unknown option')).toBeNull()
    expect(
      parseGateList('{"schema":2,"steps":[{"id":"lint","command":"x","database":false}]}')
    ).toBeNull()
    expect(parseGateList('{"schema":1,"steps":[]}')).toBeNull()
    expect(
      parseGateList('{"schema":1,"steps":[{"id":"Lint","command":"x","database":false}]}')
    ).toBeNull()
  })

  it('tolerates an added field, and plans in the kit’s order', () => {
    const list = parseGateList(
      JSON.stringify({
        schema: 1,
        generatedBy: 'a later kit',
        steps: [
          { id: 'typecheck', command: 'tsc', database: false, weight: 2 },
          { id: 'lint', command: 'biome', database: false },
          { id: 'build', command: 'build', database: false },
          { id: 'test', command: 'pnpm test', database: true },
        ],
      })
    )
    expect(list).not.toBeNull()
    const plan = planGateFromList(list as NonNullable<typeof list>)
    expect(plan.ok && plan.commands.map(c => c.command)).toEqual([
      'pnpm gate typecheck',
      'pnpm gate lint',
      'pnpm gate test',
    ])
  })

  it('refuses a step it does not know, rather than skipping it', () => {
    const plan = planGateFromList({
      schema: 1,
      steps: [...KIT_GATE_LIST.steps, { id: 'smoke', command: 'playwright test', database: true }],
    })
    expect(plan.ok).toBe(false)
    expect(!plan.ok && plan.message).toContain('`smoke`')
    expect(!plan.ok && plan.message).toContain('same checks as the app')
  })

  it('refuses a list that lacks one of Launch’s steps', () => {
    const plan = planGateFromList({
      schema: 1,
      steps: KIT_GATE_LIST.steps.filter(s => s.id !== 'typecheck'),
    })
    expect(plan.ok).toBe(false)
    expect(!plan.ok && plan.message).toContain('no `typecheck` step')
  })
})

describe('the test target line', () => {
  it('is the line the kit’s pnpm test prints first, redacted and clipped', () => {
    const log = [
      '━━ gate: test ━━ pnpm test',
      'test target: remote Neon branch gate-abcdefgh2345-2 (no Docker; the whole suite under neon)',
      '▶ the other packages',
    ].join('\n')
    expect(gateTestTarget(log)).toBe(
      'test target: remote Neon branch gate-abcdefgh2345-2 (no Docker; the whole suite under neon)'
    )
    expect(gateTestTarget(`\u001b[1mtest target: ${URI}\u001b[0m`, uriSecrets(URI))).toBe(
      'test target: <database url>'
    )
    expect(gateTestTarget('RUN v4 /workspace/app')).toBeNull()
    expect(gateTestTarget(`test target: ${'x'.repeat(500)}`)?.length).toBe(
      GATE_TARGET_MAX_CHARS + 1
    )
    // The event carries it as an optional field.
    expect(
      sessionShipGateDataSchema.parse({ passed: true, attempt: 1, step: 'test', target: 'x' })
    ).toMatchObject({ target: 'x' })
  })
})

describe('the test step’s database contract (unchanged from 0.15.7)', () => {
  it('names the kit’s variables and branch pattern verbatim (kit tests/helpers/db-safety.ts)', () => {
    expect(GATE_TEST_ENV_VARS).toEqual({
      url: 'DATABASE_URL',
      branch: 'TEST_DATABASE_BRANCH',
      endpoint: 'TEST_DATABASE_ENDPOINT',
    })
    expect(GATE_BRANCH_RE.source).toBe('^gate-[a-z0-9]+-\\d+$')
    expect(GATE_FORBIDDEN_ENV).toEqual(['NEON_LOCAL_PROXY', 'APP_DATABASE_URL'])
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

  it('keeps vitest’s failed test and its message when the stack runs past the tail (issue #7)', () => {
    const frames = Array.from({ length: 40 }, (_, i) =>
      ['    {', `      method: 'f${i}',`, `      file: '/workspace/app/x${i}.ts',`, '    },'].join(
        '\n'
      )
    ).join('\n')
    const log = [
      ' FAIL   api  tests/api/admin.test.ts > access requests > approving creates the tenant',
      'NeonDbError: Connection terminated unexpectedly',
      '  error: {',
      frames,
      ' ❯ createTenantForUser src/api/utils/db/tenant-helpers.ts:67:18',
      ' Test Files  1 failed | 59 passed (61)',
      '✖ pnpm gate failed: test',
    ].join('\n')
    const tail = gateOutputTail(log)
    expect(tail.startsWith(' FAIL') || tail.startsWith('FAIL')).toBe(true)
    expect(tail).toContain('approving creates the tenant')
    expect(tail).toContain('  NeonDbError: Connection terminated unexpectedly')
    expect(tail).toContain('✖ pnpm gate failed: test')
    // Vitest prints each failure twice (the list, then the detail): the digest names it once.
    expect(gateOutputTail(`${log}\n${log}`).match(/approving creates the tenant/g)).toHaveLength(1)
  })

  it('keeps the digest when the tail is clipped', () => {
    const long = Array.from({ length: 500 }, (_, i) => `line ${i} ${'x'.repeat(200)}`).join('\n')
    const log = ` FAIL   api  tests/api/a.test.ts > t\nError: boom\n${long}`
    const tail = gateOutputTail(log)
    expect(tail.length).toBeLessThanOrEqual(GATE_OUTPUT_MAX_CHARS + 1)
    expect(tail).toContain('FAIL   api  tests/api/a.test.ts > t')
    expect(tail).toContain('Error: boom')
    expect(tail).toContain('line 499')
  })

  it('is clipped from the front', () => {
    const long = Array.from({ length: 500 }, (_, i) => `line ${i} ${'x'.repeat(200)}`).join('\n')
    const tail = gateOutputTail(long)
    expect(tail.length).toBeLessThanOrEqual(GATE_OUTPUT_MAX_CHARS + 1)
    expect(tail).toContain('line 499')
    expect(tail).not.toContain('line 0 ')
  })
})

describe('the ship.gate row: a verdict, or a step that has started', () => {
  it('still reads every older verdict shape (step-less, per step, with target and tree)', () => {
    for (const row of [
      { passed: true, attempt: 1 },
      { passed: false, attempt: 2, step: 'lint', command: 'pnpm gate lint', output: 'x' },
      { passed: true, attempt: 3, step: 'test', durationMs: 5, target: 't', tree: 'a'.repeat(40) },
    ]) {
      const parsed = sessionShipGateDataSchema.parse(row)
      expect(parsed).toMatchObject(row)
      expect(isShipGateRunning(parsed)).toBe(false)
    }
  })

  it('reads a running row, with its phase and plan, as running', () => {
    const row = {
      status: 'running',
      attempt: 2,
      step: 'test',
      command: 'pnpm gate test',
      phase: 'database',
      plan: ['lint', 'typecheck', 'test'],
    }
    const parsed = sessionShipGateDataSchema.parse(row)
    expect(parsed).toEqual(row)
    expect(isShipGateRunning(parsed)).toBe(true)
    expect(isShipGateRunning(sessionShipGateDataSchema.parse({ ...row, phase: undefined }))).toBe(
      true
    )
  })

  it('a running row carries no verdict, so a reader of verdicts alone skips it', () => {
    const running = { status: 'running', attempt: 1, step: 'lint', command: 'pnpm gate lint' }
    expect(sessionShipGateResultDataSchema.safeParse(running).success).toBe(false)
    // …and a running row needs its step and command.
    expect(
      sessionShipGateRunningDataSchema.safeParse({ status: 'running', attempt: 1 }).success
    ).toBe(false)
    expect(sessionShipGateDataSchema.safeParse({ status: 'running', attempt: 1 }).success).toBe(
      false
    )
  })
})
