/**
 * A launch or a teardown as it happens (Launch P2): every step of `APP_LAUNCH_STEPS` /
 * `APP_TEARDOWN_STEPS` in order, grouped into a few phases a person can follow, each with its
 * status, attempt count and duration; a link to the step's GitHub Actions run once it is known (the
 * scaffold and staging-deploy waits); the failed step's error, verbatim; "Retry from failed step"
 * for whoever may retry; and, while a launch runs, "Stop" for whoever may retry — the way out of a
 * wait that will never end.
 *
 * Presentational: the page owns the query (`usePipeline`, which decides when to poll) and the retry
 * mutation, and passes the view in — so the Archive modal can show the same component for the
 * teardown the page is already watching.
 */
import {
  ArrowPathIcon,
  ArrowTopRightOnSquareIcon,
  CheckCircleIcon,
  MinusCircleIcon,
  RocketLaunchIcon,
  StopCircleIcon,
  TrashIcon,
  XCircleIcon,
} from '@heroicons/react/24/outline'
import type { AppOperationStatus } from '@launch/shared/launch-apps'
import {
  APP_LAUNCH_STEPS,
  APP_TEARDOWN_STEPS,
  type PipelineKind,
  type PipelineStep,
  type PipelineView,
} from '@launch/shared/launch-pipeline'
import { useState } from 'react'
import { formatDateTime, formatDuration, timeAgo } from '@/ui/lib/format'

// ---- Pure helpers ------------------------------------------------------------------------------------

const DEFINITIONS: Record<PipelineKind, readonly { step: string; label: string }[]> = {
  create: APP_LAUNCH_STEPS,
  teardown: APP_TEARDOWN_STEPS,
}

/**
 * Every defined step in order, each with the server's row when there is one and a `pending`
 * placeholder when there is not; a step the server knows and this build does not is kept, at the
 * end, rather than hidden. Pure.
 */
export function pipelineRows(view: Pick<PipelineView, 'kind' | 'steps'>): PipelineStep[] {
  const byStep = new Map(view.steps.map(step => [step.step, step]))
  const rows: PipelineStep[] = DEFINITIONS[view.kind].map(
    def =>
      byStep.get(def.step) ?? {
        step: def.step,
        label: def.label,
        status: 'pending',
        attempt: 0,
        error: null,
        startedAt: null,
        finishedAt: null,
        url: null,
      }
  )
  const known = new Set(rows.map(row => row.step))
  return [...rows, ...view.steps.filter(step => !known.has(step.step))]
}

export interface PipelineSummary {
  /** Steps that need no more work: succeeded or skipped. */
  done: number
  total: number
  /** The step being worked on, the first failed one, or the next pending one. */
  current: PipelineStep | null
  failed: PipelineStep | null
  startedAt: Date | null
  finishedAt: Date | null
}

/** Where the run stands. Pure. */
export function summarisePipeline(rows: readonly PipelineStep[]): PipelineSummary {
  const failed = rows.find(row => row.status === 'failed') ?? null
  const running = rows.find(row => row.status === 'running') ?? null
  const pending = rows.find(row => row.status === 'pending') ?? null
  const starts = rows.flatMap(row => (row.startedAt ? [row.startedAt.getTime()] : []))
  const ends = rows.flatMap(row => (row.finishedAt ? [row.finishedAt.getTime()] : []))
  return {
    done: rows.filter(row => row.status === 'succeeded' || row.status === 'skipped').length,
    total: rows.length,
    current: running ?? failed ?? pending,
    failed,
    startedAt: starts.length ? new Date(Math.min(...starts)) : null,
    finishedAt: ends.length ? new Date(Math.max(...ends)) : null,
  }
}

/** `1m 12s` for a finished step; null while it runs or before it starts. Pure. */
export function stepDuration(step: Pick<PipelineStep, 'startedAt' | 'finishedAt'>): string | null {
  if (!step.startedAt || !step.finishedAt) return null
  return formatDuration(step.finishedAt.getTime() - step.startedAt.getTime())
}

interface Phase {
  label: string
  steps: readonly string[]
}

