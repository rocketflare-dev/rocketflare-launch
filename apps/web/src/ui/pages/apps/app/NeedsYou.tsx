/**
 * The Overview's "Needs you" band (decision 5): shown only when something needs a person — a
 * failed release or deploy, a pending approval, a session's ship waiting on a review or stalled
 * before its release (opened on the session page), a missing config grant (`needsYou` in
 * `appPageModel.ts` decides what is on it). A plain list under a heading, never a tinted box; each
 * item says what happened and offers the one thing to do about it.
 *
 * A reader who can act on none of it reads the same list under "Attention", without the buttons.
 *
 * A stuck release (app page P2) offers the stage-aware Retry, labelled with what it does
 * ("Retry staging deploy", "Check staging again"…), "Fix in a session" (a session seeded with the
 * failure), its GitHub run and its details (`ReleaseActions.tsx`).
 *
 * A production deploy from before the approvals engine (no `approvalId`) is still decided in
 * place, following the "act on it" rules (ui.md): focus lands on its HEADING, never a button, a
 * reader who may not decide reads one sentence, and a 409 (someone else decided, or it expired) is
 * information — no toast, no red.
 */
import type { DeployTicket } from '@launch/shared/launch-pipeline'
import { useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import { useDecideDeploy } from '@/ui/hooks/useDeploys'
import { ApiError } from '@/ui/lib/api-client'
import {
  appTabPath,
  type NeedsYouItem,
  releasePath,
  sessionPath,
  settingsPath,
  ticketVersion,
} from './appPageModel'
import { Ago, ExternalLink, StateDot } from './bits'
import { FixInSessionButton, RetryReleaseButton } from './ReleaseActions'

function DeployDecision({
  ticket,
  appId,
  canDecide,
}: {
  ticket: DeployTicket
  appId: string
  canDecide: boolean
}) {
  const decide = useDecideDeploy(appId)
  const headingRef = useRef<HTMLHeadingElement>(null)

  // A new ticket to decide takes focus — on the heading, so a stray Enter approves nothing.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the ticket, not its contents
  useEffect(() => {
    headingRef.current?.focus()
  }, [ticket.id])

  const conflict = decide.error instanceof ApiError && decide.error.status === 409
  return (
    <div className="min-w-0 flex-1 space-y-1.5" aria-live="polite">
      {/* `tabIndex={-1}` so it can hold focus without becoming a tab stop. */}
      <h3 ref={headingRef} tabIndex={-1} className="text-sm font-medium outline-none">
        Live deploy of {ticketVersion(ticket)} is waiting for approval
      </h3>
      <p className="text-xs text-secondary">
        {ticket.actor ? `Started by ${ticket.actor} ` : 'Started '}
        <Ago at={ticket.createdAt} />
        {ticket.expiresAt && (
          <>
            {' '}
            · the job stops waiting <Ago at={ticket.expiresAt} />
          </>
        )}
      </p>
      {conflict ? (
        <p className="text-sm text-secondary" role="status">
          Someone else decided this deploy, or it expired. The page is up to date.
        </p>
      ) : decide.error ? (
        <p className="text-sm text-error" role="alert">
          {decide.error.message}
        </p>
      ) : null}
      {!canDecide ? (
        <p className="text-sm text-muted">
          Waiting for an app owner or an administrator to approve it.
        </p>
      ) : (
        !conflict && (
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="btn btn-sm"
              disabled={decide.isPending}
              onClick={() => decide.mutate({ ticketId: ticket.id, decision: 'approve' })}
            >
              Approve
            </button>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              disabled={decide.isPending}
              onClick={() => decide.mutate({ ticketId: ticket.id, decision: 'reject' })}
            >
              Reject
            </button>
            <span className="text-xs text-muted">
              Rejecting stops the job; nothing is deployed.
            </span>
          </div>
        )
      )}
    </div>
  )
}

function ItemBody({ title, detail }: { title: string; detail?: string | null }) {
  return (
    <div className="min-w-0 flex-1">
      <p className="text-sm font-medium">{title}</p>
      {detail && (
        <p className="text-xs text-secondary truncate" title={detail}>
          {detail}
        </p>
      )}
    </div>
  )
}

function Item({ item, appId, slug }: { item: NeedsYouItem; appId: string; slug: string }) {
  switch (item.kind) {
    case 'release-failed':
      return (
        <>
          <StateDot tone="error" />
          <ItemBody title={item.title} detail={item.detail} />
          {item.runUrl && <ExternalLink href={item.runUrl}>View run</ExternalLink>}
          <RetryReleaseButton release={item.release} />
          <FixInSessionButton release={item.release} />
          <Link to={releasePath(slug, item.version)} className="btn btn-sm btn-ghost">
            Details
          </Link>
        </>
      )
    case 'deploy-failed':
      return (
        <>
          <StateDot tone="error" />
          <ItemBody title={item.title} detail={item.detail} />
          {item.runUrl && <ExternalLink href={item.runUrl}>View run</ExternalLink>}
          <Link
            to={item.version ? releasePath(slug, item.version) : appTabPath(slug, 'releases')}
            className="btn btn-sm"
          >
            Details
          </Link>
        </>
      )
    case 'approval':
      return (
        <>
          <StateDot tone="warning" />
          <ItemBody title={item.title} />
          <Link to={item.href} className={`btn btn-sm ${item.canAct ? '' : 'btn-ghost'}`}>
            {item.canAct ? 'Review and decide' : 'See the request'}
          </Link>
        </>
      )
    case 'deploy-decision':
      return (
        <>
          <StateDot tone="warning" />
          <DeployDecision
            key={item.ticket.id}
            ticket={item.ticket}
            appId={appId}
            canDecide={item.canAct}
          />
        </>
      )
    case 'session':
      return (
        <>
          <StateDot tone={item.canAct ? 'warning' : 'muted'} />
          <ItemBody title={item.title} detail={item.detail} />
          <Link
            to={sessionPath(slug, item.sessionId)}
            className={`btn btn-sm ${item.canAct ? '' : 'btn-ghost'}`}
          >
            Open session
          </Link>
        </>
      )
    case 'grant':
      return (
        <>
          <StateDot tone="warning" />
          <ItemBody title={item.title} />
          {item.canAct && (
            <Link to={settingsPath(slug, 'config')} className="btn btn-sm">
              Request
            </Link>
          )}
        </>
      )
  }
}

export function NeedsYou({
  items,
  appId,
  slug,
}: {
  items: readonly NeedsYouItem[]
  appId: string
  slug: string
}) {
  if (items.length === 0) return null
  const heading = items.some(item => item.canAct) ? 'Needs you' : 'Attention'
  return (
    <section aria-labelledby="needs-you-title">
      <h2 id="needs-you-title" className="text-base font-semibold mb-1">
        {heading}
      </h2>
      <ul className="divide-y divide-base-300 border-y border-base-300">
        {items.map(item => (
          <li
            key={item.key}
            className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5"
            data-kind={item.kind}
          >
            <Item item={item} appId={appId} slug={slug} />
          </li>
        ))}
      </ul>
    </section>
  )
}
