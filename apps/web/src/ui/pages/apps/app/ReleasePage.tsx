/**
 * `/apps/:slug/releases/:version` — one release (decision 9): where it stands, its deploys to
 * Staging and Live (the newest of each with its milestones while it runs, or where it stopped and
 * why), the pull requests it carries, and its whole story — `ReleaseChain`, read here because the
 * page was opened for it.
 *
 * A version with no release row (a deploy of a build that was never tagged) shows its deploys
 * only. Ship is for the app's owners and admins, like everywhere else.
 *
 * App page P2: a stuck release shows the stage it is stuck at with the stage-aware Retry and
 * "Fix in a session" beside it, and a ⋯ with Cancel release while a run is in flight. Every GitHub
 * run attempt is its own deploy line ("attempt 2"): a Retry re-runs the run's failed jobs, and
 * attempt 2's deploy job opens a ticket of its own, so the attempts read in order.
 *
 * App page P3: an earlier release that was live before offers "Roll back to here" (owners and
 * admins), and a release Live was rolled back to says what it replaced.
 */
import { approvalPath } from '@launch/shared/launch-approvals'
import type { DeployProgress } from '@launch/shared/launch-apps'
import type { DeployTicket } from '@launch/shared/launch-pipeline'
import { RELEASE_STAGE_LABELS, type Release } from '@launch/shared/launch-releases'
import { Link, useParams } from 'react-router-dom'
import { SkeletonRows } from '@/ui/components/shared'
import { useDeployProgress, useDeploys } from '@/ui/hooks/useDeploys'
import { useReleases } from '@/ui/hooks/useReleases'
import { v } from '../components/promotionModel'
import { ReleaseChain } from '../components/ReleaseChain'
import { canPromote, RELEASE_BADGE } from '../components/releaseModel'
import { ShipButton } from '../components/ShipDialog'
import { appTabPath, deployRows, ENV_LABEL, ticketBadge, ticketRunUrl } from './appPageModel'
import { Ago, ExternalLink, MoreMenu, SectionHeading, Version } from './bits'
import { useAppPage } from './context'
import { DeploySteps } from './DeploySteps'
import {
  FixInSessionButton,
  RetryReleaseButton,
  RollbackButton,
  useReleaseMenu,
} from './ReleaseActions'

function DeployLine({
  ticket,
  progress,
}: {
  ticket: DeployTicket
  /** The environment's latest deploy, when it is THIS ticket: its milestones. */
  progress: DeployProgress | undefined
}) {
  const badge = ticketBadge(ticket)
  const run = ticketRunUrl(ticket)
  const problem = ticket.refused?.length ? `Refused: ${ticket.refused.join(', ')}` : ticket.error
  const attempt = ticket.runAttempt && ticket.runAttempt > 1 ? ticket.runAttempt : null
  return (
    <li className="py-3 space-y-1.5" data-testid={`deploy-${ticket.environment}`}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="w-16 shrink-0 text-sm font-medium">{ENV_LABEL[ticket.environment]}</span>
        <span className="status-badge" data-status={badge.tone}>
          {badge.label}
        </span>
        <span className="text-xs text-secondary">
          {attempt && <span className="tabular-nums">attempt {attempt} · </span>}
          started <Ago at={ticket.createdAt} />
          {ticket.actor ? ` by ${ticket.actor}` : ''}
        </span>
        {run && (
          <span className="text-xs ml-auto">
            <ExternalLink href={run}>View run</ExternalLink>
          </span>
        )}
      </div>
      {progress && progress.phase !== 'done' && (
        <div className="sm:pl-20">
          <DeploySteps deploy={progress} />
        </div>
      )}
      {problem && <p className="sm:pl-20 text-xs text-error break-words">{problem}</p>}
      {ticket.status === 'pending' && ticket.approvalId && (
        <p className="sm:pl-20 text-xs text-secondary">
          Waiting for approval.{' '}
          <Link to={approvalPath(ticket.approvalId)} className="link link-hover">
            See the request
          </Link>
        </p>
      )}
    </li>
  )
}

/** The release's ⋯ — Cancel release while a run is in flight (Retry and Fix sit beside it). */
function ReleaseMenu({ release }: { release: Release }) {
  const { items, dialog } = useReleaseMenu(release)
  // Retry and Fix in a session are buttons on this page already: the menu keeps the rest.
  const rest = items.filter(item => item.label.startsWith('Cancel'))
  return (
    <>
      <MoreMenu items={rest} label={`Actions for v${release.version}`} />
      {dialog}
    </>
  )
}

