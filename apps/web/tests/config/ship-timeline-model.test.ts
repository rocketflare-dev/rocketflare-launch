/**
 * Issue #22: the ship as one plain-language timeline — the pure model behind the session page's
 * timeline (`shipTimeline`, `currentShipEvents`, `shipInProgress`), the shared words the CLI and the
 * app page's lists also print (`@launch/shared/launch-ship-progress`), the clock's tick rate and
 * the approval policies' Required / Not required reading. Every stage state is covered: done, now,
 * next, needs you, failed and being fixed, stalled.
 */

import { DEFAULT_APPROVAL_POLICIES } from '@launch/shared/launch-approvals'
import {
  type Session,
  type SessionEvent,
  sessionLandingSchema,
  sessionShippingOf,
} from '@launch/shared/launch-sessions'
import {
  checksCountText,
  earlierTryText,
  gateFixingText,
  mainChecksVerdictText,
  shipDurationText,
  shippingChipText,
  shippingLineText,
  shippingSummaryText,
  shipStageText,
  typicalDurationText,
} from '@launch/shared/launch-ship-progress'
import { describe, expect, it } from 'vitest'
import {
  approvalRequirement,
  autoApproveLabel,
  requirementSentence,
} from '@/ui/pages/approvals/approvalModel'
import { elapsedTickMs } from '@/ui/pages/sessions/components/useElapsed'
import {
  currentShipEvents,
  gateFixMessage,
  type ShipTimelineInput,
  shipInProgress,
  shipTimeline,
} from '@/ui/pages/sessions/shipTimelineModel'

