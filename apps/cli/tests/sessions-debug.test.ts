/**
 * Debugging a session from the terminal (issue #6), in-process against a fake server: `show`
 * names the failing gate step with its output tail, `logs` prints every row (paging, `--since`,
 * `--type` prefixes, `--limit`, `--follow` until the session is quiet, `--json`), the debug
 * actions turn a refusal into the server's sentence (409 → exit 1, 403 → exit 3), and an image
 * downloads into a 0600 file that is never overwritten without `--force`.
 */
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_SESSION_POLICY, sessionEventSchema } from '@launch/shared/launch-sessions'
import { afterEach, describe, expect, it } from 'vitest'
import {
  formatSessionLogLine,
  runSessionsAttachment,
  runSessionsAttachments,
  runSessionsBudget,
  runSessionsCancel,
  runSessionsLandingRetry,
  runSessionsLogs,
  runSessionsResume,
  runSessionsShow,
  runSessionsWithdraw,
  sessionGateReport,
  sessionLastError,
  sessionLogSettled,
} from '../src/commands/sessions-debug'
import { EXIT_ERROR, EXIT_FORBIDDEN } from '../src/errors'
import {
  captureError,
  jsonResponse,
  mockFetch,
  type Route,
  TENANT_ID,
  TEST_KEY,
  tempStore,
  testContext,
  USER_ID,
} from './helpers'

const SERVER = 'http://server.test'
const APP_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const ID = '5e551000-0000-4000-8000-000000000001'
const IMAGE = 'a77ac000-0000-4000-8000-000000000001'
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(fn => fn()))
})

async function loggedInStore() {
  const t = await tempStore()
  cleanups.push(t.cleanup)
  await t.store.save({ serverUrl: SERVER, apiKey: TEST_KEY, tenantId: TENANT_ID, tenantName: 'A' })
  return t.store
}

