// @vitest-isolate
// Mocks `sessionsPaused` (a GLOBAL launch setting another file may be flipping), so this file needs
// its own module registry.
/**
 * The ship gate (issue #1, `services/sessions/ship-steps.ts`) driven through the real
 * `SessionWorkflow`: Launch runs the kit's gate commands itself in a `FakeSandbox` (their exit
 * codes scripted), the test step on a throwaway Neon gate branch made by the REAL Neon adapter over
 * the FakeCloud, the PR opened by the real GitHub repo host over the FakeCloud's GitHub. The model
 * parts are the hooks: a recording fix turn, and the REAL `summarizeShip` over a `FakeChatClient`.
 *
 * What it proves: a green gate opens a PR with no model call but the summary; a red one gets ONE
 * focused fix turn with the failing command and its (redacted) tail, and the gate runs again;
 * exhausted attempts open nothing and say so; the test step gets exactly the kit's environment
 * and the allow-list exactly the branch's hosts; the gate branch is always deleted — green, red,
 * ended mid-gate, container lost mid-gate, the Workflow gone mid-gate (cleanup), and orphans (the
 * sweep); and no database URL or password reaches an event or a step result.
 */
import { generateKeyPairSync } from 'node:crypto'
import {
  LAUNCH_GATE_CHECK,
  SESSION_WAKE_EVENT,
  sessionBranchName,
  sessionShipGateDataSchema,
} from '@launch/shared/launch-sessions'
import { and, eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WORKSPACE_CHANGED_SCRIPT } from '@/api/services/sessions/checkpoint'
import { NeonSessionDb } from '@/api/services/sessions/db/neon-session-db'
import { listSessionEvents } from '@/api/services/sessions/event-log'
import {
  GATE_KIT_TOO_OLD_MESSAGE,
  GATE_LIST_COMMAND,
  GATE_LIST_UNREADABLE_MESSAGE,
  gateBaseEnv,
  gateEgressHosts,
} from '@/api/services/sessions/gate'
import { gateBranchName } from '@/api/services/sessions/gate-branch'
import { runGateSweep, sessionsGateSweepTask } from '@/api/services/sessions/gate-sweep'
import type { SessionStepHooks } from '@/api/services/sessions/hooks'
import type { SandboxExecOptions } from '@/api/services/sessions/ports'
import { GitHubRepoHost } from '@/api/services/sessions/repo/github-repo-host'
import { SHIP_SUMMARY_FEATURE, summarizeShip } from '@/api/services/sessions/ship'
import { SHIP_CONTAINER_LOST_MESSAGE } from '@/api/services/sessions/ship-steps'
import { devEnvFor } from '@/api/services/sessions/steps'
import { SessionWorkflow } from '@/api/workflows/session'
import { loadConfig } from '@/config'
import { aiUsage, apps, type SessionRow, sessions } from '@/db/schema'
import { FakeChatClient } from '../helpers/ai'
import { setupTestDatabase } from '../helpers/db'
import { createFakeCloud, type FakeCloud } from '../helpers/fake-cloud'
import type { FakeSandbox } from '../helpers/fake-sandbox'
import {
  createFakeSessionPorts,
  type FakeSessionPorts,
  GATE_TREE,
  insertSession,
  KIT_GATE_LIST_JSON,
  type SessionAppFixture,
  scriptKitGate,
  seedSessionApp,
  sessionAppRef,
  UNEXPECTED_LAND_HOOKS,
} from '../helpers/sessions'
import { createExecutionContext, createTestEnv, type TestEnv } from '../mocks/bindings'
import { createFakeWorkflowStep } from '../mocks/cloudflare-workers'

vi.mock('@/api/services/sessions/lifecycle', async importOriginal => {
  const actual = await importOriginal<typeof import('@/api/services/sessions/lifecycle')>()
  return { ...actual, sessionsPaused: vi.fn(async () => false) }
})

const db = setupTestDatabase()
const NEON_KEY = 'neon-test-key-abcdefghijklmnop'
const BASE_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
const WAKE = { type: SESSION_WAKE_EVENT, payload: {} }
const SUMMARY = '{"title": "Greet people on the home page", "body": "Adds a bold greeting."}'
const LIMITS = { endPollMs: 5, commandPollMs: 1, heartbeatMs: 60_000 }
const { privateKey: APP_PEM } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
})

/** A gate command's run, as the sandbox saw it start. */
interface GateRun {
  step: 'lint' | 'typecheck' | 'test'
  env: Record<string, string>
  /** The allow-list while it ran. */
  allowedHosts: string[]
  /** The test step's gate branch, as Neon had it then. */
  branch?: { name: string; parentId: string | null; host: string }
}

/** What a scripted gate command does: its exit and log, or `hang` (it never ends by itself). */
type GateScript = (run: GateRun, n: number) => { exitCode?: number; log?: string } | 'hang'

interface Harness {
  env: TestEnv
  cloud: FakeCloud
  f: SessionAppFixture
  row: SessionRow
  ports: FakeSessionPorts
  hooks: SessionStepHooks
  runs: GateRun[]
  fixes: string[]
  checkpoints: string[]
  summary: FakeChatClient
  sandbox: () => FakeSandbox
}

/**
 * A prepared app, a `requested` session, and a sandbox scripted like a kit app whose gate
 * commands do what `gate` says (default: every one green).
 */