const SESSION = '5e551000-0000-4000-8000-000000000001'
const ev = (seq: number, type: SessionEvent['type'], data: unknown, turn = 1): SessionEvent => ({
  id: `e0000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
  sessionId: SESSION,
  seq,
  turn,
  type,
  data,
  at: new Date(Date.UTC(2026, 8, 28, 10, 0, seq)),
})
const gate = (seq: number, step: string, passed: boolean, attempt: number, extra = {}) =>
  ev(seq, 'ship.gate', { step, passed, attempt, ...extra })
const running = (seq: number, step: string, attempt: number, extra = {}) =>
  ev(seq, 'ship.gate', { status: 'running', step, attempt, command: `pnpm gate ${step}`, ...extra })

type Row = ShipTimelineInput['session']
const row = (overrides: Partial<Row> = {}): Row => ({
  status: 'shipping',
  landing: null,
  prNumber: null,
  prUrl: null,
  requestedAction: null,
  error: null,
  shipping: null,
  ...overrides,
})
const landing = (overrides: Record<string, unknown> = {}) =>
  sessionLandingSchema.parse({
    mode: 'staging',
    stage: 'ci',
    prNumber: 12,
    gateSha: 'b'.repeat(40),
    startedAt: '2026-09-28T10:10:00.000Z',
    stageAt: '2026-09-28T10:10:00.000Z',
    reviewMode: 'none',
    ...overrides,
  })
const view = (events: SessionEvent[], session: Row, extra: Partial<ShipTimelineInput> = {}) => {
  const out = shipTimeline({ events, session, agent: 'Claude', ...extra })
  if (!out) throw new Error('no timeline')
  return out
}
const states = (v: ReturnType<typeof view>) =>
  Object.fromEntries(v.stages.map(s => [s.key, s.fixing ? 'fixing' : s.state]))

const PR = 'https://github.com/acme/expenses/pull/12'
const GREEN = [
  gate(1, 'lint', true, 1),
  gate(2, 'typecheck', true, 1),
  gate(3, 'test', true, 1),
  ev(4, 'ship.pr', { number: 12, url: PR }),
]

describe('shipTimeline: before the PR', () => {
  it('now: the step running, its clock from the start row, and the rest next', () => {
    const v = view([gate(1, 'lint', true, 1), running(2, 'test', 1)], row())
    expect(states(v)).toEqual({
      check: 'now',
      pr: 'next',
      checks: 'next',
      merge: 'next',
      release: 'next',
      staging: 'next',
      promote: 'next',
    })
    expect(v.current?.key).toBe('check')
    expect(v.current?.text).toBe('Checking your change')
    expect(v.current?.detail).toBe('Running the tests')
    expect(v.current?.since).toEqual(new Date(Date.UTC(2026, 8, 28, 10, 0, 2)))
    expect(v.outcome).toBe('moving')
    expect(v.needsYou).toBeNull()
  })

  it('failed and being fixed: the problem in words, the next try counted', () => {
    const v = view([gate(1, 'test', false, 1), ev(2, 'turn.start', { turn: 2 }, 2)], row())
    expect(states(v)).toMatchObject({ check: 'fixing' })
    expect(v.current?.text).toBe('The tests found a problem. Claude is fixing it (try 2 of 3).')
    // Its clock is the fix turn's.
    expect(v.current?.since).toEqual(new Date(Date.UTC(2026, 8, 28, 10, 0, 2)))
    expect(v.fixTurn?.turn).toBe(2)
  })

  it('earlier tries collapse to one line, and a step timed before says how long it took', () => {
    const v = view(
      [
        gate(1, 'lint', true, 1, { durationMs: 400_000 }),
        gate(2, 'test', false, 1),
        gate(3, 'lint', true, 2, { durationMs: 320_000 }),
        gate(4, 'test', false, 2),
        running(5, 'lint', 3),
      ],
      row()
    )
    expect(v.current?.detail).toBe('Checking the code style (lint) (try 3 of 3)')
    expect(v.current?.history).toEqual(['First try: tests failed', 'Second try: tests failed'])
    expect(v.current?.typical).toBe('Lint usually takes about 7 minutes')
  })

  it('the gate green: checked done, the PR opening now', () => {
    const v = view(GREEN.slice(0, 3), row())
    expect(states(v)).toMatchObject({ check: 'done', pr: 'now', checks: 'next' })
  })

  it('needs you: the gate gave up and the session is open again', () => {
    const events = [
      gate(1, 'test', false, 1),
      gate(2, 'test', false, 2),
      gate(3, 'test', false, 3, { output: 'boom' }),
    ]
    const v = view(events, row({ status: 'ready' }))
    expect(v.outcome).toBe('handed_back')
    expect(states(v)).toMatchObject({ check: 'needs_you', pr: 'next' })
    expect(v.needsYou?.text).toBe(
      'The tests found a problem after 3 tries, and Claude couldn’t fix it on its own.'
    )
    expect(v.needsYou?.action).toEqual({ kind: 'fix_gate', step: 'test', output: 'boom' })
    expect(v.headline).toBe('Not shipped yet')
  })

  it('the review shows only when one is required, saying why', () => {
    const none = view([], row(), { plan: { mode: 'staging', review: 'none' } })
    expect(none.stages.map(s => s.key)).not.toContain('review')
    const policy = view([], row(), { plan: { mode: 'staging', review: 'policy' } })
    expect(policy.stages.find(s => s.key === 'review')).toMatchObject({
      state: 'next',
      detail: 'Your organisation’s approval policy requires a review before it merges.',
    })
    // `pr` mode ends at the PR's checks.
    expect(
      view([], row(), { plan: { mode: 'pr', review: 'none' } }).stages.map(s => s.key)
    ).toEqual(['check', 'pr', 'checks'])
  })

  it('nothing to show without a ship', () => {
    expect(
      shipTimeline({ events: [], session: row({ status: 'ready' }), agent: 'Claude' })
    ).toBeNull()
  })
})

describe('shipTimeline: after the PR (the landing)', () => {
  const ci = (state: string, extra = {}) =>
    ev(5, 'ship.ci', { state, headSha: 'b'.repeat(40), passed: 1, failed: 0, pending: 1, ...extra })

  it('now: the automatic checks, counted — and GitHub’s queue said as GitHub’s', () => {
    const v = view([...GREEN, ci('pending')], row({ prNumber: 12, landing: landing() }))
    expect(states(v)).toMatchObject({ check: 'done', pr: 'done', checks: 'now', merge: 'next' })
    expect(v.current?.detail).toBe('1 of 2 passed, 1 running')
    const queued = view([...GREEN], row({ prNumber: 12, landing: landing() }), {
      checks: {
        state: 'pending',
        headSha: null,
        checkedAt: new Date(),
        total: 2,
        passed: 0,
        failed: 0,
        pending: 2,
        queued: 2,
        checks: [],
      },
    })
    expect(queued.current?.detail).toBe('Waiting for GitHub to start the checks')
  })

  it('a review: someone else’s is now; the reader’s own needs them', () => {
    const l = landing({
      stage: 'approval',
      reviewMode: 'app_owners',
      approvalId: '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a',
    })
    const theirs = view([...GREEN], row({ prNumber: 12, landing: l }), {
      review: { waitingOn: 'Bob', canDecide: false },
    })
    expect(states(theirs)).toMatchObject({ checks: 'done', review: 'now' })
    expect(theirs.current?.text).toBe('Waiting for Bob to review it')
    expect(theirs.needsYou).toBeNull()
    const mine = view([...GREEN], row({ prNumber: 12, landing: l }), {
      review: { waitingOn: 'you', canDecide: true },
    })
    expect(states(mine)).toMatchObject({ review: 'needs_you' })
    expect(mine.needsYou?.action).toEqual({ kind: 'review', approvalId: l.approvalId })
  })

  it('releasing: waiting for main’s checks with the limit; a slow verdict is said once released', () => {
    const waiting = view(
      [
        ...GREEN,
        ci('success'),
        ev(6, 'ship.merged', { number: 12, sha: 'c', url: PR, approvalId: null }),
      ],
      row({ status: 'shipped', prNumber: 12, landing: landing({ stage: 'releasing' }) })
    )
    expect(states(waiting)).toMatchObject({ merge: 'done', release: 'now' })
    expect(waiting.current?.text).toBe('Waiting for main’s checks before releasing')
    expect(waiting.current?.detail).toBe('Launch releases anyway after 30 minutes')
    const slow = view(
      [...GREEN, ci('success')],
      row({
        status: 'shipped',
        prNumber: 12,
        landing: landing({
          stage: 'deploying',
          version: '1.4.3',
          mainCi: { verdict: 'timeout', sha: 'c', at: '2026-09-28T10:50:00.000Z' },
        }),
      })
    )
    expect(states(slow)).toMatchObject({ release: 'done', staging: 'now' })
    expect(slow.stages.find(s => s.key === 'release')?.detail).toBe(
      'Main’s checks were slow, so the deploy will check it again.'
    )
    expect(slow.current?.text).toBe('Deploying v1.4.3 to staging')
  })

  it('live: every stage done, promote next with the app’s page', () => {
    const v = view(
      [...GREEN, ci('success')],
      row({
        status: 'shipped',
        prNumber: 12,
        landing: landing({ stage: 'live', version: '1.4.3', stagingUrl: 'https://s.test' }),
      }),
      { appPath: '/apps/expenses' }
    )
    expect(v.outcome).toBe('live')
    expect(v.current).toBeNull()
    expect(states(v)).toMatchObject({ staging: 'done', promote: 'next' })
    expect(v.stages.at(-1)?.link?.href).toBe('/apps/expenses')
  })

  it('stalled: the stage needs you, with what moves it on', () => {
    const before = view(
      [...GREEN, ci('success')],
      row({
        status: 'shipped',
        prNumber: 12,
        landing: landing({ stage: 'stalled', stalledReason: 'main_ci_failed' }),
      })
    )
    expect(before.outcome).toBe('stalled')
    expect(states(before)).toMatchObject({ merge: 'done', release: 'needs_you' })
    expect(before.needsYou?.action.kind).toBe('retry_stall')
    const after = view(
      [...GREEN, ci('success')],
      row({
        status: 'shipped',
        prNumber: 12,
        landing: landing({ stage: 'stalled', stalledReason: 'unhealthy', version: '1.4.3' }),
      })
    )
    expect(states(after)).toMatchObject({ release: 'done', staging: 'needs_you' })
    expect(after.needsYou?.action.kind).toBe('app_page')
  })

  it('failed: given back on red checks, with the check for "Ask Claude to fix it"', () => {
    const v = view(
      [
        ...GREEN,
        ci('failure', { failedCheck: { name: 'Gate', url: null } }),
        ev(6, 'ship.reopened', { reason: 'ci_failed', message: 'x' }),
      ],
      row({ status: 'ready', prNumber: 12 })
    )
    expect(v.outcome).toBe('handed_back')
    expect(states(v)).toMatchObject({ checks: 'failed', merge: 'next' })
    expect(v.needsYou?.action).toEqual({ kind: 'fix_ci', check: { name: 'Gate', url: null } })
  })
})

describe('currentShipEvents and shipInProgress', () => {
  it('a re-ship after the gate gave up starts again at attempt 1', () => {
    // The first ship stopped at attempt 1 (its test database never answered).
    const events = [
      running(1, 'lint', 1),
      gate(2, 'lint', true, 1),
      gate(3, 'test', false, 1),
      running(4, 'lint', 1),
      gate(5, 'lint', true, 1),
    ]
    expect(currentShipEvents(events).map(e => e.seq)).toEqual([4, 5])
    // A re-ship after a reopen too, and the attempt number going down.
    const reopened = [
      ...GREEN,
      ev(5, 'ship.reopened', { reason: 'ci_failed', message: '' }),
      gate(6, 'lint', true, 1),
    ]
    expect(currentShipEvents(reopened)[0]?.seq).toBe(6)
    // A verdict written twice is a retry, not a new ship.
    expect(currentShipEvents([gate(1, 'lint', true, 1), gate(2, 'lint', true, 1)])).toHaveLength(2)
  })

  it('the preview gives way while the ship moves, and comes back when it ends', () => {
    const base = { requestedAction: null } as Pick<Session, 'requestedAction'>
    expect(shipInProgress({ ...base, status: 'shipping', shipping: null })).toBe(true)
    expect(
      shipInProgress({ ...base, status: 'ready', requestedAction: 'ship', shipping: null })
    ).toBe(true)
    const moving = sessionShippingOf({
      status: 'shipped',
      landing: landing({ stage: 'deploying' }),
    })
    expect(shipInProgress({ ...base, status: 'shipped', shipping: moving })).toBe(true)
    expect(shipInProgress({ ...base, status: 'shipped', shipping: null })).toBe(false)
    expect(shipInProgress({ ...base, status: 'ready', shipping: null })).toBe(false)
  })

  it('the gate fix message carries the step and the end of its output', () => {
    const message = gateFixMessage('lint', 'x'.repeat(10_000), 1000)
    expect(message).toMatch(/^Lint found a problem when Launch checked the change/)
    expect(message.length).toBeLessThanOrEqual(1000)
    expect(gateFixMessage('test', null, 1000)).not.toContain('```')
  })
})

