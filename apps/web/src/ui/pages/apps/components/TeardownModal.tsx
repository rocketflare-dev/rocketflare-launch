/**
 * Archive an app (Launch P2 teardown): everything the launch created is deleted in reverse — routes,
 * Workers, queues, buckets (emptied first), KV, email keys, the Neon project with ALL its data —
 * sign-in is disabled, and the repository is archived, or deleted when that box is ticked.
 *
 * Typing the slug is the confirmation (the server checks it too: a mismatch is a 400). Once started
 * the modal turns into the teardown's progress, from the same pipeline view the page polls, so
 * closing it loses nothing.
 */
import { ExclamationTriangleIcon, TrashIcon } from '@heroicons/react/24/outline'
import type { AppDetail } from '@launch/shared/launch-apps'
import type { PipelineView } from '@launch/shared/launch-pipeline'
import { useState } from 'react'
import { Modal } from '@/ui/components/shared'
import { useTeardownApp } from '@/ui/hooks/usePipeline'
import { PipelineProgress } from './PipelineProgress'

const DELETED = [
  'The staging and production Workers and their routes',
  'The database — every row, on both branches',
  'File buckets, queues and KV namespaces',
  'The email sending keys',
]

export function TeardownModal({
  app,
  open,
  onClose,
  onStarted,
  view,
  onRetry,
  retrying,
}: {
  app: Pick<AppDetail, 'id' | 'slug' | 'displayName' | 'repoOwner' | 'repoName'>
  open: boolean
  onClose: () => void
  /** The page starts watching the teardown (and polling) from here. */
  onStarted: (runId: string) => void
  /** The latest teardown run, as the page's query holds it. */
  view: PipelineView | undefined
  onRetry?: () => void
  retrying?: boolean
}) {
  const teardown = useTeardownApp(app.id)
  const [confirm, setConfirm] = useState('')
  const [deleteRepo, setDeleteRepo] = useState(false)
  const [runId, setRunId] = useState<string | null>(null)
  const repo = app.repoOwner && app.repoName ? `${app.repoOwner}/${app.repoName}` : null
  const matches = confirm.trim() === app.slug

  const close = () => {
    setConfirm('')
    setDeleteRepo(false)
    setRunId(null)
    teardown.reset()
    onClose()
  }

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!matches) return
    teardown.mutate(
      { confirmSlug: confirm.trim(), deleteRepo },
      {
        onSuccess: result => {
          setRunId(result.runId)
          onStarted(result.runId)
        },
      }
    )
  }

  if (runId) {
    // The page's query may still hold an older run for a moment: show ours once it is there.
    const ours = view && view.runId === runId ? view : null
    return (
      <Modal
        open={open}
        onClose={close}
        title={`Archiving ${app.displayName}`}
        className="max-w-lg"
        actions={
          <button type="button" className="btn btn-sm" onClick={close}>
            {ours?.status === 'succeeded' ? 'Done' : 'Close'}
          </button>
        }
      >
        {ours ? (
          <PipelineProgress
            view={ours}
            compact
            canRetry={Boolean(onRetry)}
            onRetry={onRetry}
            retrying={retrying}
          />
        ) : (
          <p className="flex items-center gap-2">
            <span className="loading loading-spinner loading-sm text-primary" />
            Starting the teardown…
          </p>
        )}
        <p className="mt-4 text-xs text-muted">
          You can close this: the teardown carries on, and the app’s page shows where it is.
        </p>
      </Modal>
    )
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title={`Archive ${app.displayName}`}
      className="max-w-lg"
      actions={
        <>
          <button
            type="button"
            className="btn btn-sm"
            onClick={close}
            disabled={teardown.isPending}
          >
            Cancel
          </button>
          <button
            type="submit"
            form="teardown-form"
            className="btn btn-sm btn-error gap-1.5"
            disabled={!matches || teardown.isPending}
          >
            {teardown.isPending ? (
              <span className="loading loading-spinner loading-xs" />
            ) : (
              <TrashIcon className="w-4 h-4" />
            )}
            Archive app
          </button>
        </>
      }
    >
      <p>This deletes what Launch created for the app, and cannot be undone:</p>
      <ul className="list-disc ml-5 mt-2 space-y-0.5">
        {DELETED.map(item => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <p className="mt-2">
        Its sign-in client is disabled, and the app stays in the catalogue as archived, with its
        history.
      </p>

      {teardown.error && (
        <div className="alert alert-error alert-soft text-sm mt-4" role="alert">
          <span>{teardown.error.message}</span>
        </div>
      )}

      <form id="teardown-form" onSubmit={submit} className="space-y-4 mt-4" noValidate>
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            className="checkbox checkbox-error checkbox-sm mt-0.5"
            checked={deleteRepo}
            onChange={e => setDeleteRepo(e.target.checked)}
          />
          <span>
            <span className="block text-sm font-medium text-base-content">
              Also delete the GitHub repository
            </span>
            <span className="block text-xs text-muted mt-0.5">
              Unticked, {repo ? <span className="font-mono">{repo}</span> : 'the repository'} is
              archived: read-only, with its code and history kept.
            </span>
          </span>
        </label>
        {deleteRepo && (
          <div className="alert alert-warning alert-soft text-sm items-start" role="alert">
            <ExclamationTriangleIcon className="w-5 h-5 shrink-0" />
            <span>
              The repository, its code, issues and history are deleted for good. GitHub cannot
              restore it.
            </span>
          </div>
        )}

        <div>
          <label htmlFor="teardown-confirm" className="label text-sm">
            <span>
              Type <span className="font-mono font-semibold text-base-content">{app.slug}</span> to
              confirm
            </span>
          </label>
          <input
            id="teardown-confirm"
            className="input w-full font-mono text-sm"
            autoComplete="off"
            spellCheck={false}
            value={confirm}
            onChange={e => setConfirm(e.target.value)}
          />
        </div>
      </form>
    </Modal>
  )
}
