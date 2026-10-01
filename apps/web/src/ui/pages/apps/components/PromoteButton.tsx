/**
 * "Promote to production" for a release staging is running (plan §1.8). Promoting does not deploy:
 * it opens a `deploy.production` approval, and the page then goes to that request — the approver
 * is somebody else (the promoter is excluded from deciding), so the natural next step is to see
 * who it is waiting on and share the link.
 *
 * A 409 (staging no longer runs this release, or is not up) is information, shown in the dialog in
 * place of a toast: the release list behind it refreshes, and the reader can see why.
 *
 * `PromoteDialog` is the confirmation itself, shared with the app page's pipeline strip
 * (`PipelineStrip`), which stays on the page after promoting and shows who the request waits on.
 */
import { RocketLaunchIcon } from '@heroicons/react/24/outline'
import { approvalPath } from '@launch/shared/launch-approvals'
import { promoteReleaseSchema, type Release } from '@launch/shared/launch-releases'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { FieldError, Modal, showToast } from '@/ui/components/shared'
import { usePromoteRelease } from '@/ui/hooks/useReleases'
import { ApiError } from '@/ui/lib/api-client'

export function PromoteDialog({
  appId,
  release,
  open,
  onClose,
  onPromoted,
}: {
  appId: string
  release: Pick<Release, 'id' | 'version'>
  open: boolean
  onClose: () => void
  /** After the request opened (the dialog has closed itself). */
  onPromoted: (approvalId: string) => void
}) {
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const promote = usePromoteRelease(appId)
  const conflict = promote.error instanceof ApiError && promote.error.status === 409

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
          showToast(`Production approval requested for ${release.version}`, 'success')
          onClose()
          onPromoted(approvalId)
        },
      }
    )
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title={`Promote ${release.version} to production?`}
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
              'Ask for approval'
            )}
          </button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <p>
          This asks the app’s approvers to release <strong>{release.version}</strong> to production.
          Nothing is deployed until someone other than you approves it; then Launch publishes the
          GitHub release and the deploy runs.
        </p>
        {conflict ? (
          <div className="alert alert-info alert-soft text-sm" role="status">
            <span>{promote.error?.message}</span>
          </div>
        ) : promote.error ? (
          <div className="alert alert-error alert-soft text-sm" role="alert">
            <span>{promote.error.message}</span>
          </div>
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

export function PromoteButton({ appId, release }: { appId: string; release: Release }) {
  const [open, setOpen] = useState(false)
  const navigate = useNavigate()

  return (
    <>
      <button type="button" className="btn btn-xs btn-primary gap-1" onClick={() => setOpen(true)}>
        <RocketLaunchIcon className="w-3.5 h-3.5" />
        Promote
      </button>
      {open && (
        <PromoteDialog
          appId={appId}
          release={release}
          open={open}
          onClose={() => setOpen(false)}
          onPromoted={approvalId => navigate(approvalPath(approvalId))}
        />
      )}
    </>
  )
}
