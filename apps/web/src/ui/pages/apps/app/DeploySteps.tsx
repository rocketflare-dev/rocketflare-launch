/**
 * One deploy's milestones — dispatched → approved → uploaded → migrating → activating → live — as
 * a compact row on the release page, each naming its state for a screen reader. What each step's
 * state IS comes from the pure `deployStepStates` (`components/deployProgressModel.ts`).
 */
import type { DeployProgress } from '@launch/shared/launch-apps'
import {
  DEPLOY_STEP_LABELS,
  type DeployStepState,
  deployStepStates,
} from '../components/deployProgressModel'

const STATE_LABEL: Record<DeployStepState, string> = {
  done: 'done',
  current: 'in progress',
  waiting: 'waiting for approval',
  failed: 'failed here',
  todo: 'not yet',
}

/** Literal class strings, so Tailwind's scanner sees every one. */
const TEXT: Record<DeployStepState, string> = {
  done: 'text-secondary',
  current: 'font-medium',
  waiting: 'font-medium',
  failed: 'text-error font-medium',
  todo: 'text-muted',
}

const GLYPH: Record<DeployStepState, string> = {
  done: '✓',
  current: '◐',
  waiting: '…',
  failed: '✕',
  todo: '○',
}

export function DeploySteps({ deploy }: { deploy: Pick<DeployProgress, 'phase' | 'reached'> }) {
  return (
    <ol className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs" aria-label="Deploy steps">
      {deployStepStates(deploy).map(({ step, state }) => (
        <li key={step} className={`flex items-center gap-1 ${TEXT[state]}`} data-state={state}>
          <span aria-hidden="true">{GLYPH[state]}</span>
          {DEPLOY_STEP_LABELS[step]}
          <span className="sr-only"> — {STATE_LABEL[state]}</span>
        </li>
      ))}
    </ol>
  )
}
