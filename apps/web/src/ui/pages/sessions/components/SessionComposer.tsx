/**
 * What a person types to the coding agent (Launch P3). Keyboard first: **Enter sends, Shift+Enter
 * is a new line** (⌘/Ctrl+Enter sends too, for people whose fingers expect it), the box grows with
 * its text up to a cap, and focus stays in it after a send so the next thought can start at once.
 *
 * While a turn is queued or running the Send button becomes **Stop** (`POST /:id/cancel`); once a
 * stop is requested it reads "Stopping…" and waits for the turn to end — the Workflow polls for
 * it every couple of seconds.
 *
 * When the session cannot take a message the composer says WHY in one sentence instead of sitting
 * there disabled (asleep → resume; over budget → the banner above; ended → there is nothing to
 * send to). A refused send keeps the text: a 409 `turn_in_progress` (another tab got there first)
 * is information, not an error. While a ship lands (issue #5) the sentence names the stage — CI,
 * review, merging, on its way to staging, live; a reopened ship takes messages again (the ship
 * panel's "Ask Claude to fix it" posts through the same `POST /turns`).
 */
import { PaperAirplaneIcon, StopIcon } from '@heroicons/react/24/solid'
import { SESSION_MESSAGE_MAX, type Session } from '@launch/shared/launch-sessions'
import { forwardRef, type KeyboardEvent, useImperativeHandle, useLayoutEffect, useRef } from 'react'
import { turnInProgress } from '@/ui/hooks/useSessions'

export interface SessionComposerHandle {
  focus: () => void
}

interface SessionComposerProps {
  session: Session
  value: string
  onChange: (value: string) => void
  onSend: (text: string) => void
  onCancel: () => void
  sending: boolean
  cancelling: boolean
  /** A refused send, rendered under the box. */
  error: { tone: 'info' | 'error'; message: string } | null
}

/** Why the session cannot take a message right now, or null when it can. Pure. */
export function composerBlockedReason(
  session: Pick<Session, 'status' | 'viewerCanManage'> & { landing?: Session['landing'] }
) {
  const stage = session.landing?.stage
  switch (session.status) {
    case 'suspended':
      return 'This session is asleep. Resume it to keep going.'
    case 'blocked':
      return 'This session has used its budget.'
    case 'shipping':
      // Issue #5: `shipping` spans the gate AND what follows the PR, up to the merge.
      if (stage === 'ci') return 'Shipping — waiting for CI on the pull request.'
      if (stage === 'approval') return 'Shipping — waiting for a review before merging.'
      if (stage === 'merging') return 'Shipping — merging the pull request.'
      return 'Shipping — checking the code and opening a pull request.'
    case 'shipped':
      if (stage === 'releasing' || stage === 'deploying')
        return 'This session was shipped and is on its way to staging. Start a new one to keep changing the app.'
      if (stage === 'live')
        return 'This session was shipped and is live on staging. Start a new one to keep changing the app.'
      return 'This session was shipped. Start a new one to keep changing the app.'
    case 'ending':
    case 'ended':
      return 'This session has ended.'
    case 'failed':
      return 'This session failed and cannot take more messages.'
    default:
      return null
  }
}

const MAX_HEIGHT_PX = 240

export const SessionComposer = forwardRef<SessionComposerHandle, SessionComposerProps>(
  function SessionComposer(
    { session, value, onChange, onSend, onCancel, sending, cancelling, error },
    ref
  ) {
    const textarea = useRef<HTMLTextAreaElement>(null)
    useImperativeHandle(ref, () => ({ focus: () => textarea.current?.focus() }), [])

    // Grow with the text, up to a cap, then scroll.
    // biome-ignore lint/correctness/useExhaustiveDependencies: `value` is the trigger, read via the ref
    useLayoutEffect(() => {
      const node = textarea.current
      if (!node) return
      node.style.height = 'auto'
      node.style.height = `${Math.min(node.scrollHeight, MAX_HEIGHT_PX)}px`
    }, [value])

    const blocked = composerBlockedReason(session)
    const busy = turnInProgress(session)
    const stopping = session.cancelRequested || cancelling
    const trimmed = value.trim()
    const tooLong = trimmed.length > SESSION_MESSAGE_MAX
    const canSend = !blocked && !busy && !sending && trimmed.length > 0 && !tooLong

    const submit = () => {
      if (canSend) onSend(trimmed)
    }

    const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
      if (event.shiftKey && !(event.metaKey || event.ctrlKey)) return
      event.preventDefault()
      submit()
    }

    if (blocked) {
      return (
        <div className="border-t border-[color:var(--border-subtle)] px-4 py-3">
          <p className="text-sm text-secondary" data-testid="composer-blocked">
            {blocked}
          </p>
        </div>
      )
    }

    const nearLimit = trimmed.length > SESSION_MESSAGE_MAX * 0.9
    return (
      <form
        className="border-t border-[color:var(--border-subtle)] p-3"
        onSubmit={event => {
          event.preventDefault()
          submit()
        }}
      >
        <div className="flex items-end gap-2 rounded-xl border border-[color:var(--border-default)] bg-base-100 px-3 py-2 focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/20">
          <label htmlFor="session-composer" className="sr-only">
            Message the coding agent
          </label>
          <textarea
            id="session-composer"
            ref={textarea}
            rows={1}
            className="flex-1 resize-none bg-transparent text-sm leading-6 outline-none placeholder:text-muted"
            placeholder={
              busy ? 'Claude is working — you can write the next message' : 'Describe a change…'
            }
            value={value}
            onChange={event => onChange(event.target.value)}
            onKeyDown={onKeyDown}
            aria-describedby="session-composer-hint"
          />
          {busy ? (
            <button
              type="button"
              className="btn btn-sm btn-square btn-ghost"
              onClick={onCancel}
              disabled={stopping}
              aria-label={stopping ? 'Stopping' : 'Stop this turn'}
              title={stopping ? 'Stopping…' : 'Stop this turn'}
            >
              {stopping ? (
                <span className="loading loading-spinner loading-xs" />
              ) : (
                <StopIcon className="w-4 h-4" />
              )}
            </button>
          ) : (
            <button
              type="submit"
              className="btn btn-sm btn-square btn-primary"
              disabled={!canSend}
              aria-label="Send"
              title="Send (Enter)"
            >
              {sending ? (
                <span className="loading loading-spinner loading-xs" />
              ) : (
                <PaperAirplaneIcon className="w-4 h-4" />
              )}
            </button>
          )}
        </div>
        <div
          id="session-composer-hint"
          className="mt-1.5 flex items-center justify-between gap-2 px-1 text-xs text-muted"
        >
          <span>
            {stopping ? (
              'Stopping after the current step…'
            ) : busy ? (
              'Working… press Stop to interrupt.'
            ) : (
              <>
                <kbd className="kbd kbd-xs">Enter</kbd> to send ·{' '}
                <kbd className="kbd kbd-xs">Shift</kbd>+<kbd className="kbd kbd-xs">Enter</kbd> for
                a new line
              </>
            )}
          </span>
          {nearLimit && (
            <span className={`tabular-nums ${tooLong ? 'text-error' : ''}`}>
              {trimmed.length.toLocaleString()} / {SESSION_MESSAGE_MAX.toLocaleString()}
            </span>
          )}
        </div>
        {error && (
          <p
            role={error.tone === 'error' ? 'alert' : 'status'}
            className={`mt-2 px-1 text-xs ${error.tone === 'error' ? 'text-error' : 'text-info'}`}
          >
            {error.message}
          </p>
        )}
      </form>
    )
  }
)
