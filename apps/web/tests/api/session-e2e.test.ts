// @vitest-isolate
// Installs the FakeCloud as the global fetch and mocks the credentials module, so this file needs its own module registry.
/**
 * A coding session END TO END under Node (Launch P3, `docs/plans/p3-sessions.md` §4): the real
 * routes (`POST /api/apps/:id/sessions`, `/turns`, `/cancel`, `/preview-grant`, `/ship`, `/end`,
 * `/resume`, `/pr`), the real `SessionWorkflow` and step bodies driven by
 * `createFakeWorkflowStep({ onWait })`, the REAL hooks (`defaultSessionStepHooks`: 3c's `runTurn`,
 * 3d's `checkpoint`, the ship's fix turn and its summary), the real ship steps (Launch runs the
 * gate itself, the tests on a throwaway Neon gate branch — issue #1), the real model proxy
 * (`handleAnthropic`), the real preview gateway, the real Neon session-db adapter and GitHub repo
 * host over the FakeCloud — with a `FakeSandbox` in place of the container and a fake Anthropic
 * upstream.
 *
 * `onWait` plays the person: each `wait#N` is where someone clicked something, so it calls the
 * ROUTE (which writes the row and wakes the instance) and returns the wake. Inside the turn, the
 * FakeSandbox's `claude` process calls the model proxy with the sandbox's container id — exactly
 * what the outbound handler receives from the platform — so the key swap and the metering are the
 * real ones.
 *
 * The credentials module is mocked over an in-memory store (`tests/helpers/credential-store.ts`):
 * `sessions_paused` and `session_policy` are GLOBAL settings other suites flip, and the model key
 * then comes from `ANTHROPIC_API_KEY` alone.
 */
import { generateKeyPairSync } from 'node:crypto'
import {
  SESSION_WAKE_EVENT,
  type Session,
  type SessionEvent,
  sessionBranchName,
  usdToMicrocents,
} from '@launch/shared/launch-sessions'
import { and, asc, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearPreviewStatusCache, handlePreview, previewHostOf } from '@/api/preview/gateway'
import { WORKSPACE_CHANGED_SCRIPT } from '@/api/services/sessions/checkpoint'
import { NeonSessionDb } from '@/api/services/sessions/db/neon-session-db'
import { handleAnthropic, MODEL_KEY_PLACEHOLDER } from '@/api/services/sessions/egress/anthropic'
import { listSessionEvents } from '@/api/services/sessions/event-log'
import { GitHubRepoHost } from '@/api/services/sessions/repo/github-repo-host'
import { claudeTranscriptPath } from '@/api/services/sessions/rocketflare-dev'
import { runSessionChecks } from '@/api/services/sessions/ship'
import { SessionWorkflow } from '@/api/workflows/session'
import { loadConfig } from '@/config'
import { aiUsage, apps, auditEvents, type SessionRow, sessions } from '@/db/schema'
import { setupTestDatabase } from '../helpers/db'
import { claudeStreamJson, createFakeAnthropic } from '../helpers/fake-anthropic'
import { createFakeCloud } from '../helpers/fake-cloud'
import type { FakeSandbox } from '../helpers/fake-sandbox'
import { json, request } from '../helpers/request'
import {
  createFakeSessionPorts,
  type FakeSessionPorts,
  type SessionAppFixture,
  scriptKitGate,
  seedSessionApp,
} from '../helpers/sessions'
import { createExecutionContext, createTestEnv, stubs, type TestEnv } from '../mocks/bindings'
import { createFakeWorkflowStep, type RecordedWait } from '../mocks/cloudflare-workers'

