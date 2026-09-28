/**
 * What the overview's deploy panel and the catalogue SAY about a deploy (`DeployProgress`, from
 * `GET /api/apps/:id/deploys/latest` and the catalogue's `latestDeploy`) — pure, so the stepper,
 * a catalogue card and a table row can never describe one deploy three ways. The server derives
 * the phase; nothing here re-reads a ticket.
 */
import {
  DEPLOY_STEPS,
  type DeployPhase,
  type DeployProgress,
  type DeployStep,
} from '@launch/shared/launch-apps'

/** The stepper's labels, in `DEPLOY_STEPS` order. */
export const DEPLOY_STEP_LABELS: Record<DeployStep, string> = {
  dispatched: 'Dispatched',
  approved: 'Approved',
  uploaded: 'Uploaded',
  migrating: 'Migrating',
  activating: 'Activating',
  done: 'Live',
}

/** The phase as one short phrase (a badge, a catalogue line). */
export const DEPLOY_PHASE_LABELS: Record<DeployPhase, string> = {
  awaiting_approval: 'awaiting approval',
  dispatched: 'dispatched',
  approved: 'building',
  uploaded: 'uploaded',
  migrating: 'migrating',
  activating: 'activating',
  done: 'live',
  failed: 'failed',
}

/** Phase → the `.status-badge` vocabulary in `index.css`. */
export const DEPLOY_PHASE_TONES: Record<DeployPhase, string> = {
  awaiting_approval: 'awaiting-review',
  dispatched: 'queued',
  approved: 'running',
  uploaded: 'running',
  migrating: 'running',
  activating: 'running',
  done: 'active',
  failed: 'failed',
}

export type DeployStepState = 'done' | 'current' | 'waiting' | 'failed' | 'todo'

/**
 * Each step's state for the stepper. Steps up to `reached` are done; the next one is `current`
 * while the deploy runs (`waiting` while it waits on a person), `failed` when it failed there;
 * the rest are to do. A live deploy is done throughout. Pure.
 */
export function deployStepStates(
  d: Pick<DeployProgress, 'phase' | 'reached'>
): { step: DeployStep; state: DeployStepState }[] {
  const reachedAt = d.reached ? DEPLOY_STEPS.indexOf(d.reached) : -1
  return DEPLOY_STEPS.map((step, i) => {
    if (d.phase === 'done' || i <= reachedAt) return { step, state: 'done' as const }
    if (i === reachedAt + 1) {
      if (d.phase === 'failed') return { step, state: 'failed' as const }
      if (d.phase === 'awaiting_approval') return { step, state: 'waiting' as const }
      return { step, state: 'current' as const }
    }
    return { step, state: 'todo' as const }
  })
}

/** "Production deploy of 1.2.0" — the version, else the short commit, else nothing. Pure. */
export function deployTitle(d: Pick<DeployProgress, 'environment' | 'version' | 'sha'>): string {
  const env = d.environment === 'production' ? 'Production' : 'Staging'
  const what = d.version ?? (d.sha ? d.sha.slice(0, 7) : null)
  return what ? `${env} deploy of ${what}` : `${env} deploy`
}
