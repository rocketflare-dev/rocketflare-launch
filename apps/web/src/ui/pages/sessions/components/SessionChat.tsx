/**
 * The chat half of the session page (Launch P3): the transcript folded from the durable rows
 * (`buildSessionChat`), the turn in progress, and the composer.
 *
 * - **Bubbles are `components/ai/ChatBubble`** (the person's text verbatim, Claude's through
 *   `Markdown`), tool calls are `ToolBlock` one-liners between them, and each finished turn gets a
 *   quiet footnote — how long it took and what it cost.
 * - **The person's message shows the moment they press Enter** — a local optimistic bubble,
 *   dropped as soon as the durable `user.message` row after it arrives (the Workflow writes that
 *   row, not the route, so it can take a beat). A refused send takes the bubble back and puts the
 *   text back in the box.
 * - **A turn in progress is visible**: a "working" bubble with the dots at the end of the
 *   transcript, which also says "stopping" once a cancel is requested.
 * - **Auto-scroll follows the run timeline's rule** (`useStickToBottom`): only when the reader is
 *   at the bottom AND a new item arrived; otherwise a "Jump to latest" pill.
 * - **Over budget is a banner above the composer, not an error**: the person who may extend it gets
 *   the button; anyone else reads who can.
 */
import { ArrowDownIcon, SparklesIcon } from '@heroicons/react/24/outline'
import type { Session, SessionEvent } from '@launch/shared/launch-sessions'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { ChatBubble } from '@/ui/components/ai/ChatBubble'
import { formatCost } from '@/ui/components/ai/StatRows'
import { SkeletonRows } from '@/ui/components/shared'
import { turnInProgress, useCancelTurn, useSendTurn } from '@/ui/hooks/useSessions'
import { ApiError } from '@/ui/lib/api-client'
import { formatDuration } from '@/ui/lib/format'
import { useStickToBottom } from '@/ui/pages/agents/run/timeline/useStickToBottom'
import { buildSessionChat, type ChatItem, type NoticeTone } from '../sessionChatModel'
import { SessionComposer, type SessionComposerHandle } from './SessionComposer'
import { ToolBlock } from './ToolBlock'

/** First-message ideas for an empty session — a click puts one in the box, never sends it. */
export const STARTER_PROMPTS = [
  'Change the home page headline to something friendlier',
  'Add a dark mode toggle to the header',
  'Show a helpful empty state when a list has no items',
] as const

const NOTICE_CLASS: Record<NoticeTone, string> = {
  info: 'text-secondary',
  success: 'text-success',
  warning: 'text-warning',
  error: 'text-error',
}

const TranscriptItem = memo(function TranscriptItem({ item }: { item: ChatItem }) {
  switch (item.kind) {
    case 'user':
      return <ChatBubble speaker="user" content={item.text} time={item.at} />
    case 'assistant':
      return <ChatBubble speaker="assistant" content={item.text} time={item.at} />
    case 'tools':
      return <ToolBlock rows={item.rows} />
    case 'turn-end': {
      const parts = [
        item.durationMs !== undefined ? formatDuration(item.durationMs) : null,
        item.costMicrocents !== undefined ? formatCost(item.costMicrocents) : null,
      ].filter(Boolean)
      return (
        <p className="text-center text-xs text-muted" data-turn-end={item.turn}>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-px w-6 bg-[color:var(--border-subtle)]" aria-hidden="true" />
            Turn {item.turn} done{parts.length ? ` · ${parts.join(' · ')}` : ''}
            <span className="h-px w-6 bg-[color:var(--border-subtle)]" aria-hidden="true" />
          </span>
        </p>
      )
    }
    case 'notice':
      return (
        <p
          className={`px-1 text-xs ${NOTICE_CLASS[item.tone]}`}
          role={item.tone === 'error' ? 'alert' : undefined}
          data-notice={item.tone}
        >
          {item.text}
        </p>
      )
  }
})

function EmptyTranscript({
  session,
  onPick,
}: {
  session: Session
  onPick: (prompt: string) => void
}) {
  const booting = session.status === 'requested' || session.status === 'booting'
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-6 py-10 text-center">
      <SparklesIcon className="h-10 w-10 text-primary opacity-70" />
      <div>
        <p className="text-base font-medium">What should we change?</p>
        <p className="mt-1 text-sm text-secondary">
          {booting
            ? 'Your sandbox is starting. Write your first message now — it runs as soon as the app is up.'
            : 'Describe it in plain words. Claude edits the code, and the preview on the right updates after each turn.'}
        </p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        {STARTER_PROMPTS.map(prompt => (
          <button
            key={prompt}
            type="button"
            className="btn btn-sm btn-ghost border border-[color:var(--border-subtle)] font-normal"
            onClick={() => onPick(prompt)}
          >
            {prompt}
          </button>
        ))}
      </div>
    </div>
  )
}