const at = '2026-09-28T10:00:00.000Z'
const session = (over: Record<string, unknown> = {}) => ({
  id: ID,
  appId: APP_ID,
  kind: 'session',
  shortId: 'abcdefghijkl',
  title: 'Blue button',
  status: 'ready',
  createdByUserId: USER_ID,
  branch: 'session/abcdefghijkl',
  turnCount: 3,
  costMicrocents: 123_000_000,
  prNumber: null,
  prUrl: null,
  lastActivityAt: at,
  createdAt: at,
  baseRef: 'main',
  baseSha: 'b'.repeat(40),
  headSha: 'dfcb1730aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  requestedAction: null,
  pendingMessage: false,
  cancelRequested: false,
  imageVersion: null,
  policy: DEFAULT_SESSION_POLICY,
  usage: { tokensIn: 12_345, tokensOut: 2_000, cacheRead: 0, cacheWrite: 0 },
  budget: { spentMicrocents: 123_000_000, capMicrocents: 1_000_000_000, extraMicrocents: 0 },
  containerSeconds: 600,
  prChecks: null,
  error: null,
  readyAt: at,
  suspendedAt: null,
  endedAt: null,
  updatedAt: at,
  viewerCanManage: true,
  ...over,
})
const event = (seq: number, type: string, data: unknown, turn = 1) => ({
  id: `e0000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
  sessionId: ID,
  seq,
  turn,
  type,
  data,
  at,
})
const parsed = (rows: ReturnType<typeof event>[]) => rows.map(row => sessionEventSchema.parse(row))

/** `GET /events?afterSeq=` over a log the test grows, `page` rows at a time. */
function eventsRoute(log: ReturnType<typeof event>[], page = 500): Route {
  return url => {
    const after = Number(url.searchParams.get('afterSeq') ?? 0)
    const items = log.filter(e => e.seq > after).slice(0, page)
    return jsonResponse({ items, nextSeq: items.at(-1)?.seq ?? after })
  }
}

const noSleep = async () => {}

const gateOutput = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n')
const failedShipLog = [
  event(1, 'user.message', { text: 'Make the button blue', userId: USER_ID }),
  event(2, 'turn.start', { turn: 1, model: null }),
  event(3, 'turn.end', { turn: 1, durationMs: 9_000 }),
  event(4, 'ship.gate', { passed: true, attempt: 1, step: 'lint', command: 'pnpm gate lint' }),
  event(5, 'ship.gate', { status: 'running', attempt: 1, step: 'test', command: 'pnpm gate test' }),
  event(6, 'ship.gate', {
    passed: false,
    attempt: 1,
    step: 'test',
    command: 'pnpm gate test',
    durationMs: 42_000,
    output: gateOutput,
  }),
  event(7, 'status', { status: 'ready' }, 0),
]

describe('sessions show (issue #6)', () => {
  it('names the status, PR, ship, budget, last error and the failing gate step with its tail', async () => {
    const landing = {
      mode: 'staging',
      stage: 'stalled',
      prNumber: 12,
      gateSha: 'c'.repeat(40),
      startedAt: at,
      stageAt: at,
      reviewMode: 'none',
      stalledReason: 'main_ci_failed',
      error: 'Main’s checks failed after the merge',
    }
    const routes = {
      [`/api/sessions/${ID}/events`]: eventsRoute(failedShipLog),
      [`/api/sessions/${ID}`]: () =>
        jsonResponse({
          session: session({
            status: 'shipped',
            prNumber: 12,
            prUrl: 'https://github.com/acme/expenses/pull/12',
            model: 'claude-sonnet-4-5',
            landing,
          }),
        }),
    }
    const human = await testContext({
      store: await loggedInStore(),
      fetch: mockFetch(routes).fetch,
    })
    await runSessionsShow(human.ctx, ID)
    const text = human.out.content()
    expect(text).toContain('shipped · session · claude_code · claude-sonnet-4-5')
    expect(text).toContain('session/abcdefghijkl @ dfcb173 (from main @ bbbbbbb)')
    expect(text).toContain('#12 · https://github.com/acme/expenses/pull/12')
    expect(text).toContain('Main’s checks failed after the merge')
    expect(text).toContain('3 turns · $1.23 of $10.00')
    expect(text).toContain('Tests failed (try 1 of 3) · pnpm gate test · 42.0s')
    expect(text).toContain('line 30')
    expect(text).toContain('line 11')
    expect(text).not.toContain('line 10\n')
    expect(text).toContain(`sessions landing-retry ${ID}`)

    const json = await testContext({
      store: await loggedInStore(),
      fetch: mockFetch(routes).fetch,
      json: true,
    })
    await runSessionsShow(json.ctx, ID)
    const doc = JSON.parse(json.out.content())
    expect(doc.session.id).toBe(ID)
    expect(doc.boots).toEqual([])
    expect(doc.gate).toMatchObject({ attempt: 1, passed: false, failed: { step: 'test', seq: 6 } })
    expect(doc.lastError).toMatchObject({ seq: 6, type: 'ship.gate' })
  })

  it('reads only the newest attempt, and a re-ship’s rows apart from the last one’s', () => {
    const rows = parsed([
      event(1, 'ship.gate', { passed: false, attempt: 1, step: 'lint', output: 'old' }),
      event(2, 'ship.reopened', { reason: 'ci_failed', message: 'CI failed' }),
      event(3, 'ship.gate', { passed: true, attempt: 1, step: 'lint' }),
      event(4, 'ship.gate', {
        status: 'running',
        attempt: 1,
        step: 'test',
        command: 'pnpm gate test',
      }),
    ])
    const gate = sessionGateReport(rows)
    expect(gate).toMatchObject({ attempt: 1, passed: null, failed: null })
    expect(gate?.running).toEqual({ step: 'test', command: 'pnpm gate test' })
    expect(sessionGateReport(parsed([event(1, 'text', { text: 'hi' })]))).toBeNull()
    expect(sessionLastError(rows)).toMatchObject({ seq: 2, message: 'CI failed' })
  })
})

describe('sessions logs', () => {
  it('prints every row, the follow’s hidden ones dim with their data, across pages', async () => {
    const { fetch, calls } = mockFetch({
      [`/api/sessions/${ID}/events`]: eventsRoute(failedShipLog, 2),
      [`/api/sessions/${ID}`]: () => jsonResponse({ session: session() }),
    })
    const { ctx, out } = await testContext({ store: await loggedInStore(), fetch })
    await runSessionsLogs(ctx, ID)
    const text = out.content()
    for (const row of failedShipLog) expect(text).toContain(`#${row.seq} `)
    expect(text).toContain('turn.start')
    expect(text).toContain('{"turn":1,"model":null}')
    expect(text).toContain('#7 2026-09-28 10:00:00Z status')
    expect(text).toContain('→ ready')
    expect(text).toContain('pnpm gate test · 42.0s')
    expect(text).toContain('line 30')
    // Pages of two: 0 → 2 → 4 → 6 → 7 → (empty).
    const cursors = calls.filter(c => c.url.pathname.endsWith('/events'))
    expect(cursors.map(c => c.url.searchParams.get('afterSeq'))).toEqual(['0', '2', '4', '6', '7'])
  })

  it('--since, --type prefixes and --limit narrow it; --json is one document', async () => {
    const { fetch, calls } = mockFetch({
      [`/api/sessions/${ID}/events`]: eventsRoute(failedShipLog),
      [`/api/sessions/${ID}`]: () => jsonResponse({ session: session() }),
    })
    const { ctx, out } = await testContext({ store: await loggedInStore(), fetch, json: true })
    await runSessionsLogs(ctx, ID, { since: '3', type: 'ship.,status', limit: '3' })
    expect(
      calls.find(c => c.url.pathname.endsWith('/events'))?.url.searchParams.get('afterSeq')
    ).toBe('3')
    const doc = JSON.parse(out.content())
    expect(doc.events.map((e: { seq: number }) => e.seq)).toEqual([5, 6, 7])
    expect(doc.nextSeq).toBe(7)
  })

  it('refuses a type no event starts with, before any request', async () => {
    const { fetch, calls } = mockFetch({})
    const { ctx } = await testContext({ store: await loggedInStore(), fetch })
    await expect(runSessionsLogs(ctx, ID, { type: 'shipp' })).rejects.toThrow(/No event type/)
    await expect(runSessionsLogs(ctx, ID, { since: '-1' })).rejects.toThrow(/--since/)
    expect(calls).toHaveLength(0)
  })

  it('--follow prints rows as they arrive and stops once the session is quiet', async () => {
    const log = failedShipLog.slice(0, 2)
    let polls = 0
    const { fetch } = mockFetch({
      [`/api/sessions/${ID}/events`]: eventsRoute(log),
      [`/api/sessions/${ID}`]: () => {
        polls++
        if (polls === 2) log.push(failedShipLog[2] as ReturnType<typeof event>)
        return jsonResponse({ session: session({ status: polls < 3 ? 'working' : 'ready' }) })
      },
    })
    const { ctx, out } = await testContext({ store: await loggedInStore(), fetch })
    await runSessionsLogs(ctx, ID, { follow: true, sleep: noSleep, pollMs: 0 })
    const text = out.content()
    expect(text).toContain('#1 ')
    expect(text).toContain('#3 ')
    expect(text).toContain('the session is ready')
    expect(polls).toBe(3)
  })

  it('--follow --json prints one document per row, and times out with where to pick up', async () => {
    const { fetch } = mockFetch({
      [`/api/sessions/${ID}/events`]: eventsRoute(failedShipLog.slice(0, 2)),
      [`/api/sessions/${ID}`]: () => jsonResponse({ session: session({ status: 'working' }) }),
    })
    const { ctx, out } = await testContext({ store: await loggedInStore(), fetch, json: true })
    let clock = 0
    const err = await captureError(
      runSessionsLogs(ctx, ID, {
        follow: true,
        sleep: noSleep,
        pollMs: 0,
        timeoutMs: 3,
        now: () => clock++,
      })
    )
    expect(err.exitCode).toBe(EXIT_ERROR)
    expect(err.hint).toContain('--since 2 --follow')
    const docs = out.chunks.map(chunk => JSON.parse(chunk))
    expect(docs.map(d => d.seq)).toEqual([1, 2])
  })

  it('a session is quiet only with nothing waiting, requested or shipping', () => {
    const base = {
      status: 'ready' as const,
      pendingMessage: false,
      requestedAction: null,
      landing: null,
    }
    expect(sessionLogSettled(base)).toBe(true)
    expect(sessionLogSettled({ ...base, pendingMessage: true })).toBe(false)
    expect(sessionLogSettled({ ...base, requestedAction: 'ship' })).toBe(false)
    expect(sessionLogSettled({ ...base, status: 'working' })).toBe(false)
  })

  it('a failed gate step’s line carries its command and tail', () => {
    const line = formatSessionLogLine(sessionEventSchema.parse(failedShipLog[5]))
    expect(line).toContain('#6 ')
    expect(line).toContain('ship.gate')
    expect(line).toContain('    line 30')
  })
})

