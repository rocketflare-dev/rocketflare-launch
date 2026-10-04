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
 * - **A message queued behind a running turn** is a muted bubble after it — "Runs when this turn
 *   ends" (or "as soon as Claude stops" after Send now) — with Withdraw, which puts the text back
 *   in the box. It is the row's `queuedMessage`, so it survives a reload; the local optimistic
 *   copy only bridges the send, and is dropped when the row says the message is gone without its
 *   turn having started (withdrawn in another tab).
 * - **Auto-scroll follows the run timeline's rule** (`useStickToBottom`): only when the reader is
 *   at the bottom AND a new item arrived; otherwise a "Jump to latest" pill.
 * - **A message's images** show as thumbnails inside its bubble (`GET /:id/attachments/:aid`,
 *   same origin, the session cookie); one opens full size in a new tab. The queued and the
 *   optimistic bubbles show theirs too, and Withdraw puts them back as chips.
 * - **Over budget is a banner above the composer, not an error**: the person who may extend it gets
 *   the button; anyone else reads who can.
 */
import { ArrowDownIcon, SparklesIcon } from '@heroicons/react/24/outline'
import { approvalPath } from '@launch/shared/launch-approvals'
import {
  type Session,
  type SessionAttachment,
  type SessionEvent,
  sessionAttachmentPath,
} from '@launch/shared/launch-sessions'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ChatBubble } from '@/ui/components/ai/ChatBubble'
import { formatCost } from '@/ui/components/ai/StatRows'
import { SkeletonRows } from '@/ui/components/shared'
import {
  turnInProgress,
  useCancelTurn,
  useSendTurn,
  useWithdrawQueued,
} from '@/ui/hooks/useSessions'
import { ApiError } from '@/ui/lib/api-client'
import { formatDuration } from '@/ui/lib/format'
import { useStickToBottom } from '@/ui/pages/agents/run/timeline/useStickToBottom'
import { buildSessionChat, type ChatItem, type NoticeTone } from '../sessionChatModel'
import type { ComposerAttachments } from '../useComposerAttachments'
import type { BudgetAccess } from './budgetAccess'
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

/** A message's images as thumbnails; each opens full size in a new tab. */
function MessageImages({
  sessionId,
  attachments,
}: {
  sessionId: string
  attachments: readonly SessionAttachment[]
}) {
  if (attachments.length === 0) return null
  return (
    <ul className="mb-1 flex flex-wrap justify-end gap-1.5" data-testid="message-images">
      {attachments.map((attachment, index) => {
        const url = sessionAttachmentPath(sessionId, attachment.id)
        return (
          <li key={attachment.id}>
            <a href={url} target="_blank" rel="noopener noreferrer" title="Open full size">
              <img
                src={url}
                alt={`Attachment ${index + 1}`}
                className="h-20 max-w-[10rem] rounded-md bg-base-100 object-cover"
                loading="lazy"
              />
            </a>
          </li>
        )
      })}
    </ul>
  )
}

/** The person's bubble: their words, with any images above them. */
function UserBubble({
  sessionId,
  text,
  attachments,
  at,
}: {
  sessionId: string
  text: string
  attachments: readonly SessionAttachment[]
  at?: Date
}) {
  return (
    <ChatBubble
      speaker="user"
      content={text}
      time={at}
      media={<MessageImages sessionId={sessionId} attachments={attachments} />}
    />
  )
}

