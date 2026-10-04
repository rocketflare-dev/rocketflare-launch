/**
 * What a person types to the coding agent (Launch P3). Keyboard first: **Enter sends, Shift+Enter
 * is a new line** (⌘/Ctrl+Enter sends too, for people whose fingers expect it), the box grows with
 * its text up to a cap, and focus stays in it after a send so the next thought can start at once.
 *
 * While a turn RUNS the box stays open: **Enter (or Queue) queues** the message — it runs when the
 * turn ends — and **Send now** stops the turn and sends it (`mode: 'interrupt'`, one write on the
 * server); **Stop** stays beside them (`POST /:id/cancel`), and once a stop is requested it reads
 * "Stopping…" and waits for the turn to end — the Workflow polls for it every couple of seconds.
 * One message waits at most: while one does, the send controls are off with a one-line hint (the
 * waiting bubble above has Withdraw).
 *
 * When the session cannot take a message the composer says WHY in one sentence instead of sitting
 * there disabled (asleep → resume; over budget → the banner above; ended → there is nothing to
 * send to). A refused send keeps the text: a 409 `turn_in_progress` (another tab got there first)
 * is information, not an error. While a ship lands (issue #5) the sentence names the stage — CI,
 * review, merging, on its way to staging, live; a reopened ship takes messages again (the ship
 * panel's "Ask Claude to fix it" posts through the same `POST /turns`).
 *
 * **Images**: paste one into the box, drop one on the composer, or pick with the paperclip. Each
 * shows as a chip above the text — a spinner while it shrinks and uploads, × to take it out — and
 * goes with the next message by id. The chips are `SessionPage`'s (`useComposerAttachments`), so
 * the preview's screenshot button can add one too. Send waits while one is uploading, and while a
 * failed one is still there; a message may be images alone.
 *
 * The footer's model picker chooses the model for the NEXT message — the runtime's offered list
 * (`AGENT_RUNTIME_MODELS`, named by `agentModelLabel`: "Opus 5.5"), seeded from the session's
 * current one. A different pick travels with the message (`model`) and becomes the session's model
 * when that turn starts.
 */