async function harness(
  opts: {
    gate?: Partial<Record<GateRun['step'], GateScript>>
    /** What a fix turn does besides being recorded. */
    onFix?: (h: Harness) => void
    /** What the checkout's kit answers the probe (default `gate`, the pinned kit). */
    kit?: 'gate' | 'legacy' | 'none'
    /** What `pnpm gate --list --json` prints (default: the pinned kit's list). */
    gateList?: string
    /** Issue #9: what the tree reads answer (default: both {@link GATE_TREE}). */
    trees?: Parameters<typeof scriptKitGate>[3]
    /** Issue #9: the checkpoint moves the session's head to the commit it pushed (the real one does). */
    trackHead?: boolean
  } = {}
): Promise<Harness> {
  const env = createTestEnv()
  const cfg = loadConfig(env)
  const cloud = createFakeCloud()
  const f = await seedSessionApp(db, cloud, { prepared: true })
  // `pr` mode: the ship ends at the open PR, as before issue #5 (the landing: session-land.test.ts).
  await db
    .update(apps)
    .set({ shipSettings: { sessionShip: 'pr', review: { mode: 'none', groupIds: [] } } })
    .where(eq(apps.id, f.app.id))
  const row = await insertSession(db, f, { status: 'requested', title: null })
  const runs: GateRun[] = []
  const counts = { lint: 0, typecheck: 0, test: 0 }
  const branch = sessionBranchName(row.shortId)
  const ports = createFakeSessionPorts({
    sessionDb: d =>
      new NeonSessionDb(d, cfg, { fetch: cloud.fetch, sleep: async () => {}, apiKey: NEON_KEY }),
    repoHost: d =>
      new GitHubRepoHost(d, cfg, {
        fetch: cloud.fetch,
        github: {
          auth: { appId: String(cloud.opts.appId), privateKey: APP_PEM },
          installationId: cloud.opts.installationId,
          org: cloud.opts.org,
        },
      }),
  })
  const h = {} as Harness
  const gateScript =
    (step: GateRun['step']) => (_command: string, procOpts?: SandboxExecOptions) => {
      const sandbox = ports.sandbox(row.id) as FakeSandbox
      const runEnv = { ...(procOpts?.env ?? {}) }
      const run: GateRun = { step, env: runEnv, allowedHosts: [...sandbox.allowedHosts] }
      if (step === 'test') {
        const name = runEnv.TEST_DATABASE_BRANCH ?? ''
        const found = cloud.neon.branchNamed(f.neonProjectId, name)
        if (found) run.branch = { name, parentId: found.parent_id, host: found.host }
      }
      runs.push(run)
      const n = ++counts[step]
      const outcome = opts.gate?.[step]?.(run, n) ?? {}
      if (outcome === 'hang') return new Promise<never>(() => {})
      // The kit's `pnpm test` (0.16.0) names its target first; a legacy kit's says nothing of it.
      const banner =
        step === 'test' && (opts.kit ?? 'gate') === 'gate'
          ? `test target: remote Neon branch ${run.branch?.name} (no Docker; the whole suite under neon)\n`
          : ''
      return { exitCode: outcome.exitCode ?? 0, log: banner + (outcome.log ?? `${step}: ok\n`) }
    }
  ports.script(sandbox =>
    scriptKitGate(sandbox, opts.kit ?? 'gate', opts.gateList, opts.trees)
      .onExec(/git init/, { stdout: `base=${BASE_SHA}\nhead=${BASE_SHA}\n` })
      .onExec(/sha256sum/, { stdout: `migrations=${'a'.repeat(64)}\n` })
      .onExec(WORKSPACE_CHANGED_SCRIPT, { stdout: `${BASE_SHA}\nclean\n` })
      .onExec(/git -C \/workspace\/app diff --stat/, {
        stdout:
          ' src/ui/pages/Home.tsx | 4 ++--\n 1 file changed, 2 insertions(+), 2 deletions(-)\n',
      })
      .onProcess(/exec pnpm dev /, { lines: ['ready'], ports: [5173, 8787], hang: true })
      // The `pnpm gate <step>` commands, or a legacy kit's three.
      .onBackground(/pnpm (gate )?lint/, gateScript('lint'))
      .onBackground(/pnpm (gate )?typecheck/, gateScript('typecheck'))
      .onBackground(/pnpm (gate test|test:ephemeral)/, gateScript('test'))
  )
  const fixes: string[] = []
  const checkpoints: string[] = []
  const summary = new FakeChatClient([
    { text: SUMMARY, usage: { inputTokens: 800, outputTokens: 40 } },
  ])
  const hooks: SessionStepHooks = {
    runTurn: async () => {
      throw new Error('no chat turn in this suite')
    },
    checkpoint: async (ctx, reason) => {
      checkpoints.push(reason)
      // The push lands the branch on GitHub, as the real checkpoint's would.
      const sha = cloud.github.pushCommit(
        f.repo.owner,
        f.repo.repo,
        { 'src/ui/pages/Home.tsx': `export default () => <b>Hello ${checkpoints.length}</b>\n` },
        `Launch session ${row.shortId}`,
        branch
      )
      if (opts.trackHead) {
        await db.update(sessions).set({ headSha: sha }).where(eq(sessions.id, ctx.session.id))
      }
    },
    shipFix: async (ctx, input) => {
      fixes.push(input.message)
      opts.onFix?.(h)
      return { outcome: 'completed', turn: ctx.session.turnCount + 1, text: 'Fixed it.' }
    },
    shipSummary: (ctx, input) =>
      summarizeShip(ctx.db, ctx.cfg, ctx.env, ctx.session, input, {
        client: { client: summary, provider: 'anthropic', model: 'claude-haiku-4-5' },
      }),
    ...UNEXPECTED_LAND_HOOKS,
  }
  Object.assign(h, {
    env,
    cloud,
    f,
    row,
    ports,
    hooks,
    runs,
    fixes,
    checkpoints,
    summary,
    sandbox: () => ports.sandbox(row.id) as FakeSandbox,
  })
  return h
}

async function patch(row: SessionRow, set: Partial<typeof sessions.$inferInsert>) {
  await db
    .update(sessions)
    .set(set)
    .where(and(eq(sessions.tenantId, row.tenantId), eq(sessions.id, row.id)))
}

