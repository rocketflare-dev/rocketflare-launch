/**
 * An app's releases (Launch P4, plan §1.8): Launch does the kit's release dance itself. "New
 * release" bumps the root `package.json` on the default branch and tags it (the tag starts the
 * staging deploy); once staging runs it, "Promote" asks for production approval; an approval
 * publishes the GitHub release, which starts the production deploy.
 *
 * - Each row's status follows that lifecycle; one awaiting approval links to its request.
 * - Each row expands to its whole chain (`ReleaseChain`) — PRs, tag, deploys, approval — read only
 *   when opened.
 * - New release and Promote are for the app's owners and admins (`viewerCanDeploy`, the server's
 *   own rule); everybody else reads the list.
 * - The list polls only while a release is in flight (`releasesPollInterval`); the `release` nudge
 *   covers the rest.
 */
import {
  ChevronDownIcon,
  ChevronRightIcon,
  ShieldExclamationIcon,
  TagIcon,
} from '@heroicons/react/24/outline'
import { approvalPath } from '@launch/shared/launch-approvals'
import { RELEASE_BUMPS, type Release, type ReleaseBump } from '@launch/shared/launch-releases'
import { Fragment, useState } from 'react'
import { Link } from 'react-router-dom'
import { EmptyState, Modal, SectionPanel, SkeletonRows, showToast } from '@/ui/components/shared'
import { useCreateRelease, useReleases } from '@/ui/hooks/useReleases'
import { formatDateTime, timeAgo } from '@/ui/lib/format'
import { PromoteButton } from './PromoteButton'
import { ReleaseChain } from './ReleaseChain'
import { canPromote, latestRelease, nextVersion, RELEASE_BADGE } from './releaseModel'

const WINDOW = 6

const BUMP_HELP: Record<ReleaseBump, string> = {
  patch: 'Fixes only',
  minor: 'New features, nothing breaks',
  major: 'Breaking changes',
}

function NewReleaseModal({
  appId,
  latest,
  open,
  onClose,
}: {
  appId: string
  latest: Release | null
  open: boolean
  onClose: () => void
}) {
  const [bump, setBump] = useState<ReleaseBump>('patch')
  const create = useCreateRelease(appId)
  const preview = nextVersion(latest?.version, bump)

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Cut a new release"
      actions={
        <>
          <button type="button" className="btn btn-sm" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={create.isPending}
            onClick={() =>
              create.mutate(
                { bump },
                {
                  onSuccess: release => {
                    showToast(`Tagged ${release.version} — staging deploys it next`, 'success')
                    onClose()
                  },
                }
              )
            }
          >
            {create.isPending ? (
              <span className="loading loading-spinner loading-xs" />
            ) : preview ? (
              `Release ${preview}`
            ) : (
              'Release'
            )}
          </button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <p>
          Launch bumps the version on the default branch, tags it, and lists the pull requests
          merged since{' '}
          {latest ? <span className="font-mono text-xs">{latest.tag}</span> : 'the last tag'}. The
          tag deploys to staging; production waits for an approval.
        </p>
        <fieldset className="space-y-1.5">
          <legend className="text-xs text-muted mb-1">What kind of release</legend>
          {RELEASE_BUMPS.map(option => {
            const version = nextVersion(latest?.version, option)
            return (
              <label key={option} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="release-bump"
                  className="radio radio-sm"
                  checked={bump === option}
                  onChange={() => setBump(option)}
                />
                <span className="capitalize font-medium">{option}</span>
                <span className="text-muted">— {BUMP_HELP[option]}</span>
                {version && <span className="font-mono text-xs ml-auto">{version}</span>}
              </label>
            )
          })}
        </fieldset>
      </div>
    </Modal>
  )
}

