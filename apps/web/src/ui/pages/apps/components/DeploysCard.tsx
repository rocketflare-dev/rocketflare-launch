/**
 * An app's deploys (Launch P2, DEPLOYER.md): the recent deploy tickets — environment, version,
 * status, who ran it and when — and the two things a person does here: decide a `pending`
 * production deploy (inside the job's wait), and "Deploy to production".
 *
 * From P4 both go through the approvals engine: a pending production ticket carries its
 * `approvalId`, and the panel links to that request's page — where the context, the N-of-M
 * progress and the policy are — instead of deciding in place (a ticket without one, from before the
 * engine, keeps the in-place panel). "Deploy to production" opens a `deploy.production` approval
 * for the default branch and goes to it; approval pre-approves the run and starts `deploy.yml`.
 *
 * The decision panel follows the "act on it" rules (ui.md): pinned above the list, focus lands on
 * its HEADING and never on a button, a person who may not decide reads one sentence instead of a
 * disabled control, and a 409 (someone else decided, or it expired) is information — `alert-info`
 * and a refetch, no toast, no red.
 */
import {
  ArrowTopRightOnSquareIcon,
  CheckIcon,
  CloudArrowUpIcon,
  ShieldExclamationIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline'
import { approvalPath } from '@launch/shared/launch-approvals'
import {
  type DeployTicket,
  type DeployTicketStatus,
  PRODUCTION_INTENT_TTL_MS,
} from '@launch/shared/launch-pipeline'
import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  ConfirmModal,
  EmptyState,
  SectionPanel,
  SkeletonRows,
  showToast,
} from '@/ui/components/shared'
import { useDecideDeploy, useDeployProduction, useDeploys } from '@/ui/hooks/useDeploys'
import { ApiError } from '@/ui/lib/api-client'
import { formatDateTime, timeAgo } from '@/ui/lib/format'

/** Ticket status → the `.status-badge` vocabulary in `index.css`, and the word shown. */
const BADGE: Record<DeployTicketStatus, { tone: string; label: string }> = {
  pending: { tone: 'awaiting-review', label: 'awaiting approval' },
  approved: { tone: 'queued', label: 'approved' },
  rejected: { tone: 'rejected', label: 'rejected' },
  uploaded: { tone: 'running', label: 'deploying' },
  active: { tone: 'active', label: 'live' },
  finished: { tone: 'completed', label: 'finished' },
  failed: { tone: 'failed', label: 'failed' },
}

/**
 * The badge for a ticket. `finished` alone is not "deployed": a ticket `finish` closed without an
 * activation (the job died after upload) went nowhere, and reads as such. Pure.
 */
export function ticketBadge(ticket: Pick<DeployTicket, 'status' | 'activatedAt'>): {
  tone: string
  label: string
} {
  if (ticket.status === 'finished' && !ticket.activatedAt) {
    return { tone: 'failed', label: 'not activated' }
  }
  return BADGE[ticket.status]
}

/** Newest first, deploys only (the scaffold job's ticket is the launch's business). Pure. */
export function deployRows(items: readonly DeployTicket[]): DeployTicket[] {
  return items.filter(t => t.purpose === 'deploy')
}

/** The production ticket waiting on a person, if any — the oldest, since it expires first. Pure. */
export function pendingProduction(items: readonly DeployTicket[]): DeployTicket | null {
  const pending = items.filter(t => t.environment === 'production' && t.status === 'pending')
  return pending.at(-1) ?? null
}

/** A short, honest name for what was deployed: the version, else the commit. Pure. */
export function ticketVersion(ticket: Pick<DeployTicket, 'version' | 'sha'>): string {
  return ticket.version ?? (ticket.sha ? ticket.sha.slice(0, 7) : '—')
}

function runUrl(ticket: DeployTicket): string | null {
  return ticket.repository && ticket.runId
    ? `https://github.com/${ticket.repository}/actions/runs/${ticket.runId}`
    : null
}

function EnvTag({ env }: { env: DeployTicket['environment'] }) {
  return (
    <span
      className={`status-badge no-dot capitalize ${env === 'production' ? 'tone-primary' : 'tone-warning'}`}
    >
      {env}
    </span>
  )
}

