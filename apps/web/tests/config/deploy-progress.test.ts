/**
 * The pure half of deploy progress (`services/launch/deploy/progress.ts`): the phase and the last
 * milestone read off a ticket's columns, when a GitHub run has ended without its deploy, and which
 * deploy a catalogue row shows. The read and the poll are `tests/api/deploy-progress.test.ts`.
 */
import type { DeployProgress } from '@launch/shared/launch-apps'
import { describe, expect, it } from 'vitest'
import {
  catalogueDeploy,
  deployPhase,
  deployReached,
  endedRunReason,
} from '@/api/services/launch/deploy/progress'
import { FINISHED_BEFORE_ACTIVATE } from '@/api/services/launch/deploy/tickets'

const NOW = new Date('2026-09-28T12:00:00Z')
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000)

type Facts = Parameters<typeof deployPhase>[0]
const ticket = (over: Partial<Facts> = {}): Facts => ({
  status: 'approved',
  runId: '123',
  decidedAt: at(-10),
  cfVersionId: null,
  credentialsIssuedAt: null,
  activationStartedAt: null,
  activatedAt: null,
  expiresAt: null,
  error: null,
  refused: null,
  ...over,
})

describe('deployPhase / deployReached', () => {
  it('walks a deploy through every step', () => {
    const steps: [Partial<Facts>, string, string | null][] = [
      [{ runId: null, expiresAt: at(10) }, 'dispatched', 'dispatched'],
      [
        { status: 'pending', decidedAt: null, expiresAt: at(10) },
        'awaiting_approval',
        'dispatched',
      ],
      [{}, 'approved', 'approved'],
      [{ status: 'uploaded', cfVersionId: 'v1' }, 'uploaded', 'uploaded'],
      [
        { status: 'uploaded', cfVersionId: 'v1', credentialsIssuedAt: at(-2) },
        'migrating',
        'migrating',
      ],
      [
        {
          status: 'uploaded',
          cfVersionId: 'v1',
          credentialsIssuedAt: at(-2),
          activationStartedAt: at(-1),
        },
        'activating',
        'activating',
      ],
      [{ status: 'active', cfVersionId: 'v1', activatedAt: at(-1) }, 'done', 'done'],
      [{ status: 'finished', cfVersionId: 'v1', activatedAt: at(-1) }, 'done', 'done'],
    ]
    for (const [over, phase, reached] of steps) {
      const t = ticket(over)
      expect(deployPhase(t, NOW).phase, JSON.stringify(over)).toBe(phase)
      expect(deployReached(t), JSON.stringify(over)).toBe(reached)
    }
  })

  it('fails every dead end with a sentence, keeping where it stopped', () => {
    const cases: [Partial<Facts>, RegExp, string | null][] = [
      [{ status: 'failed', refused: ['kv CACHE=x'] }, /Refused: kv CACHE=x/, 'approved'],
      [
        { status: 'failed', cfVersionId: 'v1', credentialsIssuedAt: at(-3), error: 'boom' },
        /boom/,
        'migrating',
      ],
      [
        { status: 'finished', cfVersionId: 'v1', error: FINISHED_BEFORE_ACTIVATE },
        /without activating/,
        'uploaded',
      ],
      [{ status: 'rejected', decidedAt: null }, /rejected/, 'dispatched'],
      [{ status: 'pending', decidedAt: null, expiresAt: at(-1) }, /in time/, 'dispatched'],
      [{ runId: null, expiresAt: at(-1) }, /lapsed/, 'dispatched'],
    ]
    for (const [over, error, reached] of cases) {
      const t = ticket(over)
      const { phase, error: sentence } = deployPhase(t, NOW)
      expect(phase, JSON.stringify(over)).toBe('failed')
      expect(sentence, JSON.stringify(over)).toMatch(error)
      expect(deployReached(t), JSON.stringify(over)).toBe(reached)
    }
  })

  it('never calls an uploaded version without activated_at live', () => {
    expect(deployPhase(ticket({ status: 'finished', cfVersionId: 'v1' }), NOW).phase).toBe('failed')
  })
})

describe('endedRunReason', () => {
  const claimed = { status: 'uploaded' as const, runAttempt: 1 }

  it('is no verdict while the run is running, or when GitHub has no such run', () => {
    expect(
      endedRunReason(claimed, { status: 'in_progress', conclusion: null, run_attempt: 1 })
    ).toBe(null)
    expect(endedRunReason(claimed, null)).toBe(null)
  })

  it('ends a claimed ticket whose run completed, with its conclusion', () => {
    expect(
      endedRunReason(claimed, { status: 'completed', conclusion: 'failure', run_attempt: 1 })
    ).toMatch(/ended “failure” before it was activated/)
    expect(
      endedRunReason(
        { status: 'approved', runAttempt: 1 },
        { status: 'completed', conclusion: null, run_attempt: 1 }
      )
    ).toMatch(/without a result” before it was uploaded/)
  })

  it('ends an attempt a re-run superseded, even while the re-run is going', () => {
    expect(
      endedRunReason(claimed, { status: 'in_progress', conclusion: null, run_attempt: 2 })
    ).toMatch(/attempt 2 is a deploy of its own/)
  })
})

describe('catalogueDeploy', () => {
  const d = (over: Partial<DeployProgress>): DeployProgress => ({
    ticketId: crypto.randomUUID(),
    environment: 'staging',
    phase: 'done',
    reached: 'done',
    inProgress: false,
    version: null,
    sha: null,
    ref: null,
    actor: null,
    runUrl: null,
    error: null,
    approvalId: null,
    startedAt: at(0),
    updatedAt: at(0),
    activatedAt: null,
    finishedAt: null,
    ...over,
  })

  it('prefers the newest in-progress deploy, else the newest of all, else null', () => {
    const running = d({
      environment: 'production',
      phase: 'migrating',
      inProgress: true,
      startedAt: at(-30),
    })
    const newer = d({ startedAt: at(-1) })
    expect(catalogueDeploy([newer, running])).toBe(running)
    expect(catalogueDeploy([d({ startedAt: at(-9) }), newer])).toBe(newer)
    expect(catalogueDeploy([])).toBeNull()
  })
})