const store = vi.hoisted(() => ({ credentials: new Map(), settings: new Map() }))
// The ship's ONE summary call (issue #1): the real `summarizeShip` over a fake chat client — the
// resolver is the seam `services/ai` tests mock; nothing here reaches a model.
const summaryModel = vi.hoisted(() => ({
  calls: [] as unknown[],
  reply: '{"title": "Say hello on the home page", "body": "Changes the heading."}',
}))
vi.mock('@/api/services/ai/resolve', async importOriginal => {
  const actual = await importOriginal<typeof import('@/api/services/ai/resolve')>()
  const { FakeChatClient } = await import('../helpers/ai')
  return {
    ...actual,
    resolveChat: vi.fn(async () => {
      const client = new FakeChatClient(params => {
        summaryModel.calls.push(params)
        return { text: summaryModel.reply, usage: { inputTokens: 1200, outputTokens: 340 } }
      })
      return {
        client,
        provider: 'anthropic' as const,
        model: 'claude-sonnet-4-5',
        source: 'tenant' as const,
        maxOutputTokens: 1024,
      }
    }),
  }
})
vi.mock('@/api/services/launch/credentials', async importOriginal =>
  (await import('../helpers/credential-store')).mockCredentialsModule(await importOriginal(), store)
)

const db = setupTestDatabase()
const cloud = createFakeCloud()
let restoreFetch: () => void = () => {}

beforeAll(() => {
  restoreFetch = cloud.install()
})
afterAll(() => restoreFetch())
beforeEach(() => clearPreviewStatusCache())

const REAL_KEY = 'sk-ant-api03-e2eREALkeyNEVERinTHEsandbox0123456789'
const NEON_KEY = 'neon-test-key-abcdefghijklmnop'
const PREVIEW_TEMPLATE = 'http://{label}.localhost:3001'
const BASE_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
const CLAUDE_SESSION = '7c1f3a52-0d7e-4c1b-9d2e-5b8a6f4c3e21'
const { privateKey: APP_PEM } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
})

const WAKE = { type: SESSION_WAKE_EVENT, payload: {} }

interface Harness {
  env: TestEnv
  f: SessionAppFixture
  ports: FakeSessionPorts
  anthropic: ReturnType<typeof createFakeAnthropic>
  session: Session
  sandbox: () => FakeSandbox
  /** The `env` each `claude` process was started with. */
  claudeEnvs: Record<string, string>[]
  /** What each in-turn model call answered (the proxy's status). */
  modelCalls: number[]
}

interface HarnessOptions {
  /** The chat turn's `claude` process runs until killed (a cancel). */
  hangTurn?: boolean
  /** Called once a `claude` process has started (after the model call). */
  onClaudeStarted?: (h: Harness, command: string) => Promise<void>
}

/**
 * An owner's app with a prepared `dev`, then `POST /api/apps/:id/sessions` through the real
 * route — and a FakeSandbox scripted like a kit app: the clone, the dev server, the preview port,
 * git for the checkpoint (a commit lands on the FakeCloud's GitHub, as the egress push would), the
 * gate, and `claude` — which calls the model proxy as the container would.
 */