describe('the shared words (CLI, lists, chip)', () => {
  it('counts checks in words', () => {
    expect(checksCountText({ passed: 2, failed: 0, pending: 1 })).toBe('2 of 3 passed, 1 running')
    expect(checksCountText({ passed: 1, failed: 1, pending: 2, queued: 1 })).toBe(
      '1 of 4 passed, 1 failed, 1 running, 1 waiting for GitHub to start'
    )
    expect(checksCountText({ passed: 0, failed: 0, pending: 3, queued: 3 })).toBe(
      'Waiting for GitHub to start the checks'
    )
    expect(checksCountText({ passed: 0, failed: 0, pending: 0 })).toBe(
      'Waiting for the checks to report'
    )
  })

  it('says a stage, a try and a typical time plainly', () => {
    expect(shipStageText('review', 'done', { reviewer: 'Bob' })).toBe('Approved by Bob')
    expect(shipStageText('merge', 'failed', { reopen: 'pr_closed' })).toBe(
      'The pull request was closed'
    )
    expect(shipStageText('staging', 'now', { checkingHealth: true })).toBe(
      'Checking staging is healthy'
    )
    expect(gateFixingText('typecheck', 'Codex', 3)).toBe(
      'The type check found a problem. Codex is fixing it (try 3 of 3).'
    )
    expect(earlierTryText(1, 'test', true)).toBe('First try: tests failed, fixed automatically')
    expect(typicalDurationText('test', [])).toBeNull()
    expect(typicalDurationText('test', [360_000])).toBe('The tests took about 6 minutes last time')
    expect(typicalDurationText('test', [300_000, 360_000, 420_000])).toBe(
      'The tests usually take about 6 minutes'
    )
    expect(shipDurationText(192_000)).toBe('3 min 12 s')
    expect(mainChecksVerdictText('success')).toBeNull()
  })

  it('a ship in flight: the list line, and the chip', () => {
    const since = '2026-09-28T10:00:00.000Z'
    const at = (min: number) => Date.parse(since) + min * 60_000
    expect(shippingLineText({ stage: 'releasing', prNumber: 6, since, mainCi: null }, at(2))).toBe(
      'PR #6 · Merged, waiting for main’s checks · 2 min (releases anyway after 30 min)'
    )
    expect(
      shippingLineText({ stage: 'deploying', prNumber: 6, since, version: '1.4.2' }, at(75))
    ).toBe('PR #6 · Deploying v1.4.2 to staging · 1 h 15 min')
    expect(shippingSummaryText({ stage: 'stalled', stalledReason: 'main_ci_failed' })).toBe(
      'Merged, but main’s checks failed'
    )
    expect(shippingChipText({ stage: 'ci', waitingOn: null })).toBe('Checks running')
    expect(shippingChipText({ stage: 'stalled', waitingOn: 'retry' })).toBe('Needs you')
  })

  it('an elapsed clock ticks every second for an hour, then every minute', () => {
    expect(elapsedTickMs(5_000)).toBe(1000)
    expect(elapsedTickMs(2 * 60 * 60_000)).toBe(60_000)
  })
})

