/**
 * The app overview's latest deploys (`GET /api/apps/:id/deploys/latest`): one row per environment
 * that has deployed, newest ticket each. A deploy in progress shows its stepper — dispatched →
 * approved → uploaded → migrating → activating → live — with the step it is on, who started it and
 * its GitHub Actions run; a failed one shows where it stopped and why; a live one is one line.
 *
 * The page does not own the query: this panel polls through `useDeployProgress`, only while a
 * deploy is in progress and not waiting on a person, and that hook refreshes the rest of the app
 * once the deploy settles. A deploy waiting on an approval links to the request.
 */
import {
  ArrowTopRightOnSquareIcon,
  CheckCircleIcon,
  CloudArrowUpIcon,
  ExclamationTriangleIcon,
  XCircleIcon,
} from '@heroicons/react/24/outline'
import { approvalPath } from '@launch/shared/launch-approvals'
import type { DeployProgress } from '@launch/shared/launch-apps'
import { Link } from 'react-router-dom'
import { SectionPanel } from '@/ui/components/shared'
import { useDeployProgress } from '@/ui/hooks/useDeploys'
import { formatDateTime, timeAgo } from '@/ui/lib/format'
import {
  DEPLOY_PHASE_LABELS,
  DEPLOY_PHASE_TONES,
  DEPLOY_STEP_LABELS,
  type DeployStepState,
  deployStepStates,
  deployTitle,
} from './deployProgressModel'

const STATE_LABEL: Record<DeployStepState, string> = {
  done: 'done',
  current: 'in progress',
  waiting: 'waiting for approval',
  failed: 'failed here',
  todo: 'not yet',
}

function StepGlyph({ state }: { state: DeployStepState }) {
  if (state === 'done') return <CheckCircleIcon className="w-5 h-5 text-success" />
  if (state === 'failed') return <XCircleIcon className="w-5 h-5 text-error" />
  if (state === 'current') {
    return <span className="loading loading-spinner loading-xs text-primary" />
  }
  if (state === 'waiting') {
    return <span className="w-3 h-3 rounded-full border-2 border-warning bg-warning/30" />
  }
  return <span className="w-3 h-3 rounded-full border-2 border-base-300" />
}

/** The six milestones in a row; each names its state for a screen reader. */
export function DeployStepper({ deploy }: { deploy: Pick<DeployProgress, 'phase' | 'reached'> }) {
  return (
    <ol className="flex flex-wrap items-center gap-x-1 gap-y-2" aria-label="Deploy steps">
      {deployStepStates(deploy).map(({ step, state }, i) => (
        <li key={step} className="flex items-center gap-1" data-state={state}>
          {i > 0 && (
            <span
              aria-hidden="true"
              className={`w-4 h-px ${state === 'todo' ? 'bg-base-300' : 'bg-success'}`}
            />
          )}
          <span className="grid place-items-center w-5 h-5 shrink-0">
            <StepGlyph state={state} />
          </span>
          <span
            className={`text-xs ${
              state === 'current' || state === 'waiting'
                ? 'font-semibold'
                : state === 'todo'
                  ? 'text-muted'
                  : state === 'failed'
                    ? 'text-error font-semibold'
                    : 'text-secondary'
            }`}
          >
            {DEPLOY_STEP_LABELS[step]}
            <span className="sr-only"> — {STATE_LABEL[state]}</span>
          </span>
        </li>
      ))}
    </ol>
  )
}

function RunLink({ url }: { url: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="link link-hover inline-flex items-center gap-0.5"
    >
      View run
      <ArrowTopRightOnSquareIcon className="w-3 h-3" />
    </a>
  )
}

function EnvTag({ env }: { env: DeployProgress['environment'] }) {
  return (
    <span
      className={`status-badge no-dot capitalize ${env === 'production' ? 'tone-primary' : 'tone-warning'}`}
    >
      {env}
    </span>
  )
}

function DeployRow({ deploy }: { deploy: DeployProgress }) {
  const live = deploy.phase === 'done'
  const failed = deploy.phase === 'failed'
  const when = live ? (deploy.activatedAt ?? deploy.updatedAt) : deploy.startedAt
  return (
    <li
      className={`rounded-lg border border-base-300 p-3 space-y-2 ${
        deploy.inProgress
          ? 'border-l-4 border-l-primary'
          : failed
            ? 'border-l-4 border-l-error'
            : ''
      }`}
      data-testid={`deploy-${deploy.environment}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <EnvTag env={deploy.environment} />
        <span className="text-sm font-medium">{deployTitle(deploy)}</span>
        <span className="status-badge" data-status={DEPLOY_PHASE_TONES[deploy.phase]}>
          {DEPLOY_PHASE_LABELS[deploy.phase]}
        </span>
        <span className="text-xs text-secondary ml-auto flex flex-wrap items-center gap-x-2">
          <span title={formatDateTime(when)}>
            {live ? 'live ' : 'started '}
            {timeAgo(when)}
          </span>
          {deploy.actor && <span>by {deploy.actor}</span>}
          {deploy.runUrl && <RunLink url={deploy.runUrl} />}
        </span>
      </div>
      {!live && <DeployStepper deploy={deploy} />}
      {failed && deploy.error && (
        <p className="text-xs text-error flex items-start gap-1">
          <ExclamationTriangleIcon className="w-4 h-4 shrink-0" />
          <span>{deploy.error}</span>
        </p>
      )}
      {deploy.phase === 'awaiting_approval' && (
        <p className="text-xs text-secondary">
          The run is waiting for someone to approve it.
          {deploy.approvalId && (
            <>
              {' '}
              <Link to={approvalPath(deploy.approvalId)} className="link link-hover">
                See the request
              </Link>
            </>
          )}
        </p>
      )}
    </li>
  )
}

export function DeployProgressPanel({ appId }: { appId: string }) {
  const { data } = useDeployProgress(appId)
  const items = data?.items ?? []
  if (items.length === 0) return null
  const running = items.some(d => d.inProgress)
  return (
    <SectionPanel
      title={running ? 'Deploying' : 'Latest deploys'}
      description={
        running
          ? 'A deploy is under way; this follows it as it runs.'
          : 'The newest deploy of each environment.'
      }
      actions={<CloudArrowUpIcon className="w-5 h-5 text-muted" aria-hidden="true" />}
    >
      <ul className="space-y-3" aria-live="polite">
        {items.map(deploy => (
          <DeployRow key={deploy.ticketId} deploy={deploy} />
        ))}
      </ul>
    </SectionPanel>
  )
}