export default function ReleasePage() {
  const { version = '' } = useParams<{ version: string }>()
  const { app, hasRepo, stage } = useAppPage()
  const enabled = hasRepo && !stage.holding
  const releases = useReleases(app.id, enabled)
  const tickets = useDeploys(app.id, enabled)
  const latest = useDeployProgress(app.id, enabled)
  const back = (
    <Link to={appTabPath(app.slug, 'releases')} className="link link-hover text-sm">
      ← Releases
    </Link>
  )

  if (releases.isLoading || tickets.isLoading) return <SkeletonRows rows={4} />

  const release = releases.data?.items.find(r => r.version === version) ?? null
  const deploys = deployRows(tickets.data?.items ?? []).filter(t =>
    release ? t.releaseId === release.id || t.version === release.version : t.version === version
  )
  if (!release && deploys.length === 0) {
    return (
      <div className="space-y-2">
        {back}
        <p className="text-sm text-muted">No release or deploy of {v(version)} on this app.</p>
      </div>
    )
  }

  const badge = release ? RELEASE_BADGE[release.status] : null
  const canShip = Boolean(release && app.viewerCanDeploy && canPromote(release))
  const progressFor = (ticket: DeployTicket) =>
    latest.data?.items.find(d => d.ticketId === ticket.id)

  return (
    <div className="space-y-8">
      <div className="space-y-2">
        {back}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h2 className="text-lg font-semibold">
            <Version>{v(version)}</Version>
          </h2>
          {badge && (
            <span className="status-badge" data-status={badge.tone}>
              {badge.label}
            </span>
          )}
          {release && (
            <span className="text-xs text-secondary">
              tagged <Ago at={release.createdAt} /> ·{' '}
              <span className="font-mono" title={release.sha}>
                {release.sha.slice(0, 7)}
              </span>
            </span>
          )}
          <span className="ml-auto flex items-center gap-2">
            {release && <RetryReleaseButton release={release} />}
            {release && <FixInSessionButton release={release} />}
            {release && <RollbackButton release={release} />}
            {canShip && release && <ShipButton appId={app.id} release={release} />}
            {release?.approvalId && (
              <Link to={approvalPath(release.approvalId)} className="btn btn-sm btn-ghost">
                The approval
              </Link>
            )}
            {release && <ReleaseMenu release={release} />}
          </span>
        </div>
        {release?.failedStage && (
          <p className="text-sm font-medium" data-testid="failed-stage">
            Stuck at: {RELEASE_STAGE_LABELS[release.failedStage]}
          </p>
        )}
        {release?.error && <p className="text-sm text-error">{release.error}</p>}
        {release?.rolledBackFrom && (
          <p className="text-sm text-secondary" data-testid="rolled-back-from">
            Live was rolled back to this release from <Version>{v(release.rolledBackFrom)}</Version>
            .
          </p>
        )}
      </div>

      <section aria-labelledby="release-deploys-title">
        <SectionHeading id="release-deploys-title">Deploys</SectionHeading>
        {deploys.length === 0 ? (
          <p className="text-sm text-muted">Nothing has deployed {v(version)} yet.</p>
        ) : (
          <ul className="divide-y divide-base-300 border-y border-base-300">
            {deploys.map(ticket => (
              <DeployLine key={ticket.id} ticket={ticket} progress={progressFor(ticket)} />
            ))}
          </ul>
        )}
      </section>

      {release && (
        <section aria-labelledby="release-prs-title">
          <SectionHeading id="release-prs-title">Pull requests</SectionHeading>
          {release.prs.length === 0 ? (
            <p className="text-sm text-muted">No pull requests recorded on this release.</p>
          ) : (
            <ul className="space-y-1">
              {release.prs.map(pr => (
                <li key={pr.number} className="text-sm">
                  {pr.title}{' '}
                  <span className="text-xs text-muted">
                    {pr.url ? (
                      <ExternalLink href={pr.url}>#{pr.number}</ExternalLink>
                    ) : (
                      `#${pr.number}`
                    )}
                    {pr.author ? ` · ${pr.author}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {release && (
        <section aria-labelledby="release-history-title">
          <SectionHeading id="release-history-title">History</SectionHeading>
          <ReleaseChain appId={app.id} releaseId={release.id} />
        </section>
      )}
    </div>
  )
}