import { PaperClipIcon, PhotoIcon, XMarkIcon } from '@heroicons/react/24/outline'
import { PaperAirplaneIcon, StopIcon } from '@heroicons/react/24/solid'
import { AGENT_RUNTIME_MODELS, agentModelLabel } from '@launch/shared/launch-agents'
import {
  SESSION_ATTACHMENT_MIME_TYPES,
  SESSION_MESSAGE_MAX,
  type Session,
} from '@launch/shared/launch-sessions'
import {
  type ClipboardEvent,
  type DragEvent,
  forwardRef,
  type KeyboardEvent,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { composerSendMode, turnInProgress } from '@/ui/hooks/useSessions'
import type { ComposerAttachment, ComposerAttachments } from '../useComposerAttachments'

export interface SessionComposerHandle {
  focus: () => void
}

interface SessionComposerProps {
  session: Session
  value: string
  onChange: (value: string) => void
  /** `queue` behind a running turn (or simply send); `interrupt` stops the running turn first. */
  onSend: (text: string, mode: 'queue' | 'interrupt') => void
  onCancel: () => void
  /** The model the next message runs on, and a new pick. */
  model: string
  onModelChange: (model: string) => void
  sending: boolean
  cancelling: boolean
  /** A refused send, rendered under the box. */
  error: { tone: 'info' | 'error'; message: string } | null
  /** The next message's images (the page's: the preview adds screenshots to them). */
  attachments: ComposerAttachments
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

/** What the transcript calls the agent running a session's turns. */
export function agentName(runtime: Session['runtime']): string {
  return runtime === 'codex' ? 'Codex' : 'Claude'
}

const ACCEPT = SESSION_ATTACHMENT_MIME_TYPES.join(',')

/** The image files in a paste or a drop. Pure. */
export function imageFilesOf(list: FileList | readonly File[] | null | undefined): File[] {
  return Array.from(list ?? []).filter(file => file.type.startsWith('image/'))
}

function AttachmentChip({ item, onRemove }: { item: ComposerAttachment; onRemove: () => void }) {
  const failed = item.status === 'error'
  return (
    <li
      className={`relative h-14 w-14 shrink-0 overflow-hidden rounded-lg border bg-base-200 ${
        failed ? 'border-error' : 'border-[color:var(--border-subtle)]'
      }`}
      title={failed ? (item.error ?? 'This image could not be attached') : item.label}
      data-testid="composer-attachment"
      data-status={item.status}
    >
      {item.previewUrl ? (
        <img src={item.previewUrl} alt={item.label} className="h-full w-full object-cover" />
      ) : (
        <span className="flex h-full w-full items-center justify-center text-muted">
          <PhotoIcon className="h-5 w-5" />
        </span>
      )}
      {item.status === 'uploading' && (
        <span className="absolute inset-0 flex items-center justify-center bg-base-100/70">
          <span
            className="loading loading-spinner loading-xs"
            role="status"
            aria-label="Uploading"
          />
        </span>
      )}
      {failed && (
        <span className="absolute inset-x-0 bottom-0 bg-error px-1 text-center text-[10px] leading-4 text-error-content">
          Failed
        </span>
      )}
      <button
        type="button"
        className="btn btn-circle btn-xs absolute right-0.5 top-0.5 h-5 min-h-0 w-5 border-0 bg-base-100/90"
        onClick={onRemove}
        aria-label={`Remove ${item.label}`}
      >
        <XMarkIcon className="h-3 w-3" />
      </button>
    </li>
  )
}

/**
 * The models the picker offers: the runtime's list, with the session's current model first when
 * the list no longer names it (a session started on an older model keeps it until switched). Pure.
 */
export function composerModelOptions(
  session: Pick<Session, 'runtime' | 'policy'>
): readonly string[] {
  const offered = AGENT_RUNTIME_MODELS[session.runtime]
  return offered.includes(session.policy.model) ? offered : [session.policy.model, ...offered]
}

export const SessionComposer = forwardRef<SessionComposerHandle, SessionComposerProps>(
  function SessionComposer(
    {
      session,
      value,
      onChange,
      onSend,
      onCancel,
      model,
      onModelChange,
      sending,
      cancelling,
      error,
      attachments,
    },
    ref
  ) {
    const textarea = useRef<HTMLTextAreaElement>(null)
    const picker = useRef<HTMLInputElement>(null)
    const [dragging, setDragging] = useState(false)
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
    const mode = composerSendMode(session)
    const running = session.status === 'working'
    const stopping = session.cancelRequested || cancelling
    const trimmed = value.trim()
    const tooLong = trimmed.length > SESSION_MESSAGE_MAX
    const images = attachments.readyIds.length
    const canSend =
      !blocked &&
      mode !== 'full' &&
      !sending &&
      (trimmed.length > 0 || images > 0) &&
      !tooLong &&
      !attachments.busy &&
      !attachments.failed

    const submit = (how: 'queue' | 'interrupt' = 'queue') => {
      if (canSend) onSend(trimmed, how)
    }

    const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
      if (event.shiftKey && !(event.metaKey || event.ctrlKey)) return
      event.preventDefault()
      submit()
    }

    const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
      const files = imageFilesOf(event.clipboardData?.files)
      if (files.length === 0) return
      // A copied image often carries its file name as text too: the image is what was meant.
      event.preventDefault()
      attachments.addFiles(files)
    }

    const onDragOver = (event: DragEvent<HTMLFormElement>) => {
      if (!Array.from(event.dataTransfer?.types ?? []).includes('Files')) return
      event.preventDefault()
      setDragging(true)
    }

    const onDrop = (event: DragEvent<HTMLFormElement>) => {
      setDragging(false)
      const files = imageFilesOf(event.dataTransfer?.files)
      if (files.length === 0) return
      event.preventDefault()
      attachments.addFiles(files)
      textarea.current?.focus()
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
    // One model is no choice: the picker shows only when there is something to pick.
    const models = composerModelOptions(session)
    return (
      <form
        className="border-t border-[color:var(--border-subtle)] p-3"
        onSubmit={event => {
          event.preventDefault()
          submit()
        }}
        onDragOver={onDragOver}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        data-testid="session-composer-form"
      >
        <div
          className={`rounded-xl border bg-base-100 px-3 py-2 focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/20 ${
            dragging
              ? 'border-primary ring-2 ring-primary/20'
              : 'border-[color:var(--border-default)]'
          }`}
        >
          {attachments.items.length > 0 && (
            <ul className="mb-2 flex flex-wrap gap-2" aria-label="Images for the next message">
              {attachments.items.map(item => (
                <AttachmentChip
                  key={item.key}
                  item={item}
                  onRemove={() => attachments.remove(item.key)}
                />
              ))}
            </ul>
          )}
          <div className="flex items-end gap-2">
            <button
              type="button"
              className="btn btn-sm btn-square btn-ghost"
              onClick={() => picker.current?.click()}
              disabled={attachments.full}
              aria-label="Attach an image"
              title={attachments.full ? 'No room for another image' : 'Attach an image'}
            >
              <PaperClipIcon className="h-4 w-4" />
            </button>
            <input
              ref={picker}
              type="file"
              accept={ACCEPT}
              multiple
              hidden
              data-testid="composer-file-input"
              onChange={event => {
                attachments.addFiles(imageFilesOf(event.target.files))
                event.target.value = ''
              }}
            />
            <label htmlFor="session-composer" className="sr-only">
              Message the coding agent
            </label>
            <textarea
              id="session-composer"
              ref={textarea}
              rows={1}
              className="flex-1 resize-none bg-transparent text-sm leading-6 outline-none placeholder:text-muted"
              placeholder={
                running
                  ? `${agentName(session.runtime)} is working — write the next message`
                  : 'Describe a change…'
              }
              value={value}
              onChange={event => onChange(event.target.value)}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              aria-describedby="session-composer-hint"
            />
            {running && (
              <>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() => submit('interrupt')}
                  disabled={!canSend || stopping}
                  title="Stop this turn and send the message now"
                >
                  Send now
                </button>
                <button
                  type="submit"
                  className="btn btn-sm btn-primary"
                  disabled={!canSend}
                  title="Run it when this turn ends (Enter)"
                >
                  {sending ? <span className="loading loading-spinner loading-xs" /> : 'Queue'}
                </button>
              </>
            )}
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
        </div>
        <div
          id="session-composer-hint"
          className="mt-1.5 flex items-center justify-between gap-2 px-1 text-xs text-muted"
        >
          <span>
            {stopping ? (
              'Stopping after the current step…'
            ) : attachments.notice ? (
              attachments.notice
            ) : attachments.failed ? (
              'An image could not be attached — remove it to send.'
            ) : attachments.busy ? (
              'Attaching images…'
            ) : mode === 'full' ? (
              'A message is already waiting — withdraw it to change it.'
            ) : running ? (
              <>
                <kbd className="kbd kbd-xs">Enter</kbd> queues it for when this turn ends · Send now
                stops the turn first
              </>
            ) : (
              <>
                <kbd className="kbd kbd-xs">Enter</kbd> to send ·{' '}
                <kbd className="kbd kbd-xs">Shift</kbd>+<kbd className="kbd kbd-xs">Enter</kbd> for
                a new line
              </>
            )}
          </span>
          <span className="flex items-center gap-2">
            {nearLimit && (
              <span className={`tabular-nums ${tooLong ? 'text-error' : ''}`}>
                {trimmed.length.toLocaleString()} / {SESSION_MESSAGE_MAX.toLocaleString()}
              </span>
            )}
            {models.length > 1 && (
              <>
                <label htmlFor="session-composer-model" className="sr-only">
                  Model for the next message
                </label>
                <select
                  id="session-composer-model"
                  className="select select-xs select-ghost w-auto"
                  value={model}
                  onChange={event => onModelChange(event.target.value)}
                  title="Model for the next message"
                >
                  {models.map(option => (
                    <option key={option} value={option}>
                      {agentModelLabel(option)}
                    </option>
                  ))}
                </select>
              </>
            )}
          </span>
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