function DecisionPanel({
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
  const url = runUrl(ticket)

  return (
    <section
      className="rounded-lg border border-l-4 border-base-300 border-l-warning p-4 mb-4"
      aria-label="Production deploy awaiting approval"
      aria-live="polite"
    >
      <div className="flex items-start gap-2.5">
        <ShieldExclamationIcon className="w-5 h-5 shrink-0 text-warning mt-0.5" />
        <div className="min-w-0 flex-1 space-y-2">
          {/* `tabIndex={-1}` so it can hold focus without becoming a tab stop. */}
          <h3 ref={headingRef} tabIndex={-1} className="text-sm font-semibold outline-none">
            Production deploy of {ticketVersion(ticket)} is waiting for approval
          </h3>
          <p className="text-sm text-secondary">
            {ticket.actor ? <>Started by {ticket.actor}</> : 'Started'} {timeAgo(ticket.createdAt)}
            {ticket.ref && (
              <>
                {' '}
                from{' '}
                <span className="font-mono text-xs">
                  {ticket.ref.replace(/^refs\/(heads|tags)\//, '')}
                </span>
              </>
            )}
            {url && (
              <>
                {' · '}
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="link link-hover inline-flex items-center gap-0.5"
                >
                  the run
                  <ArrowTopRightOnSquareIcon className="w-3 h-3" />
                </a>
              </>
            )}
            {ticket.expiresAt && <> · the job stops waiting {timeAgo(ticket.expiresAt)}</>}
          </p>
          {conflict ? (
            <div className="alert alert-info alert-soft text-sm">
              <span>
                Someone else decided this deploy, or it expired. The list below is up to date.
              </span>
            </div>
          ) : decide.error ? (
            <div className="alert alert-error alert-soft text-sm" role="alert">
              <span>{decide.error.message}</span>
            </div>
          ) : null}
          {!canDecide ? (
            <p className="text-sm text-muted">
              Waiting for an app owner or an administrator to approve it.
            </p>
          ) : (
            !conflict && (
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <button
                  type="button"
                  className="btn btn-sm btn-primary gap-1.5"
                  disabled={decide.isPending}
                  onClick={() => decide.mutate({ ticketId: ticket.id, decision: 'approve' })}
                >
                  <CheckIcon className="w-4 h-4" />
                  Approve
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost gap-1.5"
                  disabled={decide.isPending}
                  onClick={() => decide.mutate({ ticketId: ticket.id, decision: 'reject' })}
                >
                  <XMarkIcon className="w-4 h-4" />
                  Reject
                </button>
                <span className="text-xs text-muted">
                  Rejecting stops the job; nothing is deployed.
                </span>
              </div>
            )
          )}
        </div>
      </div>
    </section>
  )
}

/** A pending production ticket the approvals engine owns: say so, and link to the request. */
function ApprovalLinkPanel({ ticket, canDecide }: { ticket: DeployTicket; canDecide: boolean }) {
  return (
    <section
      className="rounded-lg border border-l-4 border-base-300 border-l-warning p-4 mb-4"
      aria-label="Production deploy awaiting approval"
    >
      <div className="flex flex-wrap items-center gap-3">
        <ShieldExclamationIcon className="w-5 h-5 shrink-0 text-warning" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">
            Production deploy of {ticketVersion(ticket)} is waiting for approval
          </p>
          <p className="text-xs text-secondary">
            {ticket.actor ? <>Started by {ticket.actor} </> : 'Started '}
            {timeAgo(ticket.createdAt)}
            {ticket.expiresAt && <> · the job stops waiting {timeAgo(ticket.expiresAt)}</>}
          </p>
        </div>
        {ticket.approvalId && (
          <Link
            to={approvalPath(ticket.approvalId)}
            className={`btn btn-sm ${canDecide ? 'btn-primary' : 'btn-ghost'}`}
          >
            {canDecide ? 'Review and decide' : 'See the request'}
          </Link>
        )}
      </div>
    </section>
  )
}

const WINDOW = 8

export function DeploysCard({
  appId,
  canDecide,
  canDeployProduction,
}: {
  appId: string
  /** App owners and admins: approve or reject a pending production deploy. */
  canDecide: boolean
  /** Shows "Deploy to production" (the app must be live). */
  canDeployProduction: boolean
}) {
  const { data, isLoading } = useDeploys(appId)
  const navigate = useNavigate()
  const deployProduction = useDeployProduction(appId)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const rows = deployRows(data?.items ?? [])
  const pending = pendingProduction(rows)
  const shown = showAll ? rows : rows.slice(0, WINDOW)

  return (
    <SectionPanel
      title="Deploys"
      description="Every build that asked Launch to deploy it, newest first."
      actions={
        canDeployProduction && (
          <button
            type="button"
            className="btn btn-sm gap-1.5"
            onClick={() => setConfirmOpen(true)}
            disabled={deployProduction.isPending}
          >
            <CloudArrowUpIcon className="w-4 h-4" />
            Deploy to production
          </button>
        )
      }
    >
      {pending &&
        (pending.approvalId ? (
          <ApprovalLinkPanel ticket={pending} canDecide={canDecide} />
        ) : (
          <DecisionPanel key={pending.id} ticket={pending} appId={appId} canDecide={canDecide} />
        ))}

      {isLoading ? (
        <SkeletonRows rows={3} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={CloudArrowUpIcon}
          size="sm"
          message="No deploys yet"
          description="The first staging deploy appears here as soon as its build asks for a ticket."
        />
      ) : (
        <>
          <div className="overflow-x-auto -mx-1">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Environment</th>
                  <th>Version</th>
                  <th>Status</th>
                  <th>By</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {shown.map(ticket => {
                  const badge = ticketBadge(ticket)
                  const url = runUrl(ticket)
                  const detail = ticket.refused?.length
                    ? `Refused: ${ticket.refused.join(', ')}`
                    : ticket.error
                  return (
                    <tr key={ticket.id}>
                      <td>
                        <EnvTag env={ticket.environment} />
                      </td>
                      <td className="font-mono text-xs">
                        {url ? (
                          <a
                            href={url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="link link-hover"
                            title={ticket.sha ?? undefined}
                          >
                            {ticketVersion(ticket)}
                          </a>
                        ) : (
                          <span title={ticket.sha ?? undefined}>{ticketVersion(ticket)}</span>
                        )}
                      </td>
                      <td>
                        <span className="status-badge" data-status={badge.tone}>
                          {badge.label}
                        </span>
                        {detail && (
                          <p
                            className="text-xs text-error mt-1 max-w-[20rem] truncate"
                            title={detail}
                          >
                            {detail}
                          </p>
                        )}
                      </td>
                      <td className="text-secondary text-sm">
                        {ticket.actor ?? (ticket.decisionSource === 'intent' ? 'Launch' : '—')}
                      </td>
                      <td
                        className="text-secondary text-sm whitespace-nowrap"
                        title={formatDateTime(ticket.createdAt)}
                      >
                        {timeAgo(ticket.createdAt)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {rows.length > WINDOW && !showAll && (
            <button
              type="button"
              className="btn btn-ghost btn-xs mt-2"
              onClick={() => setShowAll(true)}
            >
              Show {rows.length - WINDOW} earlier
            </button>
          )}
        </>
      )}

      <ConfirmModal
        isOpen={confirmOpen}
        title="Deploy to production?"
        message={
          <div className="space-y-2">
            <p>
              Launch asks this app’s approvers to deploy its default branch to production. Once
              someone other than you approves, it starts the repository’s deploy workflow, which
              runs the full gate first — nothing changes if that fails.
            </p>
            <p className="text-secondary text-sm">
              To ship a tested version instead, promote a release that staging is running.
            </p>
          </div>
        }
        confirmText="Ask for approval"
        isLoading={deployProduction.isPending}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() =>
          deployProduction.mutate(undefined, {
            onSuccess: ({ ticket, approvalId }) => {
              setConfirmOpen(false)
              if (approvalId && !ticket) {
                showToast('Production deploy requested — waiting for approval', 'success')
                navigate(approvalPath(approvalId))
              } else {
                showToast(
                  `Production deploy started — approved for ${Math.round(PRODUCTION_INTENT_TTL_MS / 60_000)} minutes`,
                  'success'
                )
              }
            },
          })
        }
      />
    </SectionPanel>
  )
}
