/**
 * The live preview pane (Launch P3, plan §1.6): the session's running app in an iframe, on its own
 * preview host, behind a grant.
 *
 * **Every load is a fresh grant.** `POST /:id/preview-grant` mints a 60-second `{sid, uid, host}`
 * grant; the iframe loads `…/__launch/grant?g=…`, which sets the host-only preview cookie and
 * redirects to `/`. A reload therefore asks for a new grant rather than re-navigating the frame —
 * that also sidesteps third-party-cookie rules, which may keep an embedded cookie from sticking.
 * "Open in new tab" does the same in a window opened SYNCHRONOUSLY on the click (so no popup
 * blocker eats it), then pointed at the grant once it arrives.
 *
 * **Edits arrive by HMR, not by reloading.** Vite's HMR socket reaches the frame through the
 * preview gateway, so a turn's changes show as they are saved; the frame reloads by itself only
 * when the dev server comes (back) up — `changeSeq`, the newest `preview.ready`
 * (`latestPreviewChangeSeq`), moving past the one it was loaded at, when its HMR socket points at a
 * server that is gone — with a brief "Updated" mark. The Reload button forces a fresh load.
 *
 * With no sandbox there is nothing to frame, and the pane says why in one line with the one thing
 * to do: booting shows `BootProgress`, asleep offers Resume, shipped points at the PR.
 */
import {
  ArrowPathIcon,
  ArrowTopRightOnSquareIcon,
  CheckCircleIcon,
  ExclamationTriangleIcon,
  GlobeAltIcon,
  MoonIcon,
  NoSymbolIcon,
} from '@heroicons/react/24/outline'
import type { Session } from '@launch/shared/launch-sessions'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { EmptyState } from '@/ui/components/shared'
import { sessionHasSandbox, usePreviewGrant } from '@/ui/hooks/useSessions'
import type { BootStep } from '../sessionChatModel'
import { BootProgress } from './BootProgress'

/** How long the "Updated" mark stays after an automatic reload. */
const UPDATED_MARK_MS = 2500

/** The preview's host, for the address pill. Pure. */
export function previewHostOf(url: string | null): string | null {
  if (!url) return null
  try {
    return new URL(url, 'http://localhost').host
  } catch {
    return null
  }
}

function PaneState({
  icon,
  message,
  description,
  action,
}: {
  icon: React.ComponentType<{ className?: string }>
  message: string
  description?: string
  action?: React.ReactNode
}) {
  return (
    <div className="flex h-full items-center justify-center p-6" data-testid="preview-state">
      <EmptyState icon={icon} message={message} description={description} action={action} />
    </div>
  )
}

/** A failed session's reason, first line only — the rest is the command's output (below). */
function failedHeadline(error: string | null): string {
  return error?.split('\n')[0]?.trim() || 'The sandbox stopped unexpectedly.'
}

/**
 * Under a failed session: the whole reason when it carries a command's output (the last ~40 lines
 * a boot step captured), and the way on — a session cannot be retried in place; its app starts a
 * new one from the prepared database in about a minute.
 */
function FailedDetails({ error, appSlug }: { error: string | null; appSlug?: string }) {
  const rest = error?.split('\n').slice(1).join('\n').trim()
  return (
    <div className="flex w-full max-w-xl flex-col items-center gap-3">
      {rest && (
        <details className="w-full text-left">
          <summary className="cursor-pointer text-xs text-muted">What it printed</summary>
          <pre
            className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-base-200 p-2 font-mono text-xs"
            data-testid="session-error-output"
          >
            {rest}
          </pre>
        </details>
      )}
      {appSlug && (
        <Link to={`/apps/${appSlug}`} className="btn btn-sm">
          Start a new session
        </Link>
      )}
    </div>
  )
}