export function ReleasesCard({ appId, canRelease }: { appId: string; canRelease: boolean }) {
  const { data, isLoading, isError } = useReleases(appId)
  const [newOpen, setNewOpen] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)
  const items = data?.items ?? []
  const shown = showAll ? items : items.slice(0, WINDOW)

  return (
    <SectionPanel
      title="Releases"
      description="Tag a version, check it on staging, then promote it to production with an approval."
      actions={
        canRelease && (
          <button type="button" className="btn btn-sm gap-1.5" onClick={() => setNewOpen(true)}>
            <TagIcon className="w-4 h-4" />
            New release
          </button>
        )
      }
    >
      {isLoading ? (
        <SkeletonRows rows={3} />
      ) : isError ? (
        <p className="text-sm text-error" role="alert">
          Releases could not be loaded.
        </p>
      ) : items.length === 0 ? (
        <EmptyState
          icon={TagIcon}
          size="sm"
          message="No releases yet"
          description={
            canRelease
              ? 'Cut the first one when the default branch is ready for staging.'
              : 'An owner of this app cuts releases.'
          }
        />
      ) : (
        <>
          <div className="overflow-x-auto -mx-1">
            <table className="data-table" aria-label="Releases">
              <thead>
                <tr>
                  <th className="w-8">
                    <span className="sr-only">History</span>
                  </th>
                  <th>Version</th>
                  <th>Status</th>
                  <th>Pull requests</th>
                  <th>Tagged</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map(release => {
                  const badge = RELEASE_BADGE[release.status]
                  const expanded = openId === release.id
                  return (
                    <Fragment key={release.id}>
                      <tr>
                        <td>
                          <button
                            type="button"
                            className="btn btn-ghost btn-xs btn-square"
                            aria-expanded={expanded}
                            aria-label={`History of ${release.version}`}
                            onClick={() => setOpenId(expanded ? null : release.id)}
                          >
                            {expanded ? (
                              <ChevronDownIcon className="w-3.5 h-3.5" />
                            ) : (
                              <ChevronRightIcon className="w-3.5 h-3.5" />
                            )}
                          </button>
                        </td>
                        <td className="font-mono text-xs" title={release.sha}>
                          {release.version}
                        </td>
                        <td>
                          <span className="status-badge" data-status={badge.tone}>
                            {badge.label}
                          </span>
                          {release.error && (
                            <p
                              className="text-xs text-error mt-1 max-w-[20rem] truncate"
                              title={release.error}
                            >
                              {release.error}
                            </p>
                          )}
                        </td>
                        <td className="text-secondary text-sm tabular-nums">
                          {release.prs.length}
                        </td>
                        <td
                          className="text-secondary text-sm whitespace-nowrap"
                          title={formatDateTime(release.createdAt)}
                        >
                          {timeAgo(release.createdAt)}
                        </td>
                        <td className="text-right whitespace-nowrap">
                          {canRelease && canPromote(release) ? (
                            <PromoteButton appId={appId} release={release} />
                          ) : release.approvalId && release.status === 'awaiting_approval' ? (
                            <Link
                              to={approvalPath(release.approvalId)}
                              className="btn btn-xs btn-ghost gap-1"
                            >
                              <ShieldExclamationIcon className="w-3.5 h-3.5 text-warning" />
                              Approval
                            </Link>
                          ) : release.approvalId ? (
                            <Link
                              to={approvalPath(release.approvalId)}
                              className="link link-hover text-xs"
                            >
                              Approval
                            </Link>
                          ) : null}
                        </td>
                      </tr>
                      {expanded && (
                        <tr>
                          <td />
                          <td colSpan={5} className="pb-4">
                            <ReleaseChain appId={appId} releaseId={release.id} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
          {items.length > WINDOW && !showAll && (
            <button
              type="button"
              className="btn btn-ghost btn-xs mt-2"
              onClick={() => setShowAll(true)}
            >
              Show {items.length - WINDOW} earlier
            </button>
          )}
        </>
      )}

      {newOpen && (
        <NewReleaseModal
          appId={appId}
          latest={latestRelease(items)}
          open={newOpen}
          onClose={() => setNewOpen(false)}
        />
      )}
    </SectionPanel>
  )
}
