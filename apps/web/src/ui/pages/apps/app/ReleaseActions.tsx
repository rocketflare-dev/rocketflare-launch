/**
 * What a person can do about a release that is stuck or in flight (app page P2, plan decision 7):
 *
 * - **Retry** — ONE button for whichever stage failed (`release.failedStage`, stamped by the
 *   server), labelled with what it does (`RELEASE_RETRY_LABELS`: "Retry staging deploy", "Check
 *   staging again", "Request approval again"…). The stage the reader saw travels with the request,
 *   so a release that moved on meanwhile is refused rather than retried differently;
 * - **Fix in a session** — starts a coding session seeded with the failure (stage, GitHub run, the
 *   failed job's log tail) and opens it;
 * - **Cancel release** — stops the deploy run in flight on GitHub, after a confirm.
 *
 * Retry and Cancel are for the app's owners and admins (`viewerCanDeploy`, the server's rule); Fix
 * in a session for whoever may start a session. Each is hidden from a reader who cannot use it.
 */
import { RELEASE_RETRY_LABELS, type Release } from '@launch/shared/launch-releases'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ConfirmModal, showToast } from '@/ui/components/shared'
import { usePermissions } from '@/ui/hooks/usePermissions'
import { useCancelRelease, useRetryRelease } from '@/ui/hooks/useReleases'
import { useStartSession } from '@/ui/hooks/useSessions'
import { canCancelRelease, retryOutcomeMessage } from '../components/releaseModel'
import { startRefusal } from '../components/SessionsCard'
import { appPath } from './appPageModel'
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
 * The ⋯ menu entries for a release row — Retry, Fix in a session, Cancel release — plus the
 * confirm dialog Cancel opens (render `dialog` beside the menu).
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
  ]
  const dialog = (
    <ConfirmModal
      isOpen={confirming}
      title={`Cancel v${release.version}?`}
      message={
        <p>
          Launch cancels the deploy run on GitHub and marks the release failed. Nothing that already
          went live is undone; Retry runs it again later.
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
  )
  return { items, dialog }
}
