/**
 * `/apps/:slug/sessions/:id` (Launch P3, spec/07): one coding session — the chat with the coding
 * agent on the left, the running app on the right. The Lovable loop on the company's own repo.
 *
 * It is a PAGE, not a modal (ui.md): a session is left and returned to, shared as a link, and
 * outlives the tab — its own route, its own lazy chunk (it carries `Markdown`), a breadcrumb.
 *
 * Data: the row is `useSession` (nudge + poll while the server owes an answer); the transcript is
 * `useSessionStream` (the durable rows, topped up on the stream's cadence — see that hook); every
 * panel is a selector over those two — `buildSessionChat`, `bootSteps`, `latestPreviewChangeSeq`,
 * `shipGates` — never a second fetch of the same fact.
 *
 * Layout: a fixed-height split from `lg` up, so the transcript scrolls inside its own panel and the
 * preview keeps its place; below `lg` the panes stack and the page scrolls. The ship panel sits
 * above the preview once shipping has started, because from then on it is the news.
 */
import { ChatBubbleLeftRightIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline'
import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { EmptyStateCard, SectionPanelSkeleton } from '@/ui/components/shared'
import { useApp } from '@/ui/hooks/useApps'
import { usePermissions } from '@/ui/hooks/usePermissions'
import { useSessionStream } from '@/ui/hooks/useSessionStream'
import { usePendingBudgetApproval, useResumeSession, useSession } from '@/ui/hooks/useSessions'
import { ApiError } from '@/ui/lib/api-client'
import { budgetAccess } from './components/budgetAccess'
import { ExtendBudgetModal } from './components/ExtendBudgetModal'
import { PreviewFrame } from './components/PreviewFrame'
import { SessionChat } from './components/SessionChat'
import { SessionHeader } from './components/SessionHeader'
import { ShipPanel, shipConfigNeeds } from './components/ShipPanel'
import { bootSteps, latestPreviewChangeSeq, shipGates } from './sessionChatModel'

export default function SessionPage() {
  const { slug = '', id = '' } = useParams<{ slug: string; id: string }>()
  const { data: session, isLoading, error } = useSession(id)
  const { data: app } = useApp(slug)
  const { can } = usePermissions()
  const stream = useSessionStream(session)
  const resume = useResumeSession(id)
  const [extendOpen, setExtendOpen] = useState(false)
  // P4: the creator's open `session.budget` request, so a reload still links to it. Only asked
  // for by someone who may act on a session that can still run.
  const pendingBudget = usePendingBudgetApproval(
    id,
    Boolean(session?.viewerCanManage && !['shipped', 'ended', 'failed'].includes(session.status))
  )

  const events = stream.events
  const steps = useMemo(() => bootSteps(events), [events])
  const gates = useMemo(() => shipGates(events), [events])
  // P5: the shared config ship's scan of the PR head found the app does not hold (names only).
  const configNeeds = useMemo(() => shipConfigNeeds(events), [events])
  const changeSeq = useMemo(
    () => (stream.isLoading ? undefined : latestPreviewChangeSeq(events)),
    [events, stream.isLoading]
  )

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(22rem,2fr)_3fr]">
        <SectionPanelSkeleton rows={6} />
        <SectionPanelSkeleton rows={6} />
      </div>
    )
  }

  if (error || !session) {
    const missing = error instanceof ApiError && error.status === 404
    return (
      <div className="max-w-3xl">
        <EmptyStateCard
          icon={missing ? ChatBubbleLeftRightIcon : ExclamationTriangleIcon}
          message={missing ? 'No session here' : 'This session could not be loaded'}
          description={
            missing
              ? 'It may belong to someone else, or the link is wrong.'
              : (error?.message ?? undefined)
          }
          action={
            <Link to={`/apps/${slug}`} className="btn btn-sm">
              Back to the app
            </Link>
          }
        />
      </div>
    )
  }

  // Extending is for the app's owners and administrators — the route's rule; the app detail's
  // `viewerCanDeploy` is exactly "owner or admin of this app". Anyone else who may act on the
  // session (its creator) ASKS: a `session.budget` approval (P4).
  const canExtend =
    session.viewerCanManage && (can('manage', 'Session') || Boolean(app?.viewerCanDeploy))
  const budget = budgetAccess(session, canExtend, pendingBudget?.id ?? null)
  const showShip = session.status === 'shipping' || session.prNumber !== null || gates.length > 0

  return (
    <div className="flex flex-col gap-4 lg:h-[calc(100dvh-7.5rem)]">
      <SessionHeader
        session={session}
        appSlug={slug}
        appName={app?.displayName ?? slug}
        budget={budget}
        onExtend={() => setExtendOpen(true)}
      />

      {session.error && session.status !== 'failed' && (
        <div className="alert alert-warning alert-soft text-sm" role="status">
          <ExclamationTriangleIcon className="h-5 w-5" />
          <span>{session.error}</span>
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[minmax(22rem,2fr)_3fr]">
        <section
          className="surface-panel flex h-[36rem] min-h-0 flex-col overflow-hidden p-0 lg:h-auto"
          aria-label="Chat"
        >
          <SessionChat
            session={session}
            events={events}
            isLoading={stream.isLoading}
            budget={budget}
            onExtend={() => setExtendOpen(true)}
          />
        </section>
        <div className="flex min-h-0 flex-col gap-4">
          {showShip && (
            <ShipPanel session={session} gates={gates} configNeeds={configNeeds} appSlug={slug} />
          )}
          <div className="h-[32rem] min-h-0 lg:h-auto lg:flex-1">
            <PreviewFrame
              session={session}
              changeSeq={changeSeq}
              steps={steps}
              canManage={session.viewerCanManage}
              onResume={() => resume.mutate()}
              resuming={resume.isPending}
              appSlug={slug}
            />
          </div>
        </div>
      </div>

      {extendOpen && (
        <ExtendBudgetModal
          session={session}
          mode={budget.mode === 'ask' ? 'ask' : 'extend'}
          open={extendOpen}
          onClose={() => setExtendOpen(false)}
        />
      )}
    </div>
  )
}
