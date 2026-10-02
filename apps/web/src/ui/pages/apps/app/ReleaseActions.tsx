/**
 * What a person can do about a release that is stuck or in flight (app page P2, plan decision 7):
 *
 * - **Retry** — ONE button for whichever stage failed (`release.failedStage`, stamped by the
 *   server), labelled with what it does (`RELEASE_RETRY_LABELS`: "Retry staging deploy", "Check
 *   staging again", "Request approval again"…). The stage the reader saw travels with the request,
 *   so a release that moved on meanwhile is refused rather than retried differently;
 * - **Fix in a session** — starts a coding session seeded with the failure (stage, GitHub run, the
 *   failed job's log tail) and opens it;
 * - **Cancel release** — stops the deploy run in flight on GitHub, after a confirm;
 * - **Roll back to here** (app page P3) — on an earlier release that was live before: the same
 *   production approval as Ship, then the repo's own deploy workflow at that tag. The confirm says
 *   what does not come back with it (migrations, config and secrets).
 *
 * Retry, Cancel and Roll back are for the app's owners and admins (`viewerCanDeploy`, the server's
 * rule); Fix in a session for whoever may start a session. Each is hidden from a reader who cannot
 * use it.
 */
import { RELEASE_RETRY_LABELS, type Release } from '@launch/shared/launch-releases'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ConfirmModal, showToast } from '@/ui/components/shared'
import { usePermissions } from '@/ui/hooks/usePermissions'
import {
  useAppPromotion,
  useCancelRelease,
  useRetryRelease,
  useRollbackRelease,
} from '@/ui/hooks/useReleases'
import { useStartSession } from '@/ui/hooks/useSessions'
import { v } from '../components/promotionModel'
import { canCancelRelease, retryOutcomeMessage } from '../components/releaseModel'
import { startRefusal } from '../components/SessionsCard'
import { appPath, canRollBackTo } from './appPageModel'
import type { MenuItem } from './bits'
import { useAppPage } from './context'

type Size = 'btn-xs' | 'btn-sm'

/** The stage-aware Retry, or nothing when the release is not stuck or the reader cannot retry. */
export function RetryReleaseButton({
  release,
  size = 'btn-sm',
}: {
  release: Pick<Release, 'id' | 'failedStage'>
  size?: Size
}) {
  const { app } = useAppPage()
  const retry = useRetryRelease(app.id)
  const stage = release.failedStage
  if (!stage || !app.viewerCanDeploy) return null
  return (
    <button
      type="button"
      className={`btn ${size}`}
      disabled={retry.isPending}
      onClick={() =>
        retry.mutate(
          { releaseId: release.id, stage },
          { onSuccess: outcome => showToast(retryOutcomeMessage(outcome), 'success') }
        )
      }
    >
      {retry.isPending && <span className="loading loading-spinner loading-xs" />}
      {RELEASE_RETRY_LABELS[stage]}
    </button>
  )
}

/** Whether this reader may start a session on the app (the layout's "Change it" rule). */
function useCanStartSession(): boolean {
  const { app, hasRepo, stage } = useAppPage()
  const { can } = usePermissions()
  return hasRepo && can('create', 'Session') && !stage.holding && app.status !== 'archived'
}

/** Start a session seeded with the release's failure, then open it. */
function useFixInSession(release: Pick<Release, 'id'>) {
  const { app } = useAppPage()
  const start = useStartSession(app.id)
  const navigate = useNavigate()
  const run = () =>
    start.mutate(
      { fixRelease: { releaseId: release.id } },
      {
        onSuccess: ({ session }) => navigate(`${appPath(app.slug)}/sessions/${session.id}`),
        onError: err => {
          const refusal = startRefusal(err)
          showToast(refusal.message, refusal.tone === 'info' ? 'info' : 'error')
        },
      }
    )
  return { run, pending: start.isPending }
}

/** "Fix in a session", or nothing when the release is not stuck or the reader cannot start one. */
export function FixInSessionButton({
  release,
  size = 'btn-sm',
}: {
  release: Pick<Release, 'id' | 'failedStage'>
  size?: Size
}) {
  const canStart = useCanStartSession()
  const fix = useFixInSession(release)
  if (!release.failedStage || !canStart) return null
  return (
    <button
      type="button"
      className={`btn btn-ghost ${size}`}
      disabled={fix.pending}
      onClick={fix.run}
    >
      Fix in a session
    </button>
  )
}

/**
 * App page P3: "Roll back to here" for `release` — whether it is on offer (`canRollBackTo`: the
 * reader deploys, Live is not already being changed, and the server would accept it), the action
 * that opens the confirm, and the confirm itself (render `dialog` beside the trigger).
 */
