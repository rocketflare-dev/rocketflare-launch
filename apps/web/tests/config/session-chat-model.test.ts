/**
 * The pure half of the coding-session page (Launch P3): the transcript fold, the tool one-liners,
 * the selectors the boot, preview and ship panels read, the log merge, and the polling decisions.
 * No DOM, no network — each of these guards a specific way the page could be quietly wrong.
 */
import type { SessionEvent } from '@launch/shared/launch-sessions'
import { describe, expect, it } from 'vitest'
import { mergeSessionEvents } from '@/ui/hooks/useSessionStream'
import {
  SESSION_POLL_MS,
  sessionHasSandbox,
  sessionListPollInterval,
  sessionPollInterval,
  turnInProgress,
} from '@/ui/hooks/useSessions'
import {
  bootSteps,
  buildSessionChat,
  latestPreviewChangeSeq,
  shipGateAttempts,
  shipGates,
  shipGateText,
  shortPath,
  toolSummary,
} from '@/ui/pages/sessions/sessionChatModel'

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

describe('buildSessionChat', () => {
  const turn = [
    ev(1, 'user.message', { text: 'Make it blue', userId: null }),
    ev(2, 'turn.start', { turn: 1 }),
    ev(3, 'tool.start', { name: 'Read', toolCallId: 'a', input: { file_path: 'src/App.tsx' } }),
    ev(4, 'tool.end', { name: 'Read', toolCallId: 'a' }),
    ev(5, 'tool.start', { name: 'Edit', toolCallId: 'b', input: { file_path: 'src/App.tsx' } }),
    ev(6, 'tool.end', { name: 'Edit', toolCallId: 'b', isError: true }),
    ev(7, 'text', { text: 'Done.' }),
    ev(8, 'turn.end', { turn: 1, durationMs: 3000, costMicrocents: 500_000 }),
  ]

  it('folds a turn into bubbles, ONE tool block, and a footnote', () => {
    const items = buildSessionChat(turn)
    expect(items.map(i => i.kind)).toEqual(['user', 'tools', 'assistant', 'turn-end'])
    const tools = items[1]
    expect(tools?.kind === 'tools' && tools.rows.map(r => [r.name, r.done, r.isError])).toEqual([
      ['Read', true, false],
      ['Edit', true, true],
    ])
  })

  it('is idempotent under duplicated and out-of-order rows', () => {
    const shuffled = [...turn].reverse()
    expect(buildSessionChat([...shuffled, ...turn])).toEqual(buildSessionChat(turn))
  })

  it('turns lifecycle rows into notices and hides the ones that are someone else’s', () => {
    const items = buildSessionChat([
      ev(1, 'step', { key: 'db', label: 'Database', status: 'done' }, 0),
      ev(2, 'preview.ready', { port: 5173 }, 0),
      ev(3, 'turn.interrupted', { turn: 1, reason: 'rollout' }),
      ev(4, 'budget.reached', { spentMicrocents: 1e9, capMicrocents: 1e9, scope: 'session' }),
      ev(5, 'turn.failed', { turn: 2, message: 'claude exited 1' }),
    ])
    expect(items.map(i => (i.kind === 'notice' ? [i.tone, i.text] : i.kind))).toEqual([
      ['warning', 'Cut off by a Launch update. Resume the session to carry on from here.'],
      ['warning', 'The session budget is used up ($10.00 of $10.00).'],
      ['error', 'This turn failed: claude exited 1'],
    ])
  })
})

describe('toolSummary', () => {
  it('says what a Claude Code tool did, in words', () => {
    expect(toolSummary('Edit', { file_path: '/workspace/app/src/ui/Header.tsx' })).toEqual({
      verb: 'Edited',
      target: '…/src/ui/Header.tsx',
    })
    expect(toolSummary('Bash', { command: 'pnpm test\n--run' })).toEqual({
      verb: 'Ran',
      target: 'pnpm test…',
    })
    expect(toolSummary('TodoWrite', {})).toEqual({ verb: 'Updated its plan' })
    expect(toolSummary('some_custom_tool', undefined)).toEqual({ verb: 'Some custom tool' })
  })

  it('keeps short paths whole', () => {
    expect(shortPath('src/App.tsx')).toBe('src/App.tsx')
  })
})