describe('approval policies: Required / Not required / Always', () => {
  const merge = DEFAULT_APPROVAL_POLICIES['session.merge']
  const deploy = DEFAULT_APPROVAL_POLICIES['deploy.production']

  it('session.merge: no row is not required; a row is required; everyone auto-approved is always', () => {
    expect(approvalRequirement('session.merge', null, merge)).toBe('not_required')
    expect(approvalRequirement('session.merge', merge, merge)).toBe('required')
    expect(
      approvalRequirement('session.merge', { ...merge, autoApproveRole: 'member' }, merge)
    ).toBe('always')
    expect(requirementSentence('session.merge', 'not_required')).toBe(
      'Not required. Each app decides in its Ship settings (default: no review).'
    )
  })

  it('a kind that always opens a request is not required only when everyone is auto-approved', () => {
    expect(approvalRequirement('deploy.production', null, deploy)).toBe('required')
    expect(
      approvalRequirement('deploy.production', { ...deploy, autoApproveRole: 'admin' }, deploy)
    ).toBe('required')
    expect(
      approvalRequirement('deploy.production', { ...deploy, autoApproveRole: 'member' }, deploy)
    ).toBe('not_required')
  })

  it('words auto-approval as Always, by role, or Never', () => {
    expect(autoApproveLabel('member')).toBe('Always (every request is approved at once)')
    expect(autoApproveLabel('admin')).toBe('When an admin or owner asks')
    expect(autoApproveLabel('owner')).toBe('When an owner asks')
    expect(autoApproveLabel(null)).toBe('Never (a person decides)')
  })
})
