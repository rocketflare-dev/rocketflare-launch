/**
 * `/apps/:slug/releases` (decision 9): one row per version — what Staging and Live say about it,
 * the pull requests it carries, when it was cut — merging the releases (`useReleases`) and the
 * deploy tickets (`useDeploys`) by `releaseRows`. A deploy that belongs to no release (the default
 * branch deployed directly, a build before the first tag) gets a row of its own. A version links to
 * its release page (`/releases/:version`): the stage → deploy → history timeline.
 *
 * Launch does the kit's release dance itself (Launch P4, plan §1.8): "New release" bumps the root
 * `package.json` on the default branch and tags it (the tag starts the staging deploy); once
 * staging runs it, a row's Ship asks for production approval; an approval publishes the GitHub
 * release, which starts the Live deploy. "Deploy <branch> to Live" asks for approval to deploy the
 * default branch as it is — the way round the release flow, kept as a quiet secondary action.
 *
 * New release, Ship and the direct deploy are for the app's owners and admins (`viewerCanDeploy`,
 * the server's own rule) and hidden from everybody else. The lists poll only while something is in
 * flight (`releasesPollInterval`, `deploysPollInterval`); the `release` nudge covers the rest.
 */
import { approvalPath } from '@launch/shared/launch-approvals'
import { PRODUCTION_INTENT_TTL_MS } from '@launch/shared/launch-pipeline'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ConfirmModal, SkeletonRows, showToast } from '@/ui/components/shared'
import { useDeployProduction, useDeploys } from '@/ui/hooks/useDeploys'
import { useReleases } from '@/ui/hooks/useReleases'
import { canPromote, latestRelease } from '../components/releaseModel'
import { ShipButton } from '../components/ShipDialog'
import { releaseCell, releasePath, releaseRows, ticketRunUrl } from './appPageModel'
import { Ago, SectionHeading, Version } from './bits'
import { useAppPage } from './context'
import { NewReleaseModal } from './NewReleaseModal'

const WINDOW = 10

function Cell({ cell }: { cell: { tone: string; label: string } | null }) {
  if (!cell) return <span className="text-muted">—</span>
  return (
    <span className="status-badge" data-status={cell.tone}>
      {cell.label}
    </span>
  )
}