/** The launch's four phases — what a person watching it actually tracks. */
const LAUNCH_PHASES: readonly Phase[] = [
  {
    label: 'Repository',
    steps: ['reserve', 'repo', 'scaffold.start', 'scaffold.wait', 'scaffold.verify'],
  },
  {
    label: 'Infrastructure',
    steps: [
      'neon',
      'cloudflare',
      'oidc_client',
      'write_config',
      'placeholders',
      'github_env',
      'worker_secrets',
      'email',
    ],
  },
  {
    label: 'Staging',
    steps: ['deploy_staging.start', 'deploy_staging.wait', 'deploy_staging.check', 'health'],
  },
  { label: 'Go live', steps: ['production', 'live'] },
]

const TEARDOWN_PHASES: readonly Phase[] = [
  { label: 'Traffic', steps: ['routes', 'queue_consumers', 'workers', 'workflows'] },
  { label: 'Storage', steps: ['queues', 'r2', 'kv'] },
  { label: 'Accounts', steps: ['email', 'neon', 'oidc_client'] },
  { label: 'Repository', steps: ['repo', 'archived'] },
]

export interface PhaseGroup {
  label: string
  status: AppOperationStatus
  rows: PipelineStep[]
}

/** A phase's status from its steps: failed > running > all done > pending (partly done = running). */
function phaseStatus(rows: readonly PipelineStep[]): AppOperationStatus {
  if (rows.some(r => r.status === 'failed')) return 'failed'
  if (rows.some(r => r.status === 'running')) return 'running'
  if (rows.every(r => r.status === 'skipped')) return 'skipped'
  if (rows.every(r => r.status === 'succeeded' || r.status === 'skipped')) return 'succeeded'
  if (rows.some(r => r.status === 'succeeded')) return 'running'
  return 'pending'
}

/** Rows into their phases, in order; a step no phase names joins an "Other" phase at the end. Pure. */
export function groupPhases(kind: PipelineKind, rows: readonly PipelineStep[]): PhaseGroup[] {
  const phases = kind === 'create' ? LAUNCH_PHASES : TEARDOWN_PHASES
  const placed = new Set<string>()
  const groups = phases.map(phase => {
    const phaseRows = phase.steps.flatMap(key => {
      const row = rows.find(r => r.step === key)
      if (!row) return []
      placed.add(key)
      return [row]
    })
    return { label: phase.label, rows: phaseRows }
  })
  const other = rows.filter(row => !placed.has(row.step))
  if (other.length) groups.push({ label: 'Other', rows: other })
  return groups
    .filter(group => group.rows.length > 0)
    .map(group => ({ ...group, status: phaseStatus(group.rows) }))
}

// ---- Rendering -----------------------------------------------------------------------------------------

const STATUS_LABEL: Record<AppOperationStatus, string> = {
  pending: 'Waiting',
  running: 'Running',
  succeeded: 'Done',
  failed: 'Failed',
  skipped: 'Skipped',
}

/** The glyph carries the state for anyone who cannot tell the colours apart; the label names it. */
function StepIcon({
  status,
  className = 'w-5 h-5',
}: {
  status: AppOperationStatus
  className?: string
}) {
  const label = STATUS_LABEL[status]
  if (status === 'running') {
    return (
      <span role="img" aria-label={label} className={`grid place-items-center ${className}`}>
        <span className="loading loading-spinner loading-xs text-primary" />
      </span>
    )
  }
  if (status === 'pending') {
    return (
      <span role="img" aria-label={label} className={`grid place-items-center ${className}`}>
        <span className="w-3 h-3 rounded-full border-2 border-base-300" />
      </span>
    )
  }
  const Icon =
    status === 'succeeded' ? CheckCircleIcon : status === 'failed' ? XCircleIcon : MinusCircleIcon
  const tone =
    status === 'succeeded' ? 'text-success' : status === 'failed' ? 'text-error' : 'text-muted'
  return (
    <span role="img" aria-label={label} className={`shrink-0 ${className} ${tone}`}>
      <Icon className="w-full h-full" />
    </span>
  )
}

/** "View run" — the step's GitHub Actions run, in a new tab. */
function RunLink({ url, className = '' }: { url: string; className?: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className={`link link-hover inline-flex items-center gap-0.5 ${className}`}
    >
      View run
      <ArrowTopRightOnSquareIcon className="w-3 h-3" aria-hidden="true" />
    </a>
  )
}

