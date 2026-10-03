/**
 * `sessions start|say|ship|end|ls|preview-url` (Launch P3), in-process against a fake server:
 * the app is resolved by slug, `say --follow` tails the durable rows until the turn settles (a
 * failed turn exits 1), `ship --wait` follows the gate to the PR and its CI, and `--json` prints
 * one parseable document.
 */
import { DEFAULT_SESSION_POLICY, sessionEventSchema } from '@launch/shared/launch-sessions'
import { afterEach, describe, expect, it } from 'vitest'
import {
  formatSessionEvent,
  runSessionsEnd,
  runSessionsList,
  runSessionsPreviewUrl,
  runSessionsSay,
  runSessionsShip,
  runSessionsStart,
} from '../src/commands/sessions'
import { EXIT_ERROR, EXIT_FORBIDDEN, exitCodeFor } from '../src/errors'
import {
  captureError,
  jsonResponse,
  mockFetch,
  TENANT_ID,
  TEST_KEY,
  tempStore,
  testContext,
  USER_ID,
} from './helpers'

const SERVER = 'http://server.test'
const APP_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const ID = '5e551000-0000-4000-8000-000000000001'
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
const summary = (over: Record<string, unknown> = {}) => ({
  id: ID,
  appId: APP_ID,
  kind: 'session',
  shortId: 'abcdefghijkl',
  title: 'Blue button',
  status: 'ready',
  createdByUserId: USER_ID,
  branch: 'session/abcdefghijkl',
  turnCount: 0,
  costMicrocents: 0,
  prNumber: null,
  prUrl: null,
  lastActivityAt: at,
  createdAt: at,
  ...over,
})
const session = (over: Record<string, unknown> = {}) => ({
  ...summary(over),
  baseRef: 'main',
  baseSha: null,
  headSha: null,
  requestedAction: null,
  pendingMessage: false,
  cancelRequested: false,
  imageVersion: null,
  policy: DEFAULT_SESSION_POLICY,
  usage: { tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0 },
  budget: { spentMicrocents: 0, capMicrocents: 1_000_000_000, extraMicrocents: 0 },
  containerSeconds: 0,
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

/** `GET /events?afterSeq=` over a log the test grows between polls. */
function eventsRoute(log: ReturnType<typeof event>[]) {
  return (url: URL) => {
    const after = Number(url.searchParams.get('afterSeq') ?? 0)
    const items = log.filter(e => e.seq > after)
    return jsonResponse({ items, nextSeq: items.at(-1)?.seq ?? after })
  }
}

const app = { id: APP_ID, slug: 'expenses' }
const appDetail = {
  ...app,
  displayName: 'Expenses',
  description: null,
  status: 'live',
  source: 'imported',
  template: 'rocketflare',
  templateVersion: '0.15.0',
  repoOwner: 'acme',
  repoName: 'expenses',
  ownerGroup: null,
  environments: [],
  createdAt: at,
  templateContractVersion: null,
  defaultBranch: 'main',
  updatedAt: at,
  viewerCanDeploy: true,
}

const noSleep = async () => {}

describe('sessions start / ls / end / preview-url', () => {
  it('starts a session on an app resolved by slug and prints its page', async () => {
    const { fetch, calls } = mockFetch({
      '/api/apps/expenses': () => jsonResponse(appDetail),
      [`/api/apps/${APP_ID}/sessions`]: () =>
        jsonResponse({ session: session({ status: 'requested' }) }, 202),
    })
    const { ctx, out } = await testContext({ store: await loggedInStore(), fetch })
    await runSessionsStart(ctx, 'expenses', { title: 'Blue button' })
    expect(calls[1]?.init.method).toBe('POST')
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({ title: 'Blue button' })
    expect(out.content()).toContain(ID)
    expect(out.content()).toContain(`${SERVER}/apps/expenses/sessions/${ID}`)
  })

  it('--runtime picks the coding agent; an unknown one is refused before any request', async () => {
    const { fetch, calls } = mockFetch({
      '/api/apps/expenses': () => jsonResponse(appDetail),
      [`/api/apps/${APP_ID}/sessions`]: () =>
        jsonResponse({ session: session({ status: 'requested' }) }, 202),
    })
    const { ctx } = await testContext({ store: await loggedInStore(), fetch })
    await runSessionsStart(ctx, 'expenses', { runtime: 'codex' })
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({ runtime: 'codex' })

    const refused = mockFetch({})
    const second = await testContext({ store: await loggedInStore(), fetch: refused.fetch })
    await expect(runSessionsStart(second.ctx, 'expenses', { runtime: 'cursor' })).rejects.toThrow(
      /Unknown runtime/
    )
    expect(refused.calls).toHaveLength(0)
  })

  it('lists with --json as the raw body, and asks for finished ones with --all', async () => {
    const { fetch, calls } = mockFetch({
      '/api/apps/expenses': () => jsonResponse(appDetail),
      [`/api/apps/${APP_ID}/sessions`]: () => jsonResponse({ items: [summary()] }),
    })
    const { ctx, out } = await testContext({ store: await loggedInStore(), fetch, json: true })
    await runSessionsList(ctx, 'expenses', { all: true })
    expect(calls[1]?.url.searchParams.get('scope')).toBe('all')
    expect(JSON.parse(out.content()).items[0].id).toBe(ID)
  })

  it('ends a session, and a 403 is exit 3', async () => {
    const ok = mockFetch({
      [`/api/sessions/${ID}/end`]: () =>
        jsonResponse({ session: session({ status: 'ending' }) }, 202),
    })
    const first = await testContext({ store: await loggedInStore(), fetch: ok.fetch })
    await runSessionsEnd(first.ctx, ID)
    expect(first.out.content()).toContain('session/abcdefghijkl')

    const denied = mockFetch({
      [`/api/sessions/${ID}/end`]: () =>
        jsonResponse({ error: 'Forbidden', statusCode: 403, code: 'forbidden' }, 403),
    })
    const second = await testContext({ store: await loggedInStore(), fetch: denied.fetch })
    expect(exitCodeFor(await captureError(runSessionsEnd(second.ctx, ID)))).toBe(EXIT_FORBIDDEN)
  })

  it('prints a preview grant URL and opens it on --open', async () => {
    const url = 'http://5173-abcdefghijkl-t0k3n00000.localhost:3001/__launch/grant?g=x'
    const opened: string[] = []
    const { fetch } = mockFetch({
      [`/api/sessions/${ID}/preview-grant`]: () => jsonResponse({ url, expiresAt: at }),
    })
    const { ctx, out } = await testContext({
      store: await loggedInStore(),
      fetch,
      open: async u => {
        opened.push(u)
      },
    })
    await runSessionsPreviewUrl(ctx, ID, { open: true })
    expect(opened).toEqual([url])
    expect(out.content()).toContain(url)
  })
})

describe('sessions say', () => {
  it('--follow prints the turn and stops when it ends', async () => {
    const log = [event(1, 'turn.end', { turn: 0 }, 0)]
    let polls = 0
    const { fetch, calls } = mockFetch({
      [`/api/sessions/${ID}/events`]: url => eventsRoute(log)(url),
      [`/api/sessions/${ID}/turns`]: () =>
        jsonResponse({ session: session({ pendingMessage: true }) }, 202),
      [`/api/sessions/${ID}`]: () => jsonResponse({ session: session({ status: 'working' }) }),
    })
    const { ctx, out } = await testContext({ store: await loggedInStore(), fetch })
    await runSessionsSay(ctx, ID, 'Make the button blue', {
      follow: true,
      sleep: async () => {
        polls += 1
        if (polls === 1) {
          log.push(
            event(2, 'user.message', { text: 'Make the button blue', userId: USER_ID }),
            event(3, 'tool.start', { name: 'Edit', input: { file_path: 'src/App.tsx' } })
          )
        }
        if (polls === 2) {
          log.push(
            event(4, 'text', { text: 'It is blue now.' }),
            event(5, 'turn.end', { turn: 1, durationMs: 4000, costMicrocents: 2_000_000 })
          )
        }
      },
    })
    const turns = calls.find(c => c.url.pathname.endsWith('/turns'))
    expect(JSON.parse(String(turns?.init.body))).toEqual({ message: 'Make the button blue' })
    const text = out.content()
    // Only this turn's rows: the old turn.end (seq 1) is behind the cursor.
    expect(text).toContain('> Make the button blue')
    expect(text).toContain('Edit src/App.tsx')
    expect(text).toContain('It is blue now.')
    expect(text).toContain('turn 1 done · 4s · $0.02')
    expect(text).not.toContain('turn 0')
  })

  it('--follow exits 1 on a failed turn, and --json prints one document', async () => {
    const log = [
      event(1, 'user.message', { text: 'Break it', userId: USER_ID }),
      event(2, 'turn.failed', { turn: 1, message: 'claude exited 1' }),
    ]
    let sent = false
    const { fetch } = mockFetch({
      [`/api/sessions/${ID}/events`]: url => (sent ? eventsRoute(log)(url) : eventsRoute([])(url)),
      [`/api/sessions/${ID}/turns`]: () => {
        sent = true
        return jsonResponse({ session: session({ pendingMessage: true }) }, 202)
      },
      [`/api/sessions/${ID}`]: () => jsonResponse({ session: session() }),
    })
    const { ctx, out } = await testContext({ store: await loggedInStore(), fetch, json: true })
    const error = await captureError(
      runSessionsSay(ctx, ID, 'Break it', { follow: true, sleep: noSleep })
    )
    expect(exitCodeFor(error)).toBe(EXIT_ERROR)
    const doc = JSON.parse(out.content())
    expect(doc.session.id).toBe(ID)
    expect(doc.events.map((e: unknown) => sessionEventSchema.parse(e).type)).toEqual([
      'user.message',
      'turn.failed',
    ])
  })

  it('refuses an empty message before any request', async () => {
    const { fetch, calls } = mockFetch({})
    const { ctx } = await testContext({ store: await loggedInStore(), fetch })
    expect(exitCodeFor(await captureError(runSessionsSay(ctx, ID, '   ')))).toBe(EXIT_ERROR)
    expect(calls).toHaveLength(0)
  })
})

describe('sessions ship', () => {
  const prUrl = 'https://github.com/acme/expenses/pull/12'
  const checks = (state: string) => ({
    state,
    headSha: null,
    checkedAt: at,
    total: 1,
    passed: state === 'success' ? 1 : 0,
    failed: state === 'failure' ? 1 : 0,
    pending: state === 'pending' ? 1 : 0,
    checks: [{ name: 'test', source: 'check_run', state, url: null }],
  })

  it('--wait follows the gate to the PR and waits for CI', async () => {
    const log = [event(1, 'turn.end', { turn: 1 })]
    let reads = 0
    let prReads = 0
    const { fetch } = mockFetch({
      [`/api/sessions/${ID}/events`]: url => eventsRoute(log)(url),
      [`/api/sessions/${ID}/ship`]: () =>
        jsonResponse({ session: session({ status: 'shipping' }) }, 202),
      [`/api/sessions/${ID}`]: () => {
        reads += 1
        if (reads === 1) {
          // An older server's one row for the whole gate, then issue #1's one row per step.
          log.push(event(2, 'ship.gate', { passed: true, attempt: 1 }, 2))
          log.push(event(3, 'ship.gate', { step: 'test', passed: false, attempt: 2 }, 2))
          log.push(event(4, 'ship.gate', { step: 'test', passed: true, attempt: 3 }, 2))
          return jsonResponse({ session: session({ status: 'shipping' }) })
        }
        log.push(event(5, 'ship.pr', { number: 12, url: prUrl }, 2))
        return jsonResponse({ session: session({ status: 'shipped', prNumber: 12, prUrl }) })
      },
      [`/api/sessions/${ID}/pr`]: () => {
        prReads += 1
        return jsonResponse({
          prNumber: 12,
          prUrl,
          checks: checks(prReads === 1 ? 'pending' : 'success'),
        })
      },
    })
    const { ctx, out } = await testContext({ store: await loggedInStore(), fetch })
    await runSessionsShip(ctx, ID, { wait: true, sleep: noSleep })
    const text = out.content()
    expect(text).toContain('gate passed (attempt 1)')
    expect(text).toContain('tests failed (attempt 2)')
    expect(text).toContain('tests passed (attempt 3)')
    expect(text).toContain(`PR #12 ${prUrl}`)
    expect(text).toContain('CI passed')
    expect(prReads).toBe(2)
  })

  it('--wait exits 1 when CI fails, or when the ship opened no PR', async () => {
    const failing = mockFetch({
      [`/api/sessions/${ID}/events`]: url => eventsRoute([])(url),
      [`/api/sessions/${ID}/ship`]: () =>
        jsonResponse({ session: session({ status: 'shipping' }) }, 202),
      [`/api/sessions/${ID}`]: () =>
        jsonResponse({ session: session({ status: 'shipped', prNumber: 12, prUrl }) }),
      [`/api/sessions/${ID}/pr`]: () =>
        jsonResponse({ prNumber: 12, prUrl, checks: checks('failure') }),
    })
    const a = await testContext({ store: await loggedInStore(), fetch: failing.fetch })
    const ciError = await captureError(runSessionsShip(a.ctx, ID, { wait: true, sleep: noSleep }))
    expect(ciError.message).toBe('CI failed on PR #12')

    const noPr = mockFetch({
      [`/api/sessions/${ID}/events`]: url => eventsRoute([])(url),
      [`/api/sessions/${ID}/ship`]: () =>
        jsonResponse({ session: session({ status: 'shipping' }) }, 202),
      // The gate never went green: the session is back to `ready` with no PR.
      [`/api/sessions/${ID}`]: () => jsonResponse({ session: session({ status: 'ready' }) }),
    })
    const b = await testContext({ store: await loggedInStore(), fetch: noPr.fetch })
    const shipError = await captureError(runSessionsShip(b.ctx, ID, { wait: true, sleep: noSleep }))
    expect(exitCodeFor(shipError)).toBe(EXIT_ERROR)
    expect(shipError.message).toMatch(/did not open a pull request/)
  })
})

describe('sessions ship — through to live on staging (#5)', () => {
  const prUrl = 'https://github.com/acme/expenses/pull/12'
  const stagingUrl = 'https://expenses-staging.apps.test'
  const RELEASE = '7e1e0000-0000-4000-8000-000000000001'
  const landing = (stage: string, over: Record<string, unknown> = {}) => ({
    mode: 'staging',
    stage,
    prNumber: 12,
    gateSha: 'b'.repeat(40),
    startedAt: at,
    stageAt: at,
    reviewMode: 'none',
    ...over,
  })
  const ci = (state: string, extra: Record<string, unknown> = {}) => ({
    state,
    headSha: 'b'.repeat(40),
    passed: state === 'success' ? 2 : 1,
    failed: state === 'failure' ? 1 : 0,
    pending: 0,
    ...extra,
  })

  /**
   * A fake server whose session row moves one step per read, appending that step's rows to the
   * log first — the order the Workflow writes them.
   */
  function scripted(steps: { rows: [string, unknown][]; session: Record<string, unknown> }[]) {
    const log = [event(1, 'turn.end', { turn: 1 })]
    let read = 0
    const mock = mockFetch({
      [`/api/sessions/${ID}/events`]: url => eventsRoute(log)(url),
      [`/api/sessions/${ID}/ship`]: () =>
        jsonResponse({ session: session({ status: 'shipping' }) }, 202),
      [`/api/sessions/${ID}`]: () => {
        const step = steps[Math.min(read, steps.length - 1)] as (typeof steps)[number]
        if (read < steps.length)
          for (const [type, data] of step.rows) log.push(event(log.length + 1, type, data, 2))
        read += 1
        return jsonResponse({ session: session(step.session) })
      },
    })
    return mock
  }

  const toLive = () =>
    scripted([
      {
        rows: [
          ['ship.gate', { step: 'test', passed: true, attempt: 1 }],
          ['ship.pr', { number: 12, url: prUrl }],
        ],
        session: { status: 'shipping', prNumber: 12, prUrl, landing: landing('ci') },
      },
      {
        rows: [
          ['ship.ci', ci('success')],
          ['ship.merged', { number: 12, sha: 'c'.repeat(40), url: prUrl, approvalId: null }],
        ],
        session: { status: 'shipped', prNumber: 12, prUrl, landing: landing('releasing') },
      },
      {
        rows: [
          ['ship.released', { releaseId: RELEASE, version: '1.4.3', tag: '1.4.3', shared: false }],
          ['ship.staging', { status: 'deploying', version: '1.4.3', url: null }],
        ],
        session: {
          status: 'shipped',
          prNumber: 12,
          prUrl,
          landing: landing('deploying', { version: '1.4.3' }),
        },
      },
      {
        rows: [['ship.staging', { status: 'live', version: '1.4.3', url: stagingUrl }]],
        session: {
          status: 'shipped',
          prNumber: 12,
          prUrl,
          landing: landing('live', { version: '1.4.3', stagingUrl }),
        },
      },
    ])

  it('says when the PR was merged on GitHub rather than by Launch', () => {
    const merged = (by?: string) =>
      formatSessionEvent(
        sessionEventSchema.parse(
          event(2, 'ship.merged', {
            number: 12,
            sha: 'c'.repeat(40),
            url: prUrl,
            approvalId: null,
            ...(by ? { by } : {}),
          })
        )
      )
    expect(merged('github')).toContain('merged PR #12 on GitHub (ccccccc)')
    expect(merged('launch')).toContain('merged PR #12 (ccccccc)')
    expect(merged()).toContain('merged PR #12 (ccccccc)')
  })

  it('waits through to live by default, printing each stage', async () => {
    const { fetch, calls } = toLive()
    const { ctx, out } = await testContext({ store: await loggedInStore(), fetch })
    await runSessionsShip(ctx, ID, { sleep: noSleep })
    const text = out.content()
    expect(text).toContain(`opened PR #12 ${prUrl}`)
    expect(text).toContain('CI passed')
    expect(text).toContain('merged PR #12 (ccccccc)')
    expect(text).toContain('released v1.4.3')
    expect(text).toContain(`live on staging: ${stagingUrl} (v1.4.3)`)
    // Live once: the closing line is the row's, not printed twice.
    expect(text.split('live on staging').length - 1).toBe(1)
    // Past the PR nothing reads `GET /pr`: the landing rows say it.
    expect(calls.some(c => c.url.pathname.endsWith('/pr'))).toBe(false)
  })

  it('--wait is an accepted no-op, and --json prints ONE document at the end', async () => {
    const { fetch } = toLive()
    const { ctx, out } = await testContext({ store: await loggedInStore(), fetch, json: true })
    await runSessionsShip(ctx, ID, { wait: true, sleep: noSleep })
    const doc = JSON.parse(out.content()) as {
      session: { landing: { stage: string } }
      events: unknown[]
    }
    expect(doc.session.landing.stage).toBe('live')
    const types = doc.events.map(e => sessionEventSchema.parse(e).type)
    expect(types).toEqual([
      'ship.gate',
      'ship.pr',
      'ship.ci',
      'ship.merged',
      'ship.released',
      'ship.staging',
      'ship.staging',
    ])
  })

  it('--no-wait returns as soon as the ship has started', async () => {
    const { fetch, calls } = toLive()
    const { ctx, out } = await testContext({ store: await loggedInStore(), fetch })
    await runSessionsShip(ctx, ID, { wait: false, sleep: noSleep })
    expect(out.content()).toContain('Shipping.')
    expect(calls.map(c => c.url.pathname)).toEqual([`/api/sessions/${ID}/ship`])
  })

  it('exits 1 when the ship is given back before the merge, with CI’s failing check', async () => {
    const { fetch } = scripted([
      {
        rows: [['ship.pr', { number: 12, url: prUrl }]],
        session: { status: 'shipping', prNumber: 12, prUrl, landing: landing('ci') },
      },
      {
        rows: [
          [
            'ship.ci',
            ci('failure', {
              failedCheck: {
                name: 'Gate',
                url: 'https://github.com/acme/expenses/actions/runs/9/job/1',
                logTail: 'FAIL tests/home.test.ts\nexpected "Welcome" to be "Welcome back"',
              },
            }),
          ],
          ['ship.reopened', { reason: 'ci_failed', message: 'CI failed on the pull request.' }],
        ],
        // Reopened: back to `ready`, the landing cleared.
        session: { status: 'ready', prNumber: 12, prUrl, landing: null },
      },
    ])
    const { ctx, out } = await testContext({ store: await loggedInStore(), fetch })
    const error = await captureError(runSessionsShip(ctx, ID, { sleep: noSleep }))
    expect(exitCodeFor(error)).toBe(EXIT_ERROR)
    expect(error.message).toBe('Not merged: CI failed on the pull request.')
    const text = out.content()
    expect(text).toContain('CI failed: Gate https://github.com/acme/expenses/actions/runs/9/job/1')
    expect(text).toContain('expected "Welcome" to be "Welcome back"')
  })

  it('exits 1, naming the open PR, when the session is ended while the landing waits', async () => {
    const { fetch } = scripted([
      {
        rows: [
          ['ship.pr', { number: 12, url: prUrl }],
          ['ship.ci', ci('pending', { passed: 0, pending: 1 })],
        ],
        session: { status: 'shipping', prNumber: 12, prUrl, landing: landing('ci') },
      },
      {
        // `endStep` cleared the landing and wrote no `ship.reopened`.
        rows: [['status', { status: 'ending', reason: 'requested' }]],
        session: { status: 'ended', prNumber: 12, prUrl, landing: null },
      },
    ])
    const { ctx } = await testContext({ store: await loggedInStore(), fetch })
    const error = await captureError(runSessionsShip(ctx, ID, { sleep: noSleep }))
    expect(exitCodeFor(error)).toBe(EXIT_ERROR)
    expect(error.message).toBe('Not merged: the session is ended, so PR #12 was left open')
  })

  it('exits 1 when it stalls after the merge', async () => {
    const { fetch } = scripted([
      {
        rows: [
          ['ship.pr', { number: 12, url: prUrl }],
          ['ship.merged', { number: 12, sha: 'c'.repeat(40), url: prUrl, approvalId: null }],
          [
            'ship.staging',
            { status: 'failed', version: '1.4.3', url: null, error: 'Deploy failed.' },
          ],
        ],
        session: {
          status: 'shipped',
          prNumber: 12,
          prUrl,
          landing: landing('stalled', {
            version: '1.4.3',
            stalledReason: 'deploy_failed',
            error: 'The staging deploy of 1.4.3 failed.',
          }),
        },
      },
    ])
    const { ctx } = await testContext({ store: await loggedInStore(), fetch })
    const error = await captureError(runSessionsShip(ctx, ID, { sleep: noSleep }))
    expect(exitCodeFor(error)).toBe(EXIT_ERROR)
    expect(error.message).toBe('The staging deploy of 1.4.3 failed.')
  })
})