export default function ReleasesTab() {
  const { app, hasRepo, stage } = useAppPage()
  const enabled = hasRepo && !stage.holding
  const releases = useReleases(app.id, enabled)
  const tickets = useDeploys(app.id, enabled)
  const deployProduction = useDeployProduction(app.id)
  const navigate = useNavigate()
  const [newOpen, setNewOpen] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [showAll, setShowAll] = useState(false)

  if (!enabled) {
    return (
      <p className="text-sm text-muted">
        {stage.holding
          ? 'Releases open once the first version is live.'
          : 'Releases need the app’s GitHub repository.'}
      </p>
    )
  }

  const canRelease = app.viewerCanDeploy && app.status !== 'archived'
  const items = releases.data?.items ?? []
  const rows = releaseRows(items, tickets.data?.items ?? [])
  const shown = showAll ? rows : rows.slice(0, WINDOW)
  const branch = app.defaultBranch ?? 'the default branch'

  return (
    <section aria-labelledby="releases-title" className="space-y-3">
      <SectionHeading
        id="releases-title"
        actions={
          canRelease && (
            <>
              {app.status === 'live' && (
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() => setConfirmOpen(true)}
                  disabled={deployProduction.isPending}
                >
                  Deploy {branch} to Live…
                </button>
              )}
              <button type="button" className="btn btn-sm" onClick={() => setNewOpen(true)}>
                New release
              </button>
            </>
          )
        }
      >
        Releases
      </SectionHeading>

      {releases.isLoading || tickets.isLoading ? (
        <SkeletonRows rows={3} />
      ) : releases.isError ? (
        <p className="text-sm text-error" role="alert">
          Releases could not be loaded.
        </p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted">
          {canRelease
            ? 'No releases yet. Cut the first one when the default branch is ready for staging.'
            : 'No releases yet. An owner of this app cuts them.'}
        </p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="data-table" aria-label="Releases">
              <thead>
                <tr>
                  <th>Version</th>
                  <th>Staging</th>
                  <th>Live</th>
                  <th>Changes</th>
                  <th>When</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map(row => {
                  const release = row.release
                  const ticket = row.production ?? row.staging
                  const run = ticket ? ticketRunUrl(ticket) : null
                  const problem =
                    release?.error ??
                    (ticket?.refused?.length
                      ? `Refused: ${ticket.refused.join(', ')}`
                      : (ticket?.error ?? null))
                  return (
                    <tr key={row.key}>
                      <td>
                        {release ? (
                          <Link
                            to={releasePath(app.slug, release.version)}
                            className="link link-hover"
                            title={release.sha}
                          >
                            <Version>{row.label}</Version>
                          </Link>
                        ) : run ? (
                          <a
                            href={run}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="link link-hover"
                            title={ticket?.sha ?? undefined}
                          >
                            <Version>{row.label}</Version>
                          </a>
                        ) : (
                          <Version title={ticket?.sha ?? undefined}>{row.label}</Version>
                        )}
                        {problem && (
                          <p className="text-xs text-error max-w-[20rem] truncate" title={problem}>
                            {problem}
                          </p>
                        )}
                      </td>
                      <td>
                        <Cell cell={releaseCell(row, 'staging')} />
                      </td>
                      <td>
                        <Cell cell={releaseCell(row, 'production')} />
                      </td>
                      <td className="text-secondary text-sm tabular-nums">
                        {release ? release.prs.length : '—'}
                      </td>
                      <td className="text-secondary text-sm whitespace-nowrap">
                        <Ago at={row.at} />
                      </td>
                      <td className="text-right whitespace-nowrap">
                        {release && canRelease && canPromote(release) ? (
                          <ShipButton appId={app.id} release={release} />
                        ) : release?.approvalId ? (
                          <Link
                            to={approvalPath(release.approvalId)}
                            className="link link-hover text-xs"
                          >
                            Approval
                          </Link>
                        ) : ticket?.approvalId && ticket.status === 'pending' ? (
                          <Link
                            to={approvalPath(ticket.approvalId)}
                            className="link link-hover text-xs"
                          >
                            Approval
                          </Link>
                        ) : null}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {rows.length > WINDOW && !showAll && (
            <button type="button" className="btn btn-ghost btn-xs" onClick={() => setShowAll(true)}>
              Show {rows.length - WINDOW} earlier
            </button>
          )}
        </>
      )}

      {newOpen && (
        <NewReleaseModal
          appId={app.id}
          latest={latestRelease(items)}
          open={newOpen}
          onClose={() => setNewOpen(false)}
        />
      )}

      <ConfirmModal
        isOpen={confirmOpen}
        title={`Deploy ${branch} to Live?`}
        message={
          <div className="space-y-2">
            <p>
              Launch asks this app’s approvers to deploy {branch} to Live as it is. Once someone
              other than you approves, it starts the repository’s deploy workflow, which runs the
              full gate first — nothing changes if that fails.
            </p>
            <p className="text-secondary text-sm">
              To ship a tested version instead, ship a release that staging is running.
            </p>
          </div>
        }
        confirmText="Request approval"
        isLoading={deployProduction.isPending}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() =>
          deployProduction.mutate(undefined, {
            onSuccess: ({ ticket, approvalId }) => {
              setConfirmOpen(false)
              if (approvalId && !ticket) {
                showToast('Live deploy requested — waiting for approval', 'success')
                navigate(approvalPath(approvalId))
              } else {
                showToast(
                  `Live deploy started — approved for ${Math.round(PRODUCTION_INTENT_TTL_MS / 60_000)} minutes`,
                  'success'
                )
              }
            },
          })
        }
      />
    </section>
  )
}