async function start(opts: HarnessOptions = {}): Promise<Harness> {
  const env = createTestEnv({ ANTHROPIC_API_KEY: REAL_KEY, SESSION_PREVIEW_URL: PREVIEW_TEMPLATE })
  const cfg = loadConfig(env)
  const f = await seedSessionApp(db, cloud, { prepared: true })
  // `pr` mode: the ship ends at the open PR (issue #5's landing is `session-land.test.ts`).
  await db
    .update(apps)
    .set({ shipSettings: { sessionShip: 'pr', review: { mode: 'none', groupIds: [] } } })
    .where(eq(apps.id, f.app.id))
  const anthropic = createFakeAnthropic({
    usage: { input: 1200, output: 340, cacheRead: 9000, cacheWrite: 800 },
  })
  const res = await request(
    `/api/apps/${f.app.id}/sessions`,
    { method: 'POST', headers: { ...f.cookie, 'X-Requested-With': 'fetch' } },
    { env, json: { title: 'Say hello' } }
  )
  expect(res.status).toBe(202)
  const { session } = await json<{ session: Session }>(res)
  expect(stubs(env).sessionWorkflow?.created.map(c => c.id)).toEqual([session.id])

  const branch = sessionBranchName(session.shortId)
  const headOf = () =>
    cloud.github.repo(f.repo.owner, f.repo.repo)?.refs.get(`heads/${branch}`) ?? BASE_SHA
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
    model: anthropic.upstream,
  })
  const h: Harness = {
    env,
    f,
    ports,
    anthropic,
    session,
    sandbox: () => ports.sandbox(session.id) as FakeSandbox,
    claudeEnvs: [],
    modelCalls: [],
  }
  let commits = 0
  ports.script(sandbox => {
    scriptKitGate(sandbox)
      .onExec(/git init/, { stdout: `base=${BASE_SHA}\nhead=${BASE_SHA}\n` })
      .onExec('git diff --cached --quiet', { exitCode: 1 })
      .onExec('git commit', () => {
        commits++
        cloud.github.pushCommit(
          f.repo.owner,
          f.repo.repo,
          { 'src/ui/pages/Home.tsx': `export default () => <h1>Hello ${commits}</h1>\n` },
          `Launch session ${session.shortId}`,
          branch
        )
        return { exitCode: 0 }
      })
      // The dirty check after a turn (before `git rev-parse HEAD`, which its script contains): a
      // turn here always edits the Home page.
      .onExec(WORKSPACE_CHANGED_SCRIPT, () => ({ stdout: `${headOf()}\ndirty\n` }))
      .onExec('git rev-parse HEAD', () => ({ stdout: `${headOf()}\n` }))
      .onProcess(/exec pnpm dev /, { lines: ['ready'], ports: [5173, 8787], hang: true })
      .onPort(
        5173,
        () =>
          new Response('<h1>Hello from the session</h1>', {
            headers: { 'content-type': 'text/html', 'X-Frame-Options': 'DENY' },
          })
      )
      .onProcess(
        /exec claude -p /,
        claudeStreamJson({
          sessionId: CLAUDE_SESSION,
          text: 'Changed the heading.',
          tools: [{ name: 'Edit', input: { file_path: 'src/ui/pages/Home.tsx' }, result: 'ok' }],
          hang: opts.hangTurn,
        })
      )
    // `claude` in the container calls api.anthropic.com; the platform hands the request to the
    // outbound handler with the container's id. Do exactly that, with what the process was given.
    const startProcess = sandbox.startProcess.bind(sandbox)
    sandbox.startProcess = async (command, procOpts) => {
      const proc = await startProcess(command, procOpts)
      if (command.includes('exec claude ')) {
        const procEnv = (procOpts?.env ?? {}) as Record<string, string>
        h.claudeEnvs.push(procEnv)
        const call = await handleAnthropic(
          new Request('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'x-api-key': procEnv.ANTHROPIC_API_KEY ?? '',
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              model: 'claude-opus-5-5-20260801',
              stream: true,
              max_tokens: 1024,
              messages: [{ role: 'user', content: 'Change the heading' }],
            }),
          }),
          env,
          { containerId: sandbox.id },
          { upstream: anthropic.upstream }
        )
        await call.text() // read to the end: the meter records when the body ends
        h.modelCalls.push(call.status)
        // Claude Code keeps its transcript in the container, where the checkpoint copies it from.
        sandbox.files.set(claudeTranscriptPath(CLAUDE_SESSION), '{"type":"user"}\n')
        await opts.onClaudeStarted?.(h, command)
      }
      return proc
    }
  })
  return h
}

/** The person's clicks, through the real routes. */
const act = {
  post: async (h: Harness, path: string, body?: unknown) =>
    request(
      `/api/sessions/${h.session.id}${path}`,
      { method: 'POST', headers: { ...h.f.cookie, 'X-Requested-With': 'fetch' } },
      { env: h.env, ...(body === undefined ? {} : { json: body }) }
    ),
  get: async (h: Harness, path: string) =>
    request(`/api/sessions/${h.session.id}${path}`, { headers: h.f.cookie }, { env: h.env }),
}