describe('sessions debug actions', () => {
  const refusal = (status: number, error: string, code: string) => () =>
    jsonResponse({ error, statusCode: status, code }, status)

  const cases = [
    {
      name: 'resume',
      path: `/api/sessions/${ID}/resume`,
      ok: () => jsonResponse({ session: session({ status: 'booting' }) }, 202),
      run: (ctx: Parameters<typeof runSessionsResume>[0]) => runSessionsResume(ctx, ID),
      says: 'Resuming session',
    },
    {
      name: 'cancel',
      path: `/api/sessions/${ID}/cancel`,
      ok: () => jsonResponse({ cancelRequested: true }),
      run: (ctx: Parameters<typeof runSessionsResume>[0]) => runSessionsCancel(ctx, ID),
      says: 'Asked the running turn to stop',
    },
    {
      name: 'withdraw',
      path: `/api/sessions/${ID}/queued/withdraw`,
      ok: () => jsonResponse({ session: session() }),
      run: (ctx: Parameters<typeof runSessionsResume>[0]) => runSessionsWithdraw(ctx, ID),
      says: 'Withdrew the waiting message',
    },
    {
      name: 'landing-retry',
      path: `/api/sessions/${ID}/landing/retry`,
      ok: () => jsonResponse({ session: session({ status: 'shipped' }) }, 202),
      run: (ctx: Parameters<typeof runSessionsResume>[0]) => runSessionsLandingRetry(ctx, ID),
      says: 'Retrying',
    },
    {
      name: 'budget',
      path: `/api/sessions/${ID}/budget`,
      ok: () => jsonResponse({ session: session() }),
      run: (ctx: Parameters<typeof runSessionsResume>[0]) => runSessionsBudget(ctx, ID, '5'),
      says: 'Budget raised',
    },
  ]

  for (const c of cases) {
    it(`${c.name}: posts, prints what happened; a 409 is the server’s sentence (exit 1), a 403 exit 3`, async () => {
      const ok = mockFetch({ [c.path]: c.ok })
      const first = await testContext({ store: await loggedInStore(), fetch: ok.fetch })
      await c.run(first.ctx)
      expect(ok.calls[0]?.init.method).toBe('POST')
      expect(first.out.content()).toContain(c.says)

      const conflict = mockFetch({ [c.path]: refusal(409, 'Nothing to do here', 'nope') })
      const second = await testContext({ store: await loggedInStore(), fetch: conflict.fetch })
      const err = await captureError(c.run(second.ctx))
      expect(err.exitCode).toBe(EXIT_ERROR)
      expect(err.message).toContain('Nothing to do here')

      const forbidden = mockFetch({ [c.path]: refusal(403, 'Forbidden', 'forbidden') })
      const third = await testContext({ store: await loggedInStore(), fetch: forbidden.fetch })
      expect((await captureError(c.run(third.ctx))).exitCode).toBe(EXIT_FORBIDDEN)
    })
  }

  it('landing-retry --release-anyway posts that action; budget waits on an approval (202)', async () => {
    const approvalId = 'a0000000-0000-4000-8000-000000000001'
    const { fetch, calls } = mockFetch({
      [`/api/sessions/${ID}/landing/retry`]: () =>
        jsonResponse({ session: session({ status: 'shipped' }) }, 202),
      [`/api/sessions/${ID}/budget`]: () => jsonResponse({ session: session(), approvalId }, 202),
    })
    const { ctx, out } = await testContext({ store: await loggedInStore(), fetch })
    await runSessionsLandingRetry(ctx, ID, { releaseAnyway: true })
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ action: 'release_anyway' })
    await runSessionsBudget(ctx, ID, '2.5', { reason: 'one more try' })
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({
      extraUsd: 2.5,
      reason: 'one more try',
    })
    expect(out.content()).toContain(`approvals show ${approvalId}`)
    await expect(runSessionsBudget(ctx, ID, 'lots')).rejects.toThrow(/not an amount/)
    expect(calls).toHaveLength(2)
  })
})