function BudgetBanner({
  session,
  canExtend,
  onExtend,
}: {
  session: Session
  canExtend: boolean
  onExtend: () => void
}) {
  return (
    <div className="alert alert-warning alert-soft mx-3 mb-2 text-sm" role="status">
      <div className="min-w-0 flex-1">
        <p className="font-medium">
          This session has used its {formatCost(session.budget.capMicrocents)} budget.
        </p>
        <p className="text-xs">
          {canExtend
            ? 'Extend it to keep going — the next message runs as soon as you do.'
            : 'Ask an owner of this app or an administrator to extend it.'}
        </p>
      </div>
      {canExtend && (
        <button type="button" className="btn btn-sm" onClick={onExtend}>
          Extend budget
        </button>
      )}
    </div>
  )
}

interface PendingMessage {
  text: string
  /** The newest row when it was sent: a `user.message` after this, with this text, is its copy. */
  afterSeq: number
}

export function SessionChat({
  session,
  events,
  isLoading,
  canExtend,
  onExtend,
}: {
  session: Session
  events: readonly SessionEvent[]
  isLoading: boolean
  canExtend: boolean
  onExtend: () => void
}) {
  const items = useMemo(() => buildSessionChat(events), [events])
  const [draft, setDraft] = useState('')
  const [pending, setPending] = useState<PendingMessage | null>(null)
  const [sendError, setSendError] = useState<{ tone: 'info' | 'error'; message: string } | null>(
    null
  )
  const composer = useRef<SessionComposerHandle>(null)
  const send = useSendTurn(session.id)
  const cancel = useCancelTurn(session.id)

  const lastSeq = events.at(-1)?.seq ?? 0
  // The durable copy of the optimistic bubble has arrived.
  useEffect(() => {
    if (!pending) return
    const durable = events.some(
      e =>
        e.type === 'user.message' &&
        e.seq > pending.afterSeq &&
        (e.data as { text?: unknown } | undefined)?.text === pending.text
    )
    if (durable) setPending(null)
  }, [events, pending])

  const onSend = (text: string) => {
    setSendError(null)
    setPending({ text, afterSeq: lastSeq })
    setDraft('')
    send.mutate(
      { message: text },
      {
        onError: error => {
          setPending(null)
          setDraft(current => (current ? current : text))
          const conflict = error instanceof ApiError && error.status === 409
          setSendError({
            tone: conflict && error.code === 'turn_in_progress' ? 'info' : 'error',
            message:
              conflict && error.code === 'turn_in_progress'
                ? 'Claude is still working on the last message — send this one when it finishes.'
                : error.message,
          })
        },
      }
    )
    composer.current?.focus()
  }

  const busy = turnInProgress(session)
  const showWorking = busy || pending !== null
  const lastId = pending
    ? `pending-${pending.afterSeq}`
    : showWorking
      ? `working-${items.at(-1)?.id ?? ''}`
      : items.at(-1)?.id
  const stick = useStickToBottom(lastId, items.length + (showWorking ? 1 : 0))

  // Focus the box when the page opens on a session that can take a message.
  useEffect(() => {
    composer.current?.focus()
  }, [])

  const empty = !isLoading && items.length === 0 && !pending
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="relative min-h-0 flex-1">
        <div
          className="h-full overflow-y-auto px-4 py-4"
          aria-live="polite"
          aria-busy={showWorking || undefined}
          data-testid="session-transcript"
        >
          {isLoading ? (
            <SkeletonRows rows={5} />
          ) : empty ? (
            <EmptyTranscript
              session={session}
              onPick={prompt => {
                setDraft(prompt)
                composer.current?.focus()
              }}
            />
          ) : (
            <ol className="space-y-3">
              {items.map(item => (
                <li key={item.id}>
                  <TranscriptItem item={item} />
                </li>
              ))}
              {pending && (
                <li>
                  <ChatBubble speaker="user" content={pending.text} />
                </li>
              )}
              {showWorking && (
                <li data-testid="turn-working">
                  <ChatBubble speaker="assistant" content="" streaming />
                  <p className="-mt-1 ml-2 text-xs text-muted">
                    {session.cancelRequested
                      ? 'Stopping…'
                      : session.status === 'working'
                        ? 'Working…'
                        : session.status === 'booting' || session.status === 'requested'
                          ? 'Waiting for the sandbox to start…'
                          : 'Starting the turn…'}
                  </p>
                </li>
              )}
            </ol>
          )}
          <div ref={stick.sentinelRef} aria-hidden="true" />
        </div>
        {!stick.atBottom && stick.unseen > 0 && (
          <button
            type="button"
            className="btn btn-xs btn-primary absolute bottom-3 left-1/2 -translate-x-1/2 gap-1 shadow"
            onClick={stick.scrollToBottom}
          >
            <ArrowDownIcon className="h-3 w-3" />
            Jump to latest · {stick.unseen} new
          </button>
        )}
      </div>

      {session.status === 'blocked' && (
        <BudgetBanner session={session} canExtend={canExtend} onExtend={onExtend} />
      )}

      <SessionComposer
        ref={composer}
        session={session}
        value={draft}
        onChange={value => {
          setDraft(value)
          if (sendError) setSendError(null)
        }}
        onSend={onSend}
        onCancel={() => cancel.mutate()}
        sending={send.isPending}
        cancelling={cancel.isPending}
        error={sendError}
      />
    </div>
  )
}