export function PreviewFrame({
  session,
  changeSeq,
  steps,
  canManage,
  onResume,
  resuming,
  appSlug,
}: {
  session: Session
  /** Where a failed session sends the person to start a new one. */
  appSlug?: string
  /** Undefined until the transcript has loaded, so the first load is not followed by a reload. */
  changeSeq: number | undefined
  steps: readonly BootStep[]
  canManage: boolean
  onResume: () => void
  resuming: boolean
}) {
  const grant = usePreviewGrant(session.id)
  const tabGrant = usePreviewGrant(session.id)
  const [src, setSrc] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const [frameLoaded, setFrameLoaded] = useState(false)
  const [updated, setUpdated] = useState(false)
  const loadedSeq = useRef<number | null>(null)
  const alive = sessionHasSandbox(session.status)
  const mint = grant.mutate

  const load = useCallback(
    (reason: 'initial' | 'change' | 'manual', seq: number) => {
      loadedSeq.current = seq
      mint(undefined, {
        onSuccess: next => {
          setSrc(next.url)
          setNonce(n => n + 1)
          setFrameLoaded(false)
          if (reason === 'change') setUpdated(true)
        },
      })
    },
    [mint]
  )

  useEffect(() => {
    if (!alive || changeSeq === undefined) return
    if (loadedSeq.current === null) load('initial', changeSeq)
    else if (changeSeq > loadedSeq.current) load('change', changeSeq)
  }, [alive, changeSeq, load])

  // The sandbox went away: forget the frame, so coming back (a resume) loads afresh.
  useEffect(() => {
    if (!alive) {
      loadedSeq.current = null
      setSrc(null)
    }
  }, [alive])

  useEffect(() => {
    if (!updated) return
    const timer = setTimeout(() => setUpdated(false), UPDATED_MARK_MS)
    return () => clearTimeout(timer)
  }, [updated])

  const openInTab = () => {
    const tab = window.open('', '_blank')
    tabGrant.mutate(undefined, {
      onSuccess: next => {
        if (!tab) return
        tab.opener = null
        tab.location.href = next.url
      },
      onError: () => tab?.close(),
    })
  }

  const host = previewHostOf(src)
  const toolbar = (
    <div className="flex items-center gap-2 border-b border-[color:var(--border-subtle)] px-3 py-2">
      <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md surface-inset px-2.5 py-1 text-xs text-secondary">
        <GlobeAltIcon className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate font-mono" title={host ?? undefined}>
          {host ?? 'Preview'}
        </span>
        {updated && (
          <span
            className="ml-auto inline-flex shrink-0 items-center gap-1 text-success"
            role="status"
          >
            <CheckCircleIcon className="h-3.5 w-3.5" />
            Updated
          </span>
        )}
      </div>
      <button
        type="button"
        className="btn btn-ghost btn-sm btn-square"
        onClick={() => load('manual', changeSeq ?? 0)}
        disabled={!alive || grant.isPending}
        aria-label="Reload preview"
        title="Reload preview"
      >
        <ArrowPathIcon className={`h-4 w-4 ${grant.isPending ? 'animate-spin' : ''}`} />
      </button>
      <button
        type="button"
        className="btn btn-ghost btn-sm btn-square"
        onClick={openInTab}
        disabled={!alive}
        aria-label="Open preview in a new tab"
        title="Open in a new tab"
      >
        <ArrowTopRightOnSquareIcon className="h-4 w-4" />
      </button>
    </div>
  )

  let body: React.ReactNode
  if (session.status === 'requested' || session.status === 'booting') {
    body = (
      <BootProgress
        steps={steps}
        since={session.suspendedAt ?? session.createdAt}
        resuming={session.suspendedAt !== null}
      />
    )
  } else if (session.status === 'suspended') {
    body = (
      <PaneState
        icon={MoonIcon}
        message="This session is asleep"
        description="It went to sleep after a quiet spell. Its branch, database and chat are kept — resuming takes about half a minute."
        action={
          canManage ? (
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={onResume}
              disabled={resuming || session.requestedAction === 'resume'}
            >
              {resuming || session.requestedAction === 'resume' ? 'Waking…' : 'Resume session'}
            </button>
          ) : undefined
        }
      />
    )
  } else if (session.status === 'shipped') {
    body = (
      <PaneState
        icon={CheckCircleIcon}
        message="Shipped"
        description="The sandbox is gone; the changes are in the pull request."
        action={
          session.prUrl ? (
            <a
              href={session.prUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-sm gap-1.5"
            >
              Open pull request
              <ArrowTopRightOnSquareIcon className="h-4 w-4" />
            </a>
          ) : undefined
        }
      />
    )
  } else if (session.status === 'failed') {
    body = (
      <PaneState
        icon={ExclamationTriangleIcon}
        message="This session failed"
        description={failedHeadline(session.error)}
        action={<FailedDetails error={session.error} appSlug={appSlug} />}
      />
    )
  } else if (session.status === 'ending' || session.status === 'ended') {
    body = (
      <PaneState
        icon={NoSymbolIcon}
        message={session.status === 'ending' ? 'Ending the session…' : 'This session has ended'}
        description={
          session.branch
            ? `The sandbox is gone. Every change so far is on the branch ${session.branch}.`
            : 'The sandbox is gone.'
        }
      />
    )
  } else if (grant.isError && !src) {
    body = (
      <PaneState
        icon={ExclamationTriangleIcon}
        message="The preview could not be opened"
        description={grant.error.message}
        action={
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => load('manual', changeSeq ?? 0)}
          >
            Try again
          </button>
        }
      />
    )
  } else {
    body = (
      <div className="flex h-full flex-col">
        {session.status === 'working' && (
          <div
            className="flex shrink-0 items-center justify-center gap-2 border-b border-[color:var(--border-subtle)] px-3 py-1.5 text-xs text-secondary"
            role="status"
          >
            <span className="loading loading-dots loading-xs" />
            The agent is editing — changes appear as they are saved. Reload if it looks stale.
          </div>
        )}
        <div className="relative min-h-0 flex-1">
          {src ? (
            <iframe
              key={nonce}
              src={src}
              title="App preview"
              className="h-full w-full border-0 bg-base-100"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
              allow="clipboard-read; clipboard-write"
              onLoad={() => setFrameLoaded(true)}
            />
          ) : null}
          {(!src || !frameLoaded) && (
            <div className="absolute inset-0 flex items-center justify-center bg-base-100">
              <span className="flex items-center gap-2 text-sm text-muted">
                <span className="loading loading-spinner loading-sm" />
                Loading the preview…
              </span>
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <section
      className="surface-panel flex h-full min-h-0 flex-col overflow-hidden p-0"
      aria-label="Preview"
    >
      {toolbar}
      <div className="min-h-0 flex-1">{body}</div>
    </section>
  )
}