async function reload(row: SessionRow): Promise<SessionRow> {
  const [latest] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.tenantId, row.tenantId), eq(sessions.id, row.id)))
  if (!latest) throw new Error('session vanished')
  return latest
}

/**
 * Run the Workflow: the first wait asks for the ship; every later one ends the session (what a
 * person reading "no pull request" would do next, and how the run ends).
 */
async function drive(
  h: Harness,
  first: () => Promise<void> | void = () => {},
  /** Steps whose body runs TWICE — a retry after the first try's result was lost. */
  retry?: RegExp
) {
  let waits = 0
  const fake = createFakeWorkflowStep({
    onWait: async () => {
      if (waits++ === 0) {
        await first()
        await patch(h.row, { requestedAction: 'ship' })
      } else {
        await patch(h.row, { requestedAction: 'end' })
      }
      return WAKE
    },
  })
  const results: unknown[] = []
  const realDo = fake.step.do.bind(fake.step) as (...args: unknown[]) => Promise<unknown>
  ;(fake.step as { do: unknown }).do = async (...args: unknown[]) => {
    if (retry?.test(String(args[0]))) {
      const fn = args[args.length - 1] as () => Promise<unknown>
      await fn()
    }
    const result = await realDo(...args)
    results.push(result)
    return result
  }
  const workflow = new SessionWorkflow(createExecutionContext(), h.env)
  workflow.overrides = { ports: h.ports, hooks: h.hooks, limits: LIMITS }
  const outcome = await workflow.run(
    {
      payload: { sessionId: h.row.id, tenantId: h.row.tenantId },
      timestamp: new Date(),
      instanceId: h.row.id,
      workflowName: 'launch-session',
    },
    fake.step as unknown as Parameters<SessionWorkflow['run']>[1]
  )
  expect(new Set(fake.names).size).toBe(fake.names.length)
  return { outcome, names: fake.names, calls: fake.calls, results }
}

const BOOT = ['claim', 'db', 'sandbox.start', 'repo', 'bootstrap', 'dev']
const eventsOf = (h: Harness) => listSessionEvents(db, h.row.tenantId, h.row.id, 0, 5000)
const gateEvents = async (h: Harness) =>
  (await eventsOf(h))
    .filter(e => e.type === 'ship.gate')
    .map(e => sessionShipGateDataSchema.parse(e.data))
const errorsOf = async (h: Harness) =>
  (await eventsOf(h))
    .filter(e => e.type === 'error')
    .map(e => (e.data as { message: string }).message)
/** Every gate branch the project has now. */
const gateBranchesLeft = (h: Harness) =>
  [...(h.cloud.neon.projects.get(h.f.neonProjectId)?.branches.values() ?? [])]
    .map(b => b.name)
    .filter(name => name.startsWith('gate-'))

