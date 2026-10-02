/**
 * Ship a release that staging is running to Live (plan §1.8, app page decision 6). Shipping does
 * not deploy: it opens a `deploy.production` approval — the approver is somebody else (the shipper
 * is excluded from deciding) — so the button reads "Request approval".
 *
 * `ShipDialog` is the one confirmation: the version and the changes it carries (when the caller
 * has them), and an optional reason for the approvers. The Overview's Ship stays on the page —
 * its Live row then shows who the request waits on — and a Releases row's `ShipButton` goes to the
 * request it opened.
 *
 * A 409 (staging no longer runs this release, or is not up) is information, shown in the dialog in
 * place of a toast: the release list behind it refreshes, and the reader can see why.
 */
import { approvalPath } from '@launch/shared/launch-approvals'
import type { PromotionChange } from '@launch/shared/launch-promotion'
import { promoteReleaseSchema, type Release } from '@launch/shared/launch-releases'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { FieldError, Modal, showToast } from '@/ui/components/shared'
import { usePromoteRelease } from '@/ui/hooks/useReleases'
import { ApiError } from '@/ui/lib/api-client'
import { summaryLine, v } from './promotionModel'

/** At most this many changes are listed in the dialog; the rest are counted. */
const DIALOG_CHANGES = 8

export function ShipDialog({
  appId,
  release,
  changes,
  open,
  onClose,
  onShipped,
}: {
  appId: string
  release: Pick<Release, 'id' | 'version'>
  /** What it carries that Live does not, when known (`GET /:id/promotion`). */
  changes?: readonly PromotionChange[]
  open: boolean
  onClose: () => void
  /** After the request opened (the dialog has closed itself). */
  onShipped: (approvalId: string) => void
}) {
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const promote = usePromoteRelease(appId)
  const conflict = promote.error instanceof ApiError && promote.error.status === 409
  const version = v(release.version)

  const close = () => {
    onClose()
    promote.reset()
  }

  const submit = () => {
    const parsed = promoteReleaseSchema.safeParse(reason.trim() ? { reason } : {})
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Check the reason')
      return
    }
    promote.mutate(
      { releaseId: release.id, ...parsed.data },
      {
        onSuccess: ({ approvalId }) => {
          showToast(`Approval requested to ship ${version} live`, 'success')
          onClose()
          onShipped(approvalId)
        },
      }
    )
  }

  const listed = changes?.slice(0, DIALOG_CHANGES) ?? []
  const more = (changes?.length ?? 0) - listed.length

  return (
    <Modal
      open={open}
      onClose={close}
      title={`Ship ${version} live?`}
      actions={
        <>
          <button type="button" className="btn btn-sm" onClick={close}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={submit}
            disabled={promote.isPending || conflict}
          >
            {promote.isPending ? (
              <span className="loading loading-spinner loading-xs" />
            ) : (
              'Request approval'
            )}
          </button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <p>
          This asks the app’s approvers to put <span className="font-mono">{version}</span> live.
          Nothing changes until someone other than you approves it; then Launch publishes the GitHub
          release and the deploy runs.
        </p>
        {listed.length > 0 && (
          <ul className="space-y-1" aria-label="What it ships">
            {listed.map(change => (
              <li key={`${change.version}-${change.number}`}>
                {change.sessionTitle?.trim() || change.title}
                <span className="text-xs text-muted"> #{change.number}</span>
                {summaryLine(change.summary) && (
                  <span className="block text-xs text-secondary">
                    {summaryLine(change.summary)}
                  </span>
                )}
              </li>
            ))}
            {more > 0 && <li className="text-xs text-muted">and {more} more</li>}
          </ul>
        )}
        {conflict ? (
          <p className="text-sm text-secondary" role="status">
            {promote.error?.message}
          </p>
        ) : promote.error ? (
          <p className="text-sm text-error" role="alert">
            {promote.error.message}
          </p>
        ) : null}
        <label className="block">
          <span className="text-xs text-muted">Why now? (optional, shown to the approvers)</span>
          <textarea
            className="textarea w-full text-sm mt-1"
            rows={2}
            maxLength={1000}
            value={reason}
            aria-invalid={Boolean(error)}
            aria-describedby="promote-reason-error"
            onChange={event => {
              setReason(event.target.value)
              setError(null)
            }}
          />
        </label>
        <FieldError id="promote-reason-error" message={error} />
      </div>
    </Modal>
  )
}

/** A Releases row's Ship: the same dialog, then the request it opened. */
export function ShipButton({ appId, release }: { appId: string; release: Release }) {
  const [open, setOpen] = useState(false)
  const navigate = useNavigate()

  return (
    <>
      <button type="button" className="btn btn-xs" onClick={() => setOpen(true)}>
        Ship {v(release.version)}
      </button>
      {open && (
        <ShipDialog
          appId={appId}
          release={release}
          open={open}
          onClose={() => setOpen(false)}
          onShipped={approvalId => navigate(approvalPath(approvalId))}
        />
      )}
    </>
  )
}