const TranscriptItem = memo(function TranscriptItem({
  item,
  sessionId,
}: {
  item: ChatItem
  sessionId: string
}) {
  switch (item.kind) {
    case 'user':
      return (
        <UserBubble
          sessionId={sessionId}
          text={item.text}
          attachments={item.attachments}
          at={item.at}
        />
      )
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
  budget,
  onExtend,
}: {
  session: Session
  budget: BudgetAccess
  onExtend: () => void
}) {
  const waiting = Boolean(budget.pendingApprovalId)
  return (
    <div className="alert alert-warning alert-soft mx-3 mb-2 text-sm" role="status">
      <div className="min-w-0 flex-1">
        <p className="font-medium">
          This session has used its {formatCost(session.budget.capMicrocents)} budget.
        </p>
        <p className="text-xs">
          {waiting
            ? 'You asked for more — the next message runs as soon as it is approved.'
            : budget.mode === 'extend'
              ? 'Extend it to keep going — the next message runs as soon as you do.'
              : budget.mode === 'ask'
                ? 'Ask an owner of this app or an administrator for more to keep going.'
                : 'Ask an owner of this app or an administrator to extend it.'}
        </p>
      </div>
      {waiting && budget.pendingApprovalId ? (
        <Link to={approvalPath(budget.pendingApprovalId)} className="btn btn-sm">
          See the request
        </Link>
      ) : budget.mode === 'extend' ? (
        <button type="button" className="btn btn-sm" onClick={onExtend}>
          Extend budget
        </button>
      ) : budget.mode === 'ask' ? (
        <button type="button" className="btn btn-sm" onClick={onExtend}>
          Ask for more budget
        </button>
      ) : null}
    </div>
  )
}

interface PendingMessage {
  text: string
  attachments: SessionAttachment[]
  /** The newest row when it was sent: a `user.message` after this, with this text, is its copy. */
  afterSeq: number
  /** The session's turn count when it was sent: a higher one means its turn has started. */
  turnCount: number
}

function QueuedMessage({
  sessionId,
  text,
  attachments,
  stopping,
  onWithdraw,
  withdrawing,
}: {
  sessionId: string
  text: string
  attachments: readonly SessionAttachment[]
  stopping: boolean
  onWithdraw: (() => void) | null
  withdrawing: boolean
}) {
  return (
    <div className="chat chat-end" data-testid="queued-message">
      <div className="chat-bubble max-w-[80%] bg-base-200 text-secondary">
        <MessageImages sessionId={sessionId} attachments={attachments} />
        {text && <span className="whitespace-pre-wrap break-words">{text}</span>}
      </div>
      <div className="chat-footer mt-0.5 flex items-center gap-1.5 text-xs text-muted">
        {stopping ? 'Runs as soon as Claude stops' : 'Runs when this turn ends'}
        {onWithdraw && (
          <button
            type="button"
            className="btn btn-ghost btn-xs"
            onClick={onWithdraw}
            disabled={withdrawing}
          >
            Withdraw
          </button>
        )}
      </div>
    </div>
  )
}

export function SessionChat({
  session,
  events,
  isLoading,
  budget,
  onExtend,
  attachments,
}: {
  session: Session
  events: readonly SessionEvent[]
  isLoading: boolean
  budget: BudgetAccess
  onExtend: () => void
  /** The next message's images (`SessionPage` owns them: the preview adds screenshots). */
  attachments: ComposerAttachments
}) {
  const items = useMemo(() => buildSessionChat(events), [events])
  const [draft, setDraft] = useState('')
  const [pending, setPending] = useState<PendingMessage | null>(null)
  const [sendError, setSendError] = useState<{ tone: 'info' | 'error'; message: string } | null>(
    null
  )
  // The model the next message runs on: the session's, until the person picks another; a switch
  // that took effect (the turn's claim moved `policy.model`) re-seeds it.
  const [model, setModel] = useState(session.policy.model)
  useEffect(() => setModel(session.policy.model), [session.policy.model])
  const composer = useRef<SessionComposerHandle>(null)
  const send = useSendTurn(session.id)
  const cancel = useCancelTurn(session.id)
  const withdraw = useWithdrawQueued(session.id)

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

  const running = session.status === 'working'
  // The row says nothing waits, and no turn started since the send: it was withdrawn elsewhere.
  useEffect(() => {
    if (
      pending &&
      !send.isPending &&
      running &&
      session.queuedMessage === null &&
      session.turnCount === pending.turnCount
    ) {
      setPending(null)
    }
  }, [pending, send.isPending, running, session.queuedMessage, session.turnCount])

  const onSend = (text: string, mode: 'queue' | 'interrupt') => {
    setSendError(null)
    const images = attachments.items.flatMap(item =>
      item.status === 'ready' && item.id && item.contentType
        ? [{ id: item.id, contentType: item.contentType }]
        : []
    )
    setPending({ text, attachments: images, afterSeq: lastSeq, turnCount: session.turnCount })
    setDraft('')
    send.mutate(
      {
        message: text,
        ...(model === session.policy.model ? {} : { model }),
        ...(mode === 'interrupt' ? { mode } : {}),
        ...(images.length ? { attachments: images.map(image => image.id) } : {}),
      },
      {
        // The chips are the message's now; a refused send keeps them, like the text.
        onSuccess: () => attachments.clear(),
        onError: error => {
          setPending(null)
          setDraft(current => (current ? current : text))
          const conflict = error instanceof ApiError && error.status === 409
          setSendError({
            tone: conflict && error.code === 'turn_in_progress' ? 'info' : 'error',
            message:
              conflict && error.code === 'turn_in_progress'
                ? 'A message is already waiting to run — withdraw it to send this one instead.'
                : error.message,
          })
        },
      }
    )
    composer.current?.focus()
  }

  // Behind a running turn: the row's waiting message, or the one being sent right now.
  const rowQueued =
    session.queuedMessage !== null
      ? { text: session.queuedMessage, attachments: session.queuedAttachments }
      : null
  const queued = running
    ? (rowQueued ?? (pending && pending.turnCount === session.turnCount ? pending : null))
    : null
  // Otherwise a waiting message is the next user bubble — the one just sent, or (after a reload)
  // the row's, waiting for the sandbox.
  const waiting = queued === null ? (pending ?? (running ? null : rowQueued)) : null

  const onWithdraw = () => {
    const taken = queued
    withdraw.mutate(undefined, {
      onSuccess: () => {
        setPending(null)
        if (taken?.text) setDraft(current => (current.trim() ? current : taken.text))
        // Its images come back as chips, unless the person has started on new ones.
        if (taken?.attachments.length && attachments.items.length === 0) {
          attachments.addExisting(taken.attachments)
        }
        composer.current?.focus()
      },
    })
  }

  const busy = turnInProgress(session)
  const showWorking = busy || waiting !== null
  const lastId =
    queued !== null
      ? `queued-${session.turnCount}`
      : waiting !== null
        ? `pending-${pending?.afterSeq ?? 'row'}`
        : showWorking
          ? `working-${items.at(-1)?.id ?? ''}`
          : items.at(-1)?.id
  const stick = useStickToBottom(
    lastId,
    items.length + (showWorking ? 1 : 0) + (queued !== null ? 1 : 0)
  )

  // Focus the box when the page opens on a session that can take a message.
  useEffect(() => {
    composer.current?.focus()
  }, [])

  const empty = !isLoading && items.length === 0 && waiting === null && queued === null
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
                  <TranscriptItem item={item} sessionId={session.id} />
                </li>
              ))}
              {waiting !== null && (
                <li>
                  <UserBubble
                    sessionId={session.id}
                    text={waiting.text}
                    attachments={waiting.attachments}
                  />
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
              {queued !== null && (
                <li>
                  <QueuedMessage
                    sessionId={session.id}
                    text={queued.text}
                    attachments={queued.attachments}
                    stopping={session.cancelRequested}
                    // Only once the row holds it: before that there is nothing to take back.
                    onWithdraw={session.queuedMessage !== null ? onWithdraw : null}
                    withdrawing={withdraw.isPending}
                  />
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
        <BudgetBanner session={session} budget={budget} onExtend={onExtend} />
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
        model={model}
        onModelChange={setModel}
        sending={send.isPending}
        cancelling={cancel.isPending}
        error={sendError}
        attachments={attachments}
      />
    </div>
  )
}