function StepRow({ step }: { step: PipelineStep }) {
  const duration = stepDuration(step)
  const active = step.status === 'running' || step.status === 'failed'
  return (
    <li
      className={`flex items-start gap-2.5 rounded-md px-2 py-1.5 -mx-2 ${
        step.status === 'running' ? 'bg-base-200' : ''
      }`}
      data-step={step.step}
      data-status={step.status}
    >
      <StepIcon status={step.status} />
      <div className="flex-1 min-w-0">
        <span
          className={`block text-sm leading-5 ${
            step.status === 'pending' || step.status === 'skipped' ? 'text-muted' : ''
          } ${active ? 'font-medium' : ''}`}
        >
          {step.label}
        </span>
        {(step.url || step.attempt > 1) && (
          <span className="mt-0.5 flex flex-wrap items-center gap-2">
            {step.url && <RunLink url={step.url} className="text-xs leading-5" />}
            {step.attempt > 1 && (
              <span className="status-badge no-dot tone-warning" title={`attempt ${step.attempt}`}>
                ×{step.attempt}
              </span>
            )}
          </span>
        )}
      </div>
      <span className="text-xs leading-5 text-muted tabular-nums shrink-0">
        {step.status === 'running' && step.startedAt ? (
          <span title={formatDateTime(step.startedAt)}>
            {formatDuration(Date.now() - step.startedAt.getTime())}…
          </span>
        ) : step.status === 'skipped' ? (
          'skipped'
        ) : (
          (duration ?? '')
        )}
      </span>
    </li>
  )
}

const PHASE_TONE: Record<AppOperationStatus, string> = {
  pending: 'text-muted',
  running: 'text-primary',
  succeeded: 'text-success',
  failed: 'text-error',
  skipped: 'text-muted',
}

function PhaseBlock({ phase, index }: { phase: PhaseGroup; index: number }) {
  const done = phase.rows.filter(r => r.status === 'succeeded' || r.status === 'skipped').length
  return (
    <section
      className={`rounded-lg border p-3 ${
        phase.status === 'running'
          ? 'border-primary'
          : phase.status === 'failed'
            ? 'border-error'
            : 'border-base-300'
      }`}
      aria-label={`${phase.label}: ${STATUS_LABEL[phase.status]}`}
    >
      <header className="flex items-center justify-between gap-2 mb-1.5">
        <h3 className="text-xs font-semibold uppercase tracking-wide flex items-center gap-2">
          <span className={`tabular-nums ${PHASE_TONE[phase.status]}`}>{index + 1}</span>
          {phase.label}
        </h3>
        <span className={`text-xs tabular-nums ${PHASE_TONE[phase.status]}`}>
          {done}/{phase.rows.length}
        </span>
      </header>
      <ol className="space-y-0.5">
        {phase.rows.map(step => (
          <StepRow key={step.step} step={step} />
        ))}
      </ol>
    </section>
  )
}

const HEADLINE: Record<PipelineKind, Record<PipelineView['status'], string>> = {
  create: {
    none: 'Waiting for the launch to start',
    running: 'Launching',
    succeeded: 'Launched',
    failed: 'The launch stopped',
  },
  teardown: {
    none: 'Waiting for the teardown to start',
    running: 'Archiving',
    succeeded: 'Archived',
    failed: 'The teardown stopped',
  },
}

export interface PipelineProgressProps {
  view: PipelineView
  /** Whoever may retry sees the button; everyone else a sentence. */
  canRetry: boolean
  onRetry?: () => void
  retrying?: boolean
  /** Shown under the headline while the launch runs, e.g. the staging host it is building. */
  subject?: React.ReactNode
  /** Inside a modal: no outer panel, no big header icon. */
  compact?: boolean
  /** "Stop" a running launch (shown with `canRetry`): its step fails, and retry is offered. */
  onCancel?: () => void
  cancelling?: boolean
}