async function say(h: Harness, message: string) {
  const res = await act.post(h, '/turns', { message })
  expect(res.status).toBe(202)
  return WAKE
}

async function reload(h: Harness): Promise<SessionRow> {
  const [row] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.tenantId, h.f.tenant.id), eq(sessions.id, h.session.id)))
  if (!row) throw new Error('the session vanished')
  return row
}

/** Run the Workflow to its end; `steps[n]` answers the n-th wait (undefined → its timeout). */
async function drive(
  h: Harness,
  steps: ((wait: RecordedWait) => Promise<unknown> | unknown)[]
): Promise<{ status: string; names: string[] }> {
  let n = 0
  const fake = createFakeWorkflowStep({ onWait: wait => steps[n++]?.(wait) })
  const workflow = new SessionWorkflow(createExecutionContext(), h.env)
  workflow.overrides = { ports: h.ports } // the hooks are the REAL ones
  const outcome = await workflow.run(
    {
      payload: { sessionId: h.session.id, tenantId: h.f.tenant.id },
      timestamp: new Date(),
      instanceId: h.session.id,
      workflowName: 'launch-session',
    },
    fake.step as unknown as Parameters<SessionWorkflow['run']>[1]
  )
  expect(new Set(fake.names).size).toBe(fake.names.length)
  return { status: outcome.status, names: fake.names }
}

async function eventsOf(h: Harness): Promise<SessionEvent[]> {
  return (await listSessionEvents(db, h.f.tenant.id, h.session.id, 0, 5000)).map(e => ({
    ...e,
    data: e.data,
  })) as SessionEvent[]
}

async function auditsOf(h: Harness) {
  return db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.tenantId, h.f.tenant.id), eq(auditEvents.targetId, h.session.id)))
    .orderBy(asc(auditEvents.at))
}

async function usageOf(h: Harness) {
  return db
    .select()
    .from(aiUsage)
    .where(and(eq(aiUsage.tenantId, h.f.tenant.id), eq(aiUsage.sessionId, h.session.id)))
}

/** The session's branch on the FakeCloud's Neon, by the id the row recorded. */
function neonBranch(h: Harness, branchId: string) {
  return cloud.neon.projects.get(h.f.neonProjectId)?.branches.get(branchId)
}

/** Neither the real key nor the sandbox's placeholder, anywhere a person or the audit can read. */
function expectNoKey(label: string, value: unknown) {
  const text = JSON.stringify(value)
  expect(text, label).not.toContain(REAL_KEY)
  expect(text, label).not.toContain(MODEL_KEY_PLACEHOLDER)
  expect(text, label).not.toMatch(/sk-ant-api/)
}

async function expectCleanedUp(h: Harness, branchId: string | undefined) {
  expect(h.sandbox().destroyed).toBe(true)
  if (branchId) expect(neonBranch(h, branchId)).toBeUndefined()
  const row = await reload(h)
  expect(row.dbUriSealed).toBeNull()
  expect(row.endedAt).not.toBeNull()
  expect((await auditsOf(h)).map(a => a.action)).toContain('session.ended')
}

