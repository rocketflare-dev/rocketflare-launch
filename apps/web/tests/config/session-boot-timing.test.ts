/**
 * Issue #8: the `boot.timing` event — its contract, the pure fold from the boot steps' clocks to
 * the payload (the `bootstrap` step split into `install` + `bootstrap`, overlapping phases, a step
 * result from before the clocks), and how the page and the CLI read it back: one quiet line, and
 * the first turn after a boot carrying how long the agent took to answer (the CLI's half is
 * `apps/cli/tests/sessions.test.ts`).
 */
import {
  BOOT_TIMING_PHASES,
  SESSION_EVENT_DATA,
  SESSION_EVENT_TYPES,
  type SessionBootTimingData,
  type SessionEvent,
  sessionBootTimingDataSchema,
  sessionTurnEndDataSchema,
} from '@launch/shared/launch-sessions'
import { describe, expect, it } from 'vitest'
import { bootTimingData, stepTiming } from '@/api/services/sessions/boot-timing'
import { BOOT_STEP_LABELS } from '@/api/services/sessions/steps'
import { bootTimingText, buildSessionChat } from '@/ui/pages/sessions/sessionChatModel'

const SESSION = '5e551000-0000-4000-8000-000000000001'
const ev = (seq: number, type: SessionEvent['type'], data: unknown, turn = 0): SessionEvent => ({
  id: `e0000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
  sessionId: SESSION,
  seq,
  turn,
  type,
  data,
  at: new Date(Date.UTC(2026, 9, 6, 10, 0, seq)),
})

describe('the boot.timing contract', () => {
  it('is an event type with a payload schema', () => {
    expect(SESSION_EVENT_TYPES).toContain('boot.timing')
    expect(SESSION_EVENT_DATA['boot.timing']).toBe(sessionBootTimingDataSchema)
  })

  it('parses a boot: kind, total, phases in start order, an optional trace id', () => {
    const data = {
      kind: 'boot',
      totalMs: 63_000,
      phases: [
        { phase: 'db', startMs: 0, ms: 4_000 },
        { phase: 'sandbox.start', startMs: 4_000, ms: 12_000 },
      ],
      traceId: 'a'.repeat(32),
    }
    expect(sessionBootTimingDataSchema.parse(data)).toEqual(data)
    expect(sessionBootTimingDataSchema.parse({ ...data, traceId: undefined }).traceId).toBe(
      undefined
    )
  })

  it('refuses an unknown phase or kind, and a negative or fractional duration', () => {
    const ok = { kind: 'cold', totalMs: 1, phases: [{ phase: 'repo', startMs: 0, ms: 1 }] }
    expect(sessionBootTimingDataSchema.safeParse(ok).success).toBe(true)
    for (const bad of [
      { ...ok, kind: 'hot' },
      { ...ok, phases: [{ phase: 'compile', startMs: 0, ms: 1 }] },
      { ...ok, phases: [{ phase: 'repo', startMs: 0, ms: -1 }] },
      { ...ok, totalMs: 1.5 },
    ]) {
      expect(sessionBootTimingDataSchema.safeParse(bad).success).toBe(false)
    }
  })

  it('names every boot checklist step (the bootstrap split in two)', () => {
    expect([...BOOT_TIMING_PHASES].sort()).toEqual(
      [
        ...Object.keys(BOOT_STEP_LABELS).map(k => (k === 'sandbox' ? 'sandbox.start' : k)),
        'install',
      ].sort()
    )
  })

  it('turn.end carries the first token, optionally', () => {
    expect(sessionTurnEndDataSchema.parse({ turn: 1, firstTokenMs: 2_400 }).firstTokenMs).toBe(
      2_400
    )
    expect(sessionTurnEndDataSchema.parse({ turn: 1 }).firstTokenMs).toBeUndefined()
  })
})

describe('bootTimingData', () => {
  it('reports each step from the boot’s first start, splitting the install out of bootstrap', () => {
    const t0 = 1_000_000
    const data = bootTimingData('boot', [
      stepTiming('db', t0, t0 + 4_000, { branched: true }),
      stepTiming('sandbox', t0 + 4_000, t0 + 16_000, { bootId: 'x' }),
      stepTiming('repo', t0 + 16_000, t0 + 24_000, {}),
      stepTiming('bootstrap', t0 + 24_000, t0 + 58_000, { installMs: 25_000, bootstrapMs: 8_000 }),
      stepTiming('dev', t0 + 58_000, t0 + 63_000, { ready: true }),
    ])
    expect(data).toEqual({
      kind: 'boot',
      totalMs: 63_000,
      phases: [
        { phase: 'db', startMs: 0, ms: 4_000 },
        { phase: 'sandbox.start', startMs: 4_000, ms: 12_000 },
        { phase: 'repo', startMs: 16_000, ms: 8_000 },
        { phase: 'install', startMs: 24_000, ms: 25_000 },
        // The step's own overhead (the hash, the dev vars) counts as the bootstrap's.
        { phase: 'bootstrap', startMs: 49_000, ms: 9_000 },
        { phase: 'dev', startMs: 58_000, ms: 5_000 },
      ],
    })
    expect(sessionBootTimingDataSchema.safeParse(data).success).toBe(true)
  })

  it('overlapping phases make the total less than the sum, in start order', () => {
    const data = bootTimingData('boot', [
      stepTiming('sandbox', 100, 5_100, {}),
      stepTiming('db', 0, 3_000, {}),
      stepTiming('dev', 5_100, 6_100, {}),
    ])
    expect(data.phases.map(p => p.phase)).toEqual(['db', 'sandbox.start', 'dev'])
    expect(data.phases[1]).toEqual({ phase: 'sandbox.start', startMs: 100, ms: 5_000 })
    expect(data.totalMs).toBe(6_100)
  })

  it('a restored workspace’s bootstrap ran no install; a step from before the clocks is left out', () => {
    const data = bootTimingData('cold', [
      stepTiming('sandbox', 0, 1_000, {}),
      undefined,
      stepTiming('bootstrap', 2_000, 2_500, { installMs: 0, bootstrapMs: 0, reused: true }),
    ])
    expect(data.phases).toEqual([
      { phase: 'sandbox.start', startMs: 0, ms: 1_000 },
      { phase: 'bootstrap', startMs: 2_000, ms: 500 },
    ])
  })
})

describe('reading boot.timing back', () => {
  const boot: SessionBootTimingData = {
    kind: 'boot',
    totalMs: 63_000,
    phases: [
      { phase: 'db', startMs: 0, ms: 4_000 },
      { phase: 'install', startMs: 4_000, ms: 59_000 },
    ],
  }
  const warm: SessionBootTimingData = { kind: 'warm', totalMs: 2_000, phases: [] }
  const rows = [
    ev(1, 'boot.timing', boot),
    ev(2, 'user.message', { text: 'hi', userId: null }, 1),
    ev(3, 'turn.end', { turn: 1, durationMs: 9_000, firstTokenMs: 2_400 }, 1),
    ev(4, 'turn.end', { turn: 2, durationMs: 5_000, firstTokenMs: 1_100 }, 2),
    ev(5, 'boot.timing', warm),
  ]

  it('the page: one quiet line per boot; only the first turn after it shows its first reply', () => {
    expect(bootTimingText(boot)).toBe('Ready in 1m 3s: database 4s, install 59s')
    expect(bootTimingText(warm)).toBe('Resumed in 2s')
    const items = buildSessionChat(rows)
    expect(items.filter(i => i.kind === 'notice').map(i => i.kind === 'notice' && i.text)).toEqual([
      'Ready in 1m 3s: database 4s, install 59s',
      'Resumed in 2s',
    ])
    const ends = items.filter(i => i.kind === 'turn-end')
    expect(ends.map(i => i.kind === 'turn-end' && i.firstTokenMs)).toEqual([2_400, undefined])
  })
})