describe('sessions attachments', () => {
  const log = [
    event(1, 'user.message', {
      text: 'Like this one',
      userId: USER_ID,
      attachments: [{ id: IMAGE, contentType: 'image/png' }],
    }),
    event(2, 'turn.end', { turn: 1 }),
  ]

  it('lists the images the messages carried, from the log', async () => {
    const { fetch } = mockFetch({
      [`/api/sessions/${ID}/events`]: eventsRoute(log),
      [`/api/sessions/${ID}`]: () => jsonResponse({ session: session() }),
    })
    const { ctx, out } = await testContext({ store: await loggedInStore(), fetch, json: true })
    await runSessionsAttachments(ctx, ID)
    const doc = JSON.parse(out.content())
    expect(doc.items).toEqual([
      expect.objectContaining({
        id: IMAGE,
        contentType: 'image/png',
        seq: 1,
        message: 'Like this one',
      }),
    ])
  })

  it('downloads one into a 0600 file, and never overwrites without --force', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'launch-attachment-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const outFile = join(dir, 'image.png')
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    const { fetch } = mockFetch({
      [`/api/sessions/${ID}/attachments/${IMAGE}`]: () =>
        new Response(bytes, { headers: { 'Content-Type': 'image/png' } }),
    })
    const { ctx, out } = await testContext({ store: await loggedInStore(), fetch })
    await runSessionsAttachment(ctx, ID, IMAGE, { out: outFile })
    expect(new Uint8Array(await readFile(outFile))).toEqual(bytes)
    expect((await stat(outFile)).mode & 0o777).toBe(0o600)
    expect(out.content()).toContain('Saved 4 bytes (image/png)')

    const err = await captureError(runSessionsAttachment(ctx, ID, IMAGE, { out: outFile }))
    expect(err.exitCode).toBe(EXIT_ERROR)
    expect(err.message).toContain('already exists')

    await writeFile(outFile, 'old', { mode: 0o644 })
    await runSessionsAttachment(ctx, ID, IMAGE, { out: outFile, force: true })
    expect(new Uint8Array(await readFile(outFile))).toEqual(bytes)
    expect((await stat(outFile)).mode & 0o777).toBe(0o600)
  })
})