describe('a coding session, end to end', () => {
  it('boots, takes a metered turn, previews through the gateway, ships a green PR, and cleans up', async () => {
    const h = await start()
    let branchId: string | undefined
    let preview: { grant: Response; page: Response } | undefined

    const run = await drive(h, [
      // wait#0 — the session is ready: open the preview, then send a message.
      async () => {
        const row = await reload(h)
        expect(row.status).toBe('ready')
        branchId = (row.db as { branchId?: string } | null)?.branchId
        expect(branchId && neonBranch(h, branchId)).toBeTruthy()

        const grantRes = await act.post(h, '/preview-grant')
        expect(grantRes.status).toBe(200)
        const { url } = await json<{ url: string }>(grantRes)
        const gateway = async (req: Request) => {
          const host = previewHostOf(req, h.env)
          if (!host) throw new Error(`not a preview host: ${req.url}`)
          return handlePreview(req, h.env, createExecutionContext(), host, {
            ports: () => h.ports,
          })
        }
        const grant = await gateway(new Request(url))
        const cookie = (grant.headers.get('Set-Cookie') ?? '').split(';')[0] ?? ''
        const page = await gateway(
          new Request(new URL('/', url).toString(), { headers: { Cookie: cookie } })
        )
        preview = { grant, page }
        return say(h, "Change the Home page heading to 'Hello from Launch'")
      },
      // wait#2 — the turn is done (the checkpoint debounce is running): ship it.
      async () => {
        const row = await reload(h)
        expect(row.status).toBe('ready')
        const res = await act.post(h, '/ship')
        expect(res.status).toBe(202)
        return WAKE
      },
    ])

    // ---- the preview: grant → cookie → the sandbox's page, framable by Launch only.
    expect(preview?.grant.status).toBe(302)
    expect(preview?.page.status).toBe(200)
    expect(await preview?.page.text()).toContain('Hello from the session')
    expect(preview?.page.headers.get('X-Frame-Options')).toBeNull()
    expect(h.sandbox().fetches.map(f => f.port)).toEqual([5173])

    // ---- the Workflow's path: boot, one turn, the ship (which checkpoints — the debounce never
    // fired), cleanup.
    expect(run.status).toBe('shipped')
    expect(run.names).toEqual([
      'claim',
      'db',
      'sandbox.start',
      'repo',
      'bootstrap',
      'dev',
      'inspect#0',
      'wait#0',
      'inspect#1',
      'turn#1',
      'inspect#2',
      'wait#2',
      'inspect#3',
      'ship.claim#3',
      'ship.save#3',
      'ship.kit#3',
      'ship.gate#3.1.lint',
      'ship.gate#3.1.typecheck',
      'ship.db#3.1',
      'ship.gate#3.1.test',
      'ship.db-clean#3.1',
      'ship.commit#3',
      'ship.attest#3',
      'ship.summary#3',
      'ship.pr#3',
      'cleanup',
    ])

    // ---- the turn: Claude Code ran with the placeholder; the proxy swapped in the real key. The
    // green gate ran NO Claude turn: Launch ran it; the PR's one model call is the summary.
    expect(h.claudeEnvs).toHaveLength(1)
    for (const procEnv of h.claudeEnvs)
      expect(procEnv.ANTHROPIC_API_KEY).toBe(MODEL_KEY_PLACEHOLDER)
    expect(h.modelCalls).toEqual([200])
    expect(h.anthropic.requests).toHaveLength(1)
    expect(summaryModel.calls).toHaveLength(1)
    for (const req of h.anthropic.requests) {
      expect(req.apiKey).toBe(REAL_KEY)
      expect(JSON.stringify(req)).not.toContain(MODEL_KEY_PLACEHOLDER)
    }

    // ---- metering: the ledger adds up to the session's totals.
    const row = await reload(h)
    const usage = await usageOf(h)
    expect(usage).toHaveLength(2)
    const sum = (k: 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens') =>
      usage.reduce((n, u) => n + u[k], 0)
    expect(sum('inputTokens')).toBe(Number(row.tokensIn))
    expect(sum('outputTokens')).toBe(Number(row.tokensOut))
    expect(sum('cacheReadTokens')).toBe(Number(row.cacheRead))
    expect(sum('cacheWriteTokens')).toBe(Number(row.cacheWrite))
    expect(usage.reduce((n, u) => n + Number(u.costMicrocents ?? 0), 0)).toBe(
      Number(row.costMicrocents)
    )
    expect(Number(row.costMicrocents)).toBeGreaterThan(0)
    expect(row.tokensIn).toBe(2400)

    // ---- the PR: head session/<short>, the gate green, CI settles to success.
    const branch = sessionBranchName(h.session.shortId)
    expect(row.status).toBe('shipped')
    const pr = cloud.github.pulls.find(p => p.head === branch)
    expect(pr).toMatchObject({ base: 'main', title: 'Say hello on the home page' })
    expect(row.prNumber).toBe(pr?.number)
    expect(row.headSha).toBe(pr?.headSha)
    const types = (await eventsOf(h)).map(e => e.type)
    expect(types).toEqual(
      expect.arrayContaining(['preview.ready', 'user.message', 'turn.end', 'ship.gate', 'ship.pr'])
    )
    const gate = (await eventsOf(h)).find(e => e.type === 'ship.gate')
    expect(gate?.data).toMatchObject({ passed: true })
    cloud.github.setCheckRuns(h.f.repo.owner, h.f.repo.repo, branch, [
      { name: 'ci / gate', status: 'completed', conclusion: 'success' },
    ])
    await runSessionChecks(db, d => h.ports.repoHost(d))
    const prRes = await act.get(h, '/pr')
    expect(prRes.status).toBe(200)
    expect(await json(prRes)).toMatchObject({ prNumber: pr?.number, checks: { state: 'success' } })

    // ---- shipping ended the session: the audit chain, and nothing left running.
    const actions = (await auditsOf(h)).map(a => a.action)
    const chain = ['session.created', 'session.shipped', 'session.ended']
    expect(actions.filter(a => chain.includes(a))).toEqual(chain)
    await expectCleanedUp(h, branchId)
    const again = await act.post(h, '/end')
    expect(again.status).toBe(409)
    expect(await json(again)).toMatchObject({ code: 'session_not_endable' })

    // ---- no key and no placeholder in anything a person or the audit reads.
    expectNoKey('events', await eventsOf(h))
    expectNoKey('session row', await reload(h))
    expectNoKey('audit', await auditsOf(h))
    expectNoKey('usage', usage)
    expectNoKey('detail', await json(await act.get(h, '')))
  })

  it('over budget: the turn is blocked before any model call; the proxy refuses too', async () => {
    const h = await start()
    let proxied: Response | undefined
    const run = await drive(h, [
      async () => {
        // Spent to the cap (as if earlier turns had), then a message.
        const row = await reload(h)
        await db
          .update(sessions)
          .set({ costMicrocents: usdToMicrocents(row.policy.maxSessionUsd) })
          .where(and(eq(sessions.tenantId, row.tenantId), eq(sessions.id, row.id)))
        return say(h, 'One more change')
      },
      async () => {
        expect((await reload(h)).status).toBe('blocked')
        // A request the container makes anyway meets the budget in the handler.
        proxied = await handleAnthropic(
          new Request('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'x-api-key': MODEL_KEY_PLACEHOLDER },
            body: JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 10, messages: [] }),
          }),
          h.env,
          { containerId: h.sandbox().id },
          { upstream: h.anthropic.upstream }
        )
        // A second message is refused while blocked.
        const refused = await act.post(h, '/turns', { message: 'and another' })
        expect(refused.status).toBe(409)
        expect(await json(refused)).toMatchObject({ code: 'session_budget_exhausted' })
        expect((await act.post(h, '/end')).status).toBe(202)
        return WAKE
      },
    ])
    expect(run.status).toBe('ended')
    expect(proxied?.status).toBe(403)
    expect(await proxied?.json()).toMatchObject({ error: { type: 'permission_error' } })
    expect(h.anthropic.requests).toHaveLength(0)
    expect(h.claudeEnvs).toHaveLength(0)
    expect(await usageOf(h)).toHaveLength(0)
    expect((await eventsOf(h)).map(e => e.type)).toContain('budget.reached')
    expect((await auditsOf(h)).map(a => a.action)).toContain('session.budget.reached')
    await expectCleanedUp(h, undefined)
  })

  it('cancel: POST /cancel mid-turn kills the process; the turn is interrupted and checkpointed', async () => {
    const h = await start({
      hangTurn: true,
      onClaudeStarted: async h2 => {
        const res = await act.post(h2, '/cancel')
        expect(res.status).toBe(200)
      },
    })
    const run = await drive(h, [
      () => say(h, 'A long change'),
      // wait#2 — the checkpoint debounce runs out: the cancelled turn's work is saved.
      async () => {
        expect((await reload(h)).status).toBe('ready')
        return undefined
      },
      async () => {
        expect((await act.post(h, '/end')).status).toBe(202)
        return WAKE
      },
    ])
    expect(run.status).toBe('ended')
    expect(run.names).toContain('checkpoint#2')
    expect(h.sandbox().killed).toHaveLength(1)
    const interrupted = (await eventsOf(h)).find(e => e.type === 'turn.interrupted')
    expect(interrupted?.data).toMatchObject({ reason: 'cancelled' })
    // The call the process made before it was stopped is still on the ledger.
    expect(await usageOf(h)).toHaveLength(1)
    await expectCleanedUp(h, undefined)
  })

  it('a rollout mid-turn: turn.interrupted, suspended, and an end still cleans up', async () => {
    const h = await start()
    const run = await drive(h, [
      () => {
        h.sandbox().interruptNext()
        return say(h, 'A change during a deploy')
      },
      async () => {
        const row = await reload(h)
        expect(row.status).toBe('suspended')
        expect((await act.post(h, '/end')).status).toBe(202)
        return WAKE
      },
    ])
    expect(run.status).toBe('ended')
    const interrupted = (await eventsOf(h)).find(e => e.type === 'turn.interrupted')
    expect(interrupted?.data).toMatchObject({ reason: 'rollout' })
    expect(run.names).not.toContain('checkpoint#1')
    await expectCleanedUp(h, undefined)
  })

  it('idle → suspended (checkpointed, container kept) → resume reuses it and carries on', async () => {
    const h = await start()
    let transcriptAfterResume: string | undefined
    const run = await drive(h, [
      () => say(h, 'First change'),
      // wait#2: the checkpoint debounce runs out — saved, and the session waits on.
      () => undefined,
      // wait#3: nobody comes back — the idle timeout, the idle window gone by.
      async () => {
        await db
          .update(sessions)
          .set({ lastActivityAt: new Date(Date.now() - 31 * 60_000) })
          .where(and(eq(sessions.tenantId, h.f.tenant.id), eq(sessions.id, h.session.id)))
        return undefined
      },
      // wait#4 (suspended): the person resumes.
      async () => {
        const row = await reload(h)
        expect(row.status).toBe('suspended')
        expect(row.transcriptKey).toBe(`sessions/${row.id}/claude.jsonl`)
        // A warm suspend: the container is kept for the warm window (services/sessions/warm.ts).
        expect(row.containerKeptAt).toBeInstanceOf(Date)
        expect(h.sandbox().destroyed).toBe(false)
        const res = await act.post(h, '/resume')
        expect(res.status).toBe(202)
        return WAKE
      },
      // After the warm resume: the transcript never left, and the next turn resumes Claude.
      async () => {
        transcriptAfterResume = h.sandbox().files.get(claudeTranscriptPath(CLAUDE_SESSION))
        return say(h, 'Second change')
      },
      async () => {
        expect((await act.post(h, '/end')).status).toBe(202)
        return WAKE
      },
    ])
    expect(run.status).toBe('ended')
    expect(run.names).toEqual(
      expect.arrayContaining(['checkpoint#2', 'suspend#3', 'resume#5', 'sandbox.start#1', 'dev#1'])
    )
    // No clone, install or bootstrap the second time.
    expect(run.names).not.toContain('repo#1')
    expect(run.names).not.toContain('bootstrap#1')
    expect(transcriptAfterResume).toContain('"type":"user"')
    expect(h.sandbox().startCount).toBe(2)
    const claudeCommands = h.sandbox().processes.filter(p => p.command.includes('exec claude '))
    expect(claudeCommands).toHaveLength(2)
    expect(claudeCommands[1]?.command).toContain(`--resume ${CLAUDE_SESSION}`)
    expect(await usageOf(h)).toHaveLength(2)
    await expectCleanedUp(h, undefined)
  })
})