export function useRollbackAction(release: Release | null): {
  eligible: boolean
  open: () => void
  dialog: React.ReactNode
} {
  const { app, hasRepo, stage } = useAppPage()
  const running = app.status !== 'requested' && app.status !== 'archived'
  const promotion = useAppPromotion(app.id, hasRepo && running && !stage.holding)
  const rollback = useRollbackRelease(app.id)
  const [confirming, setConfirming] = useState(false)
  const liveVersion = app.environments.find(env => env.name === 'production')?.lastDeployVersion
  const candidate = promotion.data?.candidate
  const busy =
    Boolean(promotion.data?.rollback) ||
    candidate?.status === 'awaiting_approval' ||
    candidate?.status === 'promoting'
  const eligible =
    !!release &&
    hasRepo &&
    app.status !== 'archived' &&
    canRollBackTo(release, { liveVersion, viewerCanDeploy: app.viewerCanDeploy, busy })
  if (!release || !eligible) return { eligible: false, open: () => undefined, dialog: null }
  const to = v(release.version)
  const dialog = (
    <ConfirmModal
      isOpen={confirming}
      title={`Roll Live back to ${to}?`}
      message={
        <div className="space-y-2">
          <p>
            Live runs {liveVersion ? v(liveVersion) : 'a later version'}. Once the app’s approvers
            agree, Launch runs the repository’s own deploy workflow at the{' '}
            <span className="font-mono text-xs">{release.tag}</span> tag and puts {to} back on Live.
          </p>
          <p>
            Migrations and secrets don’t revert: database changes made since {to} stay, and {to}{' '}
            runs with today’s config and secrets.
          </p>
        </div>
      }
      confirmText={`Roll back to ${to}`}
      confirmButtonClass="btn-warning"
      isLoading={rollback.isPending}
      onCancel={() => setConfirming(false)}
      onConfirm={() =>
        rollback.mutate(
          { releaseId: release.id },
          {
            onSuccess: outcome => {
              setConfirming(false)
              showToast(
                outcome.approvalStatus === 'approved'
                  ? `Rolling Live back to ${to}`
                  : `Rollback to ${to} requested — waiting for approval`,
                'success'
              )
            },
            onError: () => setConfirming(false),
          }
        )
      }
    />
  )
  return { eligible: true, open: () => setConfirming(true), dialog }
}

/** "Roll back to here" as a button (the release page), or nothing when it is not on offer. */
export function RollbackButton({ release, size = 'btn-sm' }: { release: Release; size?: Size }) {
  const action = useRollbackAction(release)
  if (!action.eligible) return null
  return (
    <>
      <button type="button" className={`btn btn-ghost ${size}`} onClick={action.open}>
        Roll back to here
      </button>
      {action.dialog}
    </>
  )
}

/**
 * The ⋯ menu entries for a release row — Retry, Fix in a session, Cancel release, Roll back to
 * here — plus the confirm dialogs Cancel and Roll back open (render `dialog` beside the menu).
 */
export function useReleaseMenu(release: Release | null): {
  items: MenuItem[]
  dialog: React.ReactNode
} {
  const { app } = useAppPage()
  const retry = useRetryRelease(app.id)
  const cancel = useCancelRelease(app.id)
  const canStart = useCanStartSession()
  const fix = useFixInSession({ id: release?.id ?? '' })
  const rollbackAction = useRollbackAction(release)
  const [confirming, setConfirming] = useState(false)
  if (!release) return { items: [], dialog: null }
  const stage = release.failedStage
  const items: MenuItem[] = [
    ...(stage && app.viewerCanDeploy
      ? [
          {
            label: RELEASE_RETRY_LABELS[stage],
            onSelect: () =>
              retry.mutate(
                { releaseId: release.id, stage },
                { onSuccess: outcome => showToast(retryOutcomeMessage(outcome), 'success') }
              ),
          },
        ]
      : []),
    ...(stage && canStart ? [{ label: 'Fix in a session', onSelect: fix.run }] : []),
    ...(app.viewerCanDeploy && canCancelRelease(release)
      ? [{ label: 'Cancel release…', onSelect: () => setConfirming(true) }]
      : []),
    ...(rollbackAction.eligible
      ? [{ label: 'Roll back to here…', onSelect: rollbackAction.open }]
      : []),
  ]
  const dialog = (
    <>
      {rollbackAction.dialog}
      <ConfirmModal
        isOpen={confirming}
        title={`Cancel v${release.version}?`}
        message={
          <p>
            Launch cancels the deploy run on GitHub and marks the release failed. Nothing that
            already went live is undone; Retry runs it again later.
          </p>
        }
        confirmText="Cancel the run"
        isLoading={cancel.isPending}
        onCancel={() => setConfirming(false)}
        onConfirm={() =>
          cancel.mutate(release.id, {
            onSuccess: () => {
              setConfirming(false)
              showToast(`Cancelled the deploy run of v${release.version}`, 'success')
            },
            onError: () => setConfirming(false),
          })
        }
      />
    </>
  )
  return { items, dialog }
}