/** The credential a test run was handed: neither it nor its password may be anywhere a person reads. */
function expectNoCredential(label: string, value: unknown, runs: GateRun[]) {
  const text = JSON.stringify(value)
  for (const run of runs) {
    const uri = run.env.DATABASE_URL
    if (!uri) continue
    const password = decodeURIComponent(new URL(uri).password)
    expect(password.length, label).toBeGreaterThan(5)
    expect(text, label).not.toContain(uri)
    expect(text, label).not.toContain(password)
  }
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('the ship gate: green', () => {
  it('Launch runs lint, typecheck and the tests on a gate branch; the PR takes ONE model call — the summary', async () => {
    const h = await harness()
    const run = await drive(h)
    expect(run.outcome.status).toBe('shipped')
    expect(run.names).toEqual([
      ...BOOT,
      'inspect#0',
      'wait#0',
      'inspect#1',
      'ship.claim#1',
      'ship.save#1',
      'ship.kit#1',
      'ship.gate#1.1.lint',
      'ship.gate#1.1.typecheck',
      'ship.db#1.1',
      'ship.gate#1.1.test',
      'ship.db-clean#1.1',
      'ship.commit#1',
      'ship.attest#1',
      'ship.summary#1',
      'ship.pr#1',
      'cleanup',
    ])

    // The kit: probed once, and asked for its own step list.
    expect(h.sandbox().commands.filter(c => c === GATE_LIST_COMMAND)).toHaveLength(1)
    // The gate: the kit's `pnpm gate` steps minus build, which Launch ran itself, one event each,
    // all green — and no model call to judge them: no fix turn, no `claude` process, and exactly
    // one summary call.
    expect(h.runs.map(r => r.step)).toEqual(['lint', 'typecheck', 'test'])
    expect(
      h
        .sandbox()
        .backgroundRuns.filter(r => r.name.startsWith('gate-'))
        // The runner script wraps the real command.
        .map(r => /pnpm gate [a-z]+/.exec(r.command)?.[0])
    ).toEqual(['pnpm gate lint', 'pnpm gate typecheck', 'pnpm gate test'])
    const name = gateBranchName(h.row.shortId, 1)
    expect(await gateEvents(h)).toEqual([
      expect.objectContaining({
        step: 'lint',
        passed: true,
        attempt: 1,
        command: 'pnpm gate lint',
      }),
      expect.objectContaining({ step: 'typecheck', passed: true, command: 'pnpm gate typecheck' }),
      // The test row carries the target line the kit's `pnpm test` printed first.
      expect.objectContaining({
        step: 'test',
        passed: true,
        command: 'pnpm gate test',
        target: `test target: remote Neon branch ${name} (no Docker; the whole suite under neon)`,
      }),
    ])
    expect((await gateEvents(h))[0]).not.toHaveProperty('target')
    expect(h.fixes).toEqual([])
    expect(h.sandbox().processes.some(p => p.command.includes('claude'))).toBe(false)
    expect(h.summary.calls).toHaveLength(1)
    expect(h.summary.calls[0]?.tools).toBeUndefined()
    // Every command ran from the checkout, in the background, with a deadline of its own.
    for (const bg of h.sandbox().backgroundRuns.filter(r => r.name.startsWith('gate-'))) {
      expect(bg.opts?.cwd).toBe('/workspace/app')
    }
    const gateConfigs = run.calls.filter(c => c.name.startsWith('ship.gate#'))
    expect(gateConfigs.map(c => c.config?.timeout)).toEqual([
      '10 minutes',
      '15 minutes',
      '30 minutes',
    ])

    // The test step: the kit's contract exactly — and a gate branch that was a CHILD of the
    // session's, reachable through exactly its hosts, only while the step ran.
    const row = await reload(h.row)
    const cfg = loadConfig(h.env)
    const base = gateBaseEnv(devEnvFor(cfg, row))
    const lint = h.runs.find(r => r.step === 'lint')
    const test = h.runs.find(r => r.step === 'test')
    expect(lint?.env).toEqual(base)
    expect(test?.branch?.name).toBe(name)
    expect(test?.branch?.parentId).toBe((row.db as { branchId?: string } | null)?.branchId)
    const endpoint = test?.branch?.host.split('.')[0]
    expect(Object.keys(test?.env ?? {}).sort()).toEqual(
      [
        ...Object.keys(base),
        'DATABASE_URL',
        'TEST_DATABASE_BRANCH',
        'TEST_DATABASE_ENDPOINT',
      ].sort()
    )
    expect(test?.env).toMatchObject({
      ...base,
      TEST_DATABASE_BRANCH: name,
      TEST_DATABASE_ENDPOINT: endpoint,
    })
    expect(test?.env).not.toHaveProperty('NEON_LOCAL_PROXY')
    expect(test?.env).not.toHaveProperty('APP_DATABASE_URL')
    const url = new URL(test?.env.DATABASE_URL ?? '')
    expect(url.hostname).toBe(test?.branch?.host)
    expect(decodeURIComponent(url.username)).toBe('session_owner')
    expect(url.pathname).toBe('/session_app')
    const [direct, pooler, api] = gateEgressHosts({ host: test?.branch?.host ?? '' })
    for (const host of [direct, pooler, api]) expect(test?.allowedHosts).toContain(host)
    // The endpoint's own hosts only while the tests run (the region's SQL host is the session's too).
    expect(lint?.allowedHosts).not.toContain(direct)
    expect(lint?.allowedHosts).not.toContain(pooler)
    expect(h.sandbox().allowedHosts).not.toContain(direct)
    expect(gateBranchesLeft(h)).toEqual([])

    // The PR: the summary's title and body, and Launch's line about the gate.
    const pr = h.cloud.github.pulls.find(p => p.head === sessionBranchName(row.shortId))
    expect(pr).toMatchObject({ title: 'Greet people on the home page', base: 'main' })
    expect(pr?.body).toContain('Adds a bold greeting.')
    expect(pr?.body).toContain('`pnpm gate lint`, `pnpm gate typecheck`, `pnpm gate test`')
    expect(row.status).toBe('shipped')
    expect(row.prNumber).toBe(pr?.number)
    // Issue #5: `pr` mode — the landing stops at stage `pr`; the summary the model wrote is kept
    // on the session (without Launch's footer), with the diff stat it was written from.
    expect(row.landing).toMatchObject({ mode: 'pr', stage: 'pr', prNumber: pr?.number })
    expect(row.shipSummary).toMatchObject({
      title: 'Greet people on the home page',
      body: 'Adds a bold greeting.',
      source: 'model',
      diffStat: expect.stringContaining('src/ui/pages/Home.tsx'),
      prNumber: pr?.number,
      gateSha: row.headSha,
    })
    const prEvent = (await eventsOf(h)).find(e => e.type === 'ship.pr')
    expect(prEvent?.data).toMatchObject({ title: 'Greet people on the home page' })
    // Saved before the gate and before the PR; the summary billed to the session.
    expect(h.checkpoints).toEqual(['ship', 'ship'])
    const usage = await db
      .select()
      .from(aiUsage)
      .where(and(eq(aiUsage.tenantId, row.tenantId), eq(aiUsage.sessionId, row.id)))
    expect(usage.map(u => u.feature)).toEqual([SHIP_SUMMARY_FEATURE])
    expect(Number(row.costMicrocents)).toBeGreaterThan(0)

    // Nothing a person reads, and no step result, carries the database credential.
    expectNoCredential('events', await eventsOf(h), h.runs)
    expectNoCredential('step results', run.results, h.runs)
    expectNoCredential('row', row, h.runs)
  })
})

describe('the gate attestation (issue #9)', () => {
  const OTHER_TREE = 'd'.repeat(40)
  const attestErrors = async (h: Harness) =>
    (await errorsOf(h)).filter(m => m.includes(LAUNCH_GATE_CHECK))

  it('a green gate posts exactly ONE launch/gate on the pushed head, keyed by its tree — a retried step posts nothing new', async () => {
    const h = await harness({ trackHead: true })
    // `ship.attest` runs its body twice: the second try finds the first's run.
    const run = await drive(h, () => {}, /^ship\.attest#/)
    expect(run.outcome.status).toBe('shipped')
    const names = run.names
    expect(names.indexOf('ship.attest#1')).toBe(names.indexOf('ship.commit#1') + 1)
    expect(names.indexOf('ship.summary#1')).toBe(names.indexOf('ship.attest#1') + 1)

    const row = await reload(h.row)
    const created = h.cloud.github.createdCheckRuns
    expect(created).toHaveLength(1)
    const [check] = created
    expect(check).toMatchObject({
      owner: h.f.repo.owner,
      repo: h.f.repo.repo,
      name: 'launch/gate',
      head_sha: row.headSha,
      status: 'completed',
      conclusion: 'success',
      external_id: `tree:${GATE_TREE}`,
      app: 'company-launch',
    })
    expect(check?.output?.title).toBe('Launch gate passed: lint, typecheck, tests')
    expect(check?.output?.summary).toContain('| lint | `pnpm gate lint` |')
    expect(check?.output?.summary).toContain('| test | `pnpm gate test` |')
    const text = JSON.parse(check?.output?.text ?? '{}')
    expect(text).toEqual({
      tree: GATE_TREE,
      sessionId: row.id,
      attempt: 1,
      steps: [
        { step: 'lint', command: 'pnpm gate lint', durationMs: expect.any(Number) },
        { step: 'typecheck', command: 'pnpm gate typecheck', durationMs: expect.any(Number) },
        { step: 'test', command: 'pnpm gate test', durationMs: expect.any(Number) },
      ],
    })
    // On the head commit's check runs exactly once, beside nothing else.
    const onHead = h.cloud.github.checkRuns.get(
      `${h.f.repo.owner}/${h.f.repo.repo}`.toLowerCase() + `@${row.headSha}`
    )
    expect(onHead?.filter(r => r.name === LAUNCH_GATE_CHECK)).toHaveLength(1)

    // The tree is the gate's last step's, and it is recorded next to the gate SHA.
    const gates = await gateEvents(h)
    expect(gates.at(-1)).toMatchObject({ step: 'test', passed: true, tree: GATE_TREE })
    expect(gates.slice(0, -1).every(g => g.tree === undefined)).toBe(true)
    expect(row.landing).toMatchObject({ gateSha: row.headSha, gateTree: GATE_TREE })
    expect(row.shipSummary).toMatchObject({ gateSha: row.headSha, gateTree: GATE_TREE })
    expect(await attestErrors(h)).toEqual([])
  })

  it('a red gate posts none (and never reads a tree)', async () => {
    const h = await harness({
      trackHead: true,
      gate: { test: () => ({ exitCode: 1, log: 'FAIL tests/home.test.ts' }) },
    })
    const run = await drive(h)
    expect(run.names.some(n => n.startsWith('ship.attest#'))).toBe(false)
    expect(run.names.some(n => n.startsWith('ship.commit#'))).toBe(false)
    expect(h.cloud.github.createdCheckRuns).toEqual([])
    expect(h.sandbox().commands.some(c => c.includes('launch-tree-index'))).toBe(false)
    expect(h.cloud.github.pulls).toHaveLength(0)
  })

  it('a workspace that changed after the gate is refused: nothing committed, attested or opened', async () => {
    let reads = 0
    const h = await harness({
      trackHead: true,
      // The gate's read, then `ship.commit`'s: something wrote a file in between.
      trees: { worktree: () => ({ stdout: `tree=${++reads === 1 ? GATE_TREE : OTHER_TREE}\n` }) },
    })
    const run = await drive(h)
    expect(run.names).toContain('ship.commit#1')
    expect(run.names).toContain('ship.settle#1')
    expect(run.names.some(n => /^ship\.(attest|summary|pr)#/.test(n))).toBe(false)
    // Saved before the gate only: the commit's checkpoint never ran (the end then saves the work).
    expect(h.checkpoints).toEqual(['ship', 'end'])
    expect(h.cloud.github.createdCheckRuns).toEqual([])
    expect(h.cloud.github.pulls).toHaveLength(0)
    expect(await errorsOf(h)).toContainEqual(
      expect.stringContaining('The work changed after the gate passed')
    )
    const row = await reload(h.row)
    expect(row.prNumber).toBeNull()
    expect(row.landing).toBeNull()
  })

  it('a commit that is not the gated tree (the checkpoint left something out) opens nothing', async () => {
    const h = await harness({
      trackHead: true,
      trees: { head: { stdout: `${OTHER_TREE}\n` } },
    })
    const run = await drive(h)
    expect(h.checkpoints.filter(r => r === 'ship')).toEqual(['ship', 'ship'])
    expect(run.names.some(n => /^ship\.(attest|summary|pr)#/.test(n))).toBe(false)
    expect(h.cloud.github.createdCheckRuns).toEqual([])
    expect(h.cloud.github.pulls).toHaveLength(0)
    expect(await errorsOf(h)).toContainEqual(
      expect.stringContaining('The work changed after the gate passed')
    )
  })

  it('a tree that cannot be read fails closed: the round settles with the reason, no PR', async () => {
    const h = await harness({
      trackHead: true,
      trees: { worktree: { exitCode: 128, stderr: 'fatal: not a git repository' } },
    })
    const run = await drive(h)
    expect(run.names.some(n => /^ship\.(commit|attest|pr)#/.test(n))).toBe(false)
    expect(h.cloud.github.pulls).toHaveLength(0)
    expect(await errorsOf(h)).toContainEqual(expect.stringContaining('not a git repository'))
  })

  it('an installation without checks: write cannot attest — the ship still opens its PR, and says why once', async () => {
    const h = await harness({ trackHead: true })
    // Installed before issue #9: the new permission not accepted yet.
    Object.assign(h.cloud.github.opts, {
      permissions: { ...h.cloud.github.permissions, checks: 'read' },
    })
    const run = await drive(h)
    expect(run.outcome.status).toBe('shipped')
    expect(run.names).toContain('ship.attest#1')
    expect(h.cloud.github.createdCheckRuns).toEqual([])
    expect(h.cloud.github.pulls).toHaveLength(1)
    const errors = await attestErrors(h)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('The ship carries on')
    expect(errors[0]).toContain('not granted')
    // The tree is still recorded: the landing does not depend on the attestation.
    expect((await reload(h.row)).landing).toMatchObject({ gateTree: GATE_TREE })
  })

  it('GitHub failing the POST does not fail the ship either', async () => {
    const h = await harness({ trackHead: true })
    h.cloud.failNext(/POST https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/check-runs$/, 502)
    const run = await drive(h)
    expect(run.outcome.status).toBe('shipped')
    expect(h.cloud.github.createdCheckRuns).toEqual([])
    expect(await attestErrors(h)).toHaveLength(1)
  })
})

describe('the ship gate: red', () => {
  it('a red test gets ONE fix turn with the command and its redacted tail; the gate runs again and ships', async () => {
    const h = await harness({
      gate: {
        test: (run, n) =>
          n === 1
            ? {
                exitCode: 1,
                log: [
                  ' FAIL  tests/api/orders.test.ts > lists orders',
                  'AssertionError: expected 2 to be 3',
                  `connecting to ${run.env.DATABASE_URL}`,
                ].join('\n'),
              }
            : { exitCode: 0 },
      },
    })
    const run = await drive(h)
    expect(run.outcome.status).toBe('shipped')
    expect(run.names.slice(BOOT.length + 3)).toEqual([
      'ship.claim#1',
      'ship.save#1',
      'ship.kit#1',
      'ship.gate#1.1.lint',
      'ship.gate#1.1.typecheck',
      'ship.db#1.1',
      'ship.gate#1.1.test',
      'ship.db-clean#1.1',
      'ship.fix#1.1',
      'ship.gate#1.2.lint',
      'ship.gate#1.2.typecheck',
      'ship.db#1.2',
      'ship.gate#1.2.test',
      'ship.db-clean#1.2',
      'ship.commit#1',
      'ship.attest#1',
      'ship.summary#1',
      'ship.pr#1',
      'cleanup',
    ])
    // One focused turn: the failing command, the tail — with the credential scrubbed out.
    expect(h.fixes).toHaveLength(1)
    const [message] = h.fixes
    expect(message).toContain('`pnpm gate test`')
    expect(message).toContain('attempt 1 of 3')
    expect(message).toContain('expected 2 to be 3')
    expect(message).toContain('<database url>')
    expectNoCredential('fix message', message, h.runs)
    // Each attempt had its own gate branch, and neither outlived its test step.
    const row = await reload(h.row)
    expect(h.runs.filter(r => r.step === 'test').map(r => r.branch?.name)).toEqual([
      gateBranchName(row.shortId, 1),
      gateBranchName(row.shortId, 2),
    ])
    expect(gateBranchesLeft(h)).toEqual([])
    const gates = await gateEvents(h)
    expect(gates.map(g => `${g.attempt}.${g.step}:${g.passed}`)).toEqual([
      '1.lint:true',
      '1.typecheck:true',
      '1.test:false',
      '2.lint:true',
      '2.typecheck:true',
      '2.test:true',
    ])
    expect(gates[2]?.output).toContain('FAIL  tests/api/orders.test.ts')
    expectNoCredential('events', await eventsOf(h), h.runs)
    expectNoCredential('step results', run.results, h.runs)
    expect(h.cloud.github.pulls.at(-1)?.body).toContain('after 1 fix turn')
    expect(h.summary.calls).toHaveLength(1)
  })

  it('exhausted attempts: two fix turns, three red runs, no PR — and it says so', async () => {
    const h = await harness({
      gate: { lint: () => ({ exitCode: 1, log: 'src/ui/Home.tsx:3 error: unused variable' }) },
    })
    const run = await drive(h)
    expect(run.names.slice(BOOT.length + 3)).toEqual([
      'ship.claim#1',
      'ship.save#1',
      'ship.kit#1',
      'ship.gate#1.1.lint',
      'ship.fix#1.1',
      'ship.gate#1.2.lint',
      'ship.fix#1.2',
      'ship.gate#1.3.lint',
      'ship.settle#1',
      'inspect#2',
      'wait#2',
      'inspect#3',
      'end#3',
      'cleanup',
    ])
    expect(h.fixes).toHaveLength(2)
    expect(h.fixes[1]).toContain('attempt 2 of 3')
    expect(h.fixes[0]).toContain('unused variable')
    expect(h.summary.calls).toHaveLength(0)
    expect(h.cloud.github.pulls).toHaveLength(0)
    // Lint never passed: no gate branch was ever made.
    expect(h.runs.some(r => r.step === 'test')).toBe(false)
    expect(
      h.cloud
        .callsTo('neon')
        .some(c => c.method === 'POST' && JSON.stringify(c.body).includes('"gate-'))
    ).toBe(false)
    expect((await gateEvents(h)).map(g => `${g.attempt}.${g.step}:${g.passed}`)).toEqual([
      '1.lint:false',
      '2.lint:false',
      '3.lint:false',
    ])
    expect(await errorsOf(h)).toContainEqual(
      expect.stringContaining('The gate still fails after 3 attempts')
    )
    const row = await reload(h.row)
    expect(row.prNumber).toBeNull()
    expect(row.status).toBe('ended')
  })
})

describe('the ship gate: which kit', () => {
  /** The round stops at `ship.kit`: nothing ran, no fix turn, no branch, and it says why. */
  async function expectRefused(h: Harness, output: unknown, command: string) {
    const run = await drive(h)
    expect(run.names.slice(BOOT.length + 3, BOOT.length + 8)).toEqual([
      'ship.claim#1',
      'ship.save#1',
      'ship.kit#1',
      'ship.settle#1',
      'inspect#2',
    ])
    expect(h.runs).toEqual([])
    expect(h.fixes).toEqual([])
    expect(await gateEvents(h)).toEqual([
      expect.objectContaining({ step: 'test', passed: false, attempt: 1, command, output }),
    ])
    expect(await errorsOf(h)).toContainEqual(expect.stringContaining('cannot run on this app'))
    expect(
      h.cloud
        .callsTo('neon')
        .some(c => c.method === 'POST' && JSON.stringify(c.body).includes('"gate-'))
    ).toBe(false)
    expect(h.cloud.github.pulls).toHaveLength(0)
  }

  it('a legacy kit (test:ephemeral, 0.15.7 up to 0.16.0) ships through its three commands', async () => {
    const h = await harness({ kit: 'legacy' })
    const run = await drive(h)
    expect(run.outcome.status).toBe('shipped')
    // Not asked for a list it does not have.
    expect(h.sandbox().commands).not.toContain(GATE_LIST_COMMAND)
    expect((await gateEvents(h)).map(g => g.command)).toEqual([
      'pnpm lint',
      'pnpm typecheck',
      'pnpm test:ephemeral',
    ])
    // The same three-variable database contract, and no target line (the legacy script prints none).
    const test = h.runs.find(r => r.step === 'test')
    expect(test?.env).toHaveProperty('TEST_DATABASE_BRANCH', gateBranchName(h.row.shortId, 1))
    expect((await gateEvents(h)).at(-1)).not.toHaveProperty('target')
    expect(gateBranchesLeft(h)).toEqual([])
    expect(h.cloud.github.pulls.at(-1)?.body).toContain(
      '`pnpm lint`, `pnpm typecheck`, `pnpm test:ephemeral`'
    )
  })

  it('a kit with neither (before 0.15.7): the upgrade message, and nothing runs', async () => {
    const h = await harness({ kit: 'none' })
    await expectRefused(h, GATE_KIT_TOO_OLD_MESSAGE, 'pnpm gate test')
  })

  it('a kit list with a step Launch does not know: refused by name, never skipped', async () => {
    const list = JSON.parse(KIT_GATE_LIST_JSON) as { schema: number; steps: unknown[] }
    list.steps.push({ id: 'smoke', command: 'playwright test', database: true })
    const h = await harness({ gateList: JSON.stringify(list) })
    await expectRefused(
      h,
      expect.stringMatching(/`smoke`.*same checks as the app/s),
      GATE_LIST_COMMAND
    )
  })

  it('a gate that prints no list (or a schema Launch cannot read) is refused', async () => {
    const h = await harness({ gateList: JSON.stringify({ schema: 2, steps: [] }) })
    await expectRefused(h, GATE_LIST_UNREADABLE_MESSAGE, GATE_LIST_COMMAND)
  })
})

describe('the ship gate: stopped', () => {
  it('ended mid-gate: the test run is killed, its branch deleted, and the session ends', async () => {
    const h: Harness = await harness({
      gate: {
        test: () => {
          // The person clicks End while the tests run (the route: `end` + a cancel).
          void patch(h.row, { requestedAction: 'end', cancelRequestedAt: new Date() })
          return 'hang'
        },
      },
    })
    const run = await drive(h)
    expect(run.names.slice(BOOT.length + 3)).toEqual([
      'ship.claim#1',
      'ship.save#1',
      'ship.kit#1',
      'ship.gate#1.1.lint',
      'ship.gate#1.1.typecheck',
      'ship.db#1.1',
      'ship.gate#1.1.test',
      'ship.db-clean#1.1',
      'ship.settle#1',
      'inspect#2',
      'end#2',
      'cleanup',
    ])
    expect(h.sandbox().backgroundRuns.find(r => r.name === 'gate-test')?.killed).toBe(true)
    expect(h.runs.find(r => r.step === 'test')?.branch).toBeTruthy()
    expect(gateBranchesLeft(h)).toEqual([])
    expect(h.fixes).toEqual([])
    expect((await gateEvents(h)).map(g => g.step)).toEqual(['lint', 'typecheck'])
    const row = await reload(h.row)
    expect(row.status).toBe('ended')
    expect(row.prNumber).toBeNull()
  })

  it('container lost mid-gate: suspended (never ready), the branch deleted, then it resumes', async () => {
    const h: Harness = await harness({
      gate: {
        test: () => {
          // Out of memory under the test run: the container comes back empty.
          setTimeout(() => h.sandbox().recreate(), 0)
          return 'hang'
        },
      },
    })
    const run = await drive(h)
    const after = run.names.slice(BOOT.length + 3)
    expect(after.slice(0, 11)).toEqual([
      'ship.claim#1',
      'ship.save#1',
      'ship.kit#1',
      'ship.gate#1.1.lint',
      'ship.gate#1.1.typecheck',
      'ship.db#1.1',
      'ship.gate#1.1.test',
      'ship.db-clean#1.1',
      // No settle: the session is suspended with a resume asked, not put back to ready.
      'inspect#2',
      'resume#2',
      'sandbox.start#1',
    ])
    expect(after).not.toContain('ship.settle#1')
    expect(await errorsOf(h)).toContain(SHIP_CONTAINER_LOST_MESSAGE)
    const statuses = (await eventsOf(h))
      .filter(e => e.type === 'status')
      .map(e => (e.data as { status: string; reason?: string }).status)
    expect(statuses).toContain('booting') // the resume
    expect(gateBranchesLeft(h)).toEqual([])
    expect(h.fixes).toEqual([])
    expect(h.cloud.github.pulls).toHaveLength(0)
    expect((await reload(h.row)).status).toBe('ended')
  })

  it('container lost before the gate: ship.save finds it empty and saves nothing', async () => {
    const h = await harness()
    const run = await drive(h, () => {
      h.sandbox().recreate()
    })
    const after = run.names.slice(BOOT.length + 3)
    expect(after.slice(0, 4)).toEqual(['ship.claim#1', 'ship.save#1', 'inspect#2', 'resume#2'])
    // Nothing saved for the ship (the session's later end saves the resumed container's).
    expect(h.checkpoints).not.toContain('ship')
    expect(h.runs).toEqual([])
    expect(await errorsOf(h)).toContain(SHIP_CONTAINER_LOST_MESSAGE)
  })

  it('the Workflow gone mid-gate: cleanup deletes the gate branch BEFORE the session’s', async () => {
    const h = await harness()
    const cfg = loadConfig(h.env)
    const port = new NeonSessionDb(db, cfg, {
      fetch: h.cloud.fetch,
      sleep: async () => {},
      apiKey: NEON_KEY,
    })
    const app = { ...sessionAppRef(h.f), sessionDb: (await reloadApp(h)).sessionDb ?? null }
    const own = await port.createBranch(app, h.row)
    const gate = await port.createGateBranch(app, own.db, gateBranchName(h.row.shortId, 4))
    expect(
      h.cloud.neon.projects.get(h.f.neonProjectId)?.branches.get(gate.branchId)?.parent_id
    ).toBe(own.db.branchId)
    // A ship whose instance died mid-gate; the person's End reached a fresh instance.
    await patch(h.row, { status: 'ending', db: own.db })
    const run = await drive(h)
    expect(run.names).toEqual(['claim', 'cleanup'])
    expect(gateBranchesLeft(h)).toEqual([])
    expect(h.cloud.neon.branchNamed(h.f.neonProjectId, `session-${h.row.shortId}`)).toBeUndefined()
    expect((await reload(h.row)).status).toBe('ended')
  })
})

async function reloadApp(h: Harness) {
  const [app] = await db
    .select()
    .from(apps)
    .where(and(eq(apps.tenantId, h.f.tenant.id), eq(apps.id, h.f.app.id)))
  if (!app) throw new Error('app vanished')
  return app
}

describe('the gate branches in Neon', () => {
  it('a gate branch is a child of the session’s, found again by name; its URI resets the password', async () => {
    const h = await harness()
    const cfg = loadConfig(h.env)
    const port = new NeonSessionDb(db, cfg, {
      fetch: h.cloud.fetch,
      sleep: async () => {},
      apiKey: NEON_KEY,
    })
    const app = { ...sessionAppRef(h.f), sessionDb: (await reloadApp(h)).sessionDb ?? null }
    const own = await port.createBranch(app, h.row)
    const name = gateBranchName(h.row.shortId, 1)
    const first = await port.createGateBranch(app, own.db, name)
    const again = await port.createGateBranch(app, own.db, name)
    expect(again).toEqual(first)
    expect(first.endpointId).toBe(first.host.split('.')[0])
    const fake = h.cloud.neon.branchNamed(h.f.neonProjectId, name)
    expect(fake?.parent_id).toBe(own.db.branchId)

    const uri = await port.gateBranchUri(app, first)
    expect(new URL(uri).hostname).toBe(first.host)
    expect(new URL(uri).searchParams.get('sslmode')).toBe('require')
    expect(fake?.roles.get('session_owner')?.resets).toBe(1)

    // Another session's gate branch, and a second one of this session's.
    const other = await port.createGateBranch(app, own.db, 'gate-zzzzzzzzzzzz-1')
    await port.createGateBranch(app, own.db, gateBranchName(h.row.shortId, 2))
    expect(await port.deleteGateBranches(app, h.row.shortId, { keep: name })).toEqual([
      gateBranchName(h.row.shortId, 2),
    ])
    expect(await port.deleteGateBranches(app, h.row.shortId)).toEqual([name])
    expect(await port.deleteGateBranches(app, h.row.shortId)).toEqual([])
    expect(gateBranchesLeft(h)).toEqual([other.name])
    await expect(port.createGateBranch(app, own.db, 'session-x')).rejects.toThrow(/gate branch/)
  })

  it('the sweep deletes gate branches older than three hours — only those', async () => {
    const h = await harness()
    const cfg = loadConfig(h.env)
    const port = new NeonSessionDb(db, cfg, {
      fetch: h.cloud.fetch,
      sleep: async () => {},
      apiKey: NEON_KEY,
    })
    const app = { ...sessionAppRef(h.f), sessionDb: (await reloadApp(h)).sessionDb ?? null }
    const own = await port.createBranch(app, h.row)
    const old = await port.createGateBranch(app, own.db, gateBranchName(h.row.shortId, 1))
    await port.createGateBranch(app, own.db, gateBranchName(h.row.shortId, 2))
    const project = h.cloud.neon.projects.get(h.f.neonProjectId)
    const fourHoursAgo = new Date(Date.now() - 4 * 3_600_000).toISOString()
    const oldBranch = project?.branches.get(old.branchId)
    if (oldBranch) oldBranch.created_at = fourHoursAgo
    const session = project?.branches.get(own.db.branchId)
    if (session) session.created_at = fourHoursAgo

    // Only this fixture's project is swept here (the shared database holds other suites' apps,
    // whose projects live in other FakeClouds).
    const scoped = Object.create(port) as NeonSessionDb
    scoped.sweepGateBranches = (ref, olderThan) =>
      ref.neonProjectId === h.f.neonProjectId
        ? port.sweepGateBranches(ref, olderThan)
        : Promise.resolve([])
    const result = await runGateSweep(db, () => scoped)
    expect(result.deleted).toBe(1)
    expect(gateBranchesLeft(h)).toEqual([gateBranchName(h.row.shortId, 2)])
    // The session's own branch is never the sweep's, however old.
    expect(h.cloud.neon.branchNamed(h.f.neonProjectId, `session-${h.row.shortId}`)).toBeTruthy()
    expect(sessionsGateSweepTask().name).toBe('sessions.gate-sweep')
  })
})