export function PipelineProgress({
  view,
  canRetry,
  onRetry,
  retrying = false,
  subject,
  compact = false,
  onCancel,
  cancelling = false,
}: PipelineProgressProps) {
  const [confirmStop, setConfirmStop] = useState(false)
  const canStop = canRetry && !!onCancel && view.kind === 'create' && view.status === 'running'
  const rows = pipelineRows(view)
  const summary = summarisePipeline(rows)
  const phases = groupPhases(view.kind, rows)
  const percent = summary.total ? Math.round((summary.done / summary.total) * 100) : 0
  const HeaderIcon = view.kind === 'create' ? RocketLaunchIcon : TrashIcon
  const failed = view.status === 'failed' ? summary.failed : null
  const elapsed =
    summary.startedAt && view.status !== 'running' && summary.finishedAt
      ? formatDuration(summary.finishedAt.getTime() - summary.startedAt.getTime())
      : null

  return (
    <section
      className={compact ? 'space-y-4' : 'surface-panel space-y-4'}
      aria-label={view.kind === 'create' ? 'Launch progress' : 'Teardown progress'}
      aria-busy={view.status === 'running'}
    >
      <header className="flex items-start gap-3">
        {!compact && (
          <span
            aria-hidden="true"
            className={`grid place-items-center w-10 h-10 shrink-0 rounded-lg border ${
              view.status === 'failed' ? 'tone-warning' : 'tone-primary'
            }`}
          >
            <HeaderIcon className={`w-5 h-5 ${view.status === 'running' ? 'animate-pulse' : ''}`} />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold leading-6">
            {HEADLINE[view.kind][view.status]}
            {view.status === 'running' && summary.current && (
              <span className="font-normal text-secondary"> · {summary.current.label}</span>
            )}
          </h2>
          <p className="text-sm text-secondary mt-0.5">
            Step {Math.min(summary.done + (view.status === 'succeeded' ? 0 : 1), summary.total)} of{' '}
            {summary.total}
            {summary.startedAt && view.status === 'running' && (
              <> · started {timeAgo(summary.startedAt)}</>
            )}
            {elapsed && <> · took {elapsed}</>}
            {subject && <> · {subject}</>}
          </p>
        </div>
        <span
          className={`text-2xl font-semibold tabular-nums leading-none ${
            view.status === 'failed'
              ? 'text-error'
              : view.status === 'succeeded'
                ? 'text-success'
                : ''
          }`}
          aria-hidden="true"
        >
          {percent}%
        </span>
      </header>

      <progress
        className={`progress w-full ${
          view.status === 'failed'
            ? 'progress-error'
            : view.status === 'succeeded'
              ? 'progress-success'
              : 'progress-primary'
        }`}
        value={summary.done}
        max={summary.total}
        aria-label={`${summary.done} of ${summary.total} steps done`}
      />

      {failed && (
        <div className="alert alert-error alert-soft items-start text-sm" role="alert">
          <XCircleIcon className="w-5 h-5 shrink-0" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <p className="font-medium">
              {failed.label} failed
              {failed.attempt > 1 ? ` after ${failed.attempt} attempts` : ''}
            </p>
            {failed.error && (
              <pre className="font-mono text-xs whitespace-pre-wrap break-words opacity-90">
                {failed.error}
              </pre>
            )}
            {failed.url && <RunLink url={failed.url} className="text-xs" />}
            {!canRetry && (
              <p className="text-xs opacity-80">An administrator can retry from this step.</p>
            )}
          </div>
          {canRetry && onRetry && (
            <button
              type="button"
              className="btn btn-sm gap-1.5 shrink-0"
              onClick={onRetry}
              disabled={retrying}
            >
              {retrying ? (
                <span className="loading loading-spinner loading-xs" />
              ) : (
                <ArrowPathIcon className="w-4 h-4" />
              )}
              Retry from failed step
            </button>
          )}
        </div>
      )}

      {canStop && (
        <div className="flex flex-wrap items-center justify-end gap-2 text-sm">
          {confirmStop ? (
            <>
              <span className="text-secondary">
                Stop this launch? The current step is marked failed, and you can retry from it.
              </span>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setConfirmStop(false)}
                disabled={cancelling}
              >
                Keep going
              </button>
              <button
                type="button"
                className="btn btn-sm btn-error gap-1.5"
                onClick={() => {
                  setConfirmStop(false)
                  onCancel?.()
                }}
                disabled={cancelling}
              >
                Stop the launch
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn btn-sm btn-ghost gap-1.5"
              onClick={() => setConfirmStop(true)}
              disabled={cancelling}
            >
              {cancelling ? (
                <span className="loading loading-spinner loading-xs" />
              ) : (
                <StopCircleIcon className="w-4 h-4" />
              )}
              Stop
            </button>
          )}
        </div>
      )}

      <div className={`grid grid-cols-1 gap-3 ${compact ? '' : 'md:grid-cols-2 xl:grid-cols-4'}`}>
        {phases.map((phase, index) => (
          <PhaseBlock key={phase.label} phase={phase} index={index} />
        ))}
      </div>
    </section>
  )
}