describe('selectors', () => {
  it('bootSteps: only the CURRENT boot, a done merged into its running row', () => {
    const events = [
      ev(1, 'step', { key: 'db', label: 'Database', status: 'running' }, 0),
      ev(2, 'step', { key: 'db', label: 'Database', status: 'done' }, 0),
      ev(3, 'preview.ready', { port: 5173 }, 0),
      ev(4, 'step', { key: 'sandbox', label: 'Sandbox', status: 'done' }, 1),
      ev(5, 'step', { key: 'repo', label: 'Clone', status: 'running' }, 1),
    ]
    expect(bootSteps(events).map(s => [s.key, s.status])).toEqual([
      ['sandbox', 'done'],
      ['repo', 'running'],
    ])
    expect(bootSteps(events.slice(0, 2)).map(s => [s.key, s.status, s.at.getUTCSeconds()])).toEqual(
      [['db', 'done', 1]]
    )
  })

  it('latestPreviewChangeSeq moves on a settled turn or a dev server coming up', () => {
    expect(
      latestPreviewChangeSeq([
        ev(1, 'preview.ready', { port: 5173 }, 0),
        ev(2, 'text', { text: 'x' }),
        ev(3, 'turn.end', { turn: 1 }),
        ev(4, 'user.message', { text: 'y', userId: null }, 2),
      ])
    ).toBe(3)
    expect(latestPreviewChangeSeq([])).toBe(0)
  })

  it('shipGateText names the step; a step-less (older) row is the whole gate', () => {
    expect(shipGateText({ passed: true, attempt: 1, step: 'lint' })).toBe(
      'Lint passed (attempt 1).'
    )
    expect(shipGateText({ passed: false, attempt: 2, step: 'test' })).toBe(
      'Tests failed on attempt 2.'
    )
    expect(shipGateText({ passed: false, attempt: 1 })).toBe(
      'Lint, typecheck or tests failed on attempt 1.'
    )
  })

  it('shipGateAttempts groups the steps by attempt; an attempt is green only once its tests are', () => {
    const gates = shipGates([
      ev(1, 'ship.gate', { step: 'lint', passed: true, attempt: 1 }),
      ev(2, 'ship.gate', { step: 'typecheck', passed: false, attempt: 1, output: 'TS2322' }),
      ev(3, 'ship.gate', { step: 'lint', passed: true, attempt: 2 }),
      ev(4, 'ship.gate', { step: 'typecheck', passed: true, attempt: 2 }),
      ev(5, 'ship.gate', { step: 'test', passed: true, attempt: 2, durationMs: 1000 }),
      ev(6, 'ship.gate', { step: 'lint', passed: true, attempt: 3 }),
      ev(7, 'ship.gate', { passed: true, attempt: 4 }),
    ])
    expect(gates[1]).toMatchObject({ step: 'typecheck', output: 'TS2322' })
    expect(gates[4]).toMatchObject({ step: 'test', durationMs: 1000 })
    expect(shipGateAttempts(gates).map(a => [a.attempt, a.steps.length, a.passed])).toEqual([
      [1, 2, false],
      [2, 3, true],
      // Still running: lint alone is not a green attempt.
      [3, 1, false],
      // A row from before the gate had steps was the whole gate.
      [4, 1, true],
    ])
  })

  it('shipGates lists every attempt in order', () => {
    expect(
      shipGates([
        ev(2, 'ship.gate', { passed: true, attempt: 2 }),
        ev(1, 'ship.gate', { passed: false, attempt: 1, output: 'boom' }),
      ]).map(g => [g.attempt, g.passed, g.output])
    ).toEqual([
      [1, false, 'boom'],
      [2, true, undefined],
    ])
  })
})

describe('mergeSessionEvents', () => {
  it('dedupes by id and orders by seq', () => {
    const a = ev(1, 'text', { text: 'a' })
    const b = ev(2, 'text', { text: 'b' })
    expect(mergeSessionEvents([b], [a, b]).map(e => e.seq)).toEqual([1, 2])
    const same = [a]
    expect(mergeSessionEvents(same, [])).toBe(same)
  })
})

describe('polling decisions', () => {
  it('polls only while the server owes the reader something', () => {
    const base = { pendingMessage: false, requestedAction: null } as const
    expect(sessionPollInterval({ ...base, status: 'working' })).toBe(SESSION_POLL_MS)
    expect(sessionPollInterval({ ...base, status: 'booting' })).toBe(SESSION_POLL_MS)
    // Waiting on a PERSON: never polled.
    expect(sessionPollInterval({ ...base, status: 'ready' })).toBe(false)
    expect(sessionPollInterval({ ...base, status: 'blocked' })).toBe(false)
    expect(sessionPollInterval({ ...base, status: 'suspended' })).toBe(false)
    expect(sessionPollInterval({ ...base, status: 'shipped' })).toBe(false)
    // About to move.
    expect(sessionPollInterval({ ...base, status: 'ready', pendingMessage: true })).toBe(
      SESSION_POLL_MS
    )
    expect(sessionPollInterval({ ...base, status: 'suspended', requestedAction: 'resume' })).toBe(
      SESSION_POLL_MS
    )
    // A settled row never, whatever its columns say.
    expect(sessionPollInterval({ ...base, status: 'ended', pendingMessage: true })).toBe(false)
    expect(sessionPollInterval(undefined)).toBe(false)
    expect(sessionListPollInterval([{ status: 'ready' }, { status: 'shipping' }])).toBe(
      SESSION_POLL_MS
    )
    expect(sessionListPollInterval([{ status: 'ready' }])).toBe(false)
  })

  it('knows when a turn is in progress and when there is a sandbox to preview', () => {
    expect(turnInProgress({ status: 'ready', pendingMessage: true })).toBe(true)
    expect(turnInProgress({ status: 'ready', pendingMessage: false })).toBe(false)
    expect(sessionHasSandbox('shipping')).toBe(true)
    expect(sessionHasSandbox('suspended')).toBe(false)
  })
})
