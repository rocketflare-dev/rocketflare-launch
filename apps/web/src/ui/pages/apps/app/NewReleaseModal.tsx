/**
 * "New release" (Launch P4, plan §1.8): pick the bump — patch by default — and Launch bumps the
 * version on the default branch, tags it and lists the pull requests merged since the last tag.
 * The tag deploys to staging; Live waits for Ship and its approval. The version shown is only a
 * preview (`nextVersion`): the server reads `package.json`.
 *
 * App page P3: the Overview's "Release to staging" opens it with the main-ahead compare, so the
 * dialog lists the commits the release will carry.
 */
import {
  RELEASE_BUMPS,
  type Release,
  type ReleaseBump,
  type ReleaseCompare,
} from '@launch/shared/launch-releases'
import { useState } from 'react'
import { Modal, showToast } from '@/ui/components/shared'
import { useCreateRelease } from '@/ui/hooks/useReleases'
import { nextVersion } from '../components/releaseModel'

const BUMP_HELP: Record<ReleaseBump, string> = {
  patch: 'Fixes only',
  minor: 'New features, nothing breaks',
  major: 'Breaking changes',
}

/** At most this many of the compare's commits are listed in the dialog. */
const COMMITS_SHOWN = 8

export function NewReleaseModal({
  appId,
  latest,
  open,
  onClose,
  title = 'Cut a new release',
  compare = null,
}: {
  appId: string
  latest: Release | null
  open: boolean
  onClose: () => void
  title?: string
  /** The main-ahead compare (app page P3): its commits are what the release carries. */
  compare?: ReleaseCompare | null
}) {
  const [bump, setBump] = useState<ReleaseBump>('patch')
  const create = useCreateRelease(appId)
  const preview = nextVersion(latest?.version, bump)

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
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
          tag deploys to staging; Live waits for an approval.
        </p>
        {compare?.aheadBy ? (
          <div>
            <p className="text-xs text-muted mb-1">
              <span className="tabular-nums">{compare.aheadBy}</span> commit
              {compare.aheadBy === 1 ? '' : 's'} on {compare.branch} since{' '}
              <span className="font-mono">{compare.base}</span>
            </p>
            <ul className="space-y-1" aria-label="Commits in this release">
              {compare.commits.slice(0, COMMITS_SHOWN).map(item => (
                <li key={item.sha} className="flex gap-2 min-w-0">
                  <span className="font-mono text-xs text-muted shrink-0">
                    {item.sha.slice(0, 7)}
                  </span>
                  <span className="truncate">{item.message}</span>
                  {item.prNumber && (
                    <span className="text-xs text-muted shrink-0 tabular-nums">
                      #{item.prNumber}
                    </span>
                  )}
                </li>
              ))}
            </ul>
            {compare.aheadBy > COMMITS_SHOWN && (
              <p className="text-xs text-muted mt-1">
                and <span className="tabular-nums">{compare.aheadBy - COMMITS_SHOWN}</span> more
              </p>
            )}
          </div>
        ) : null}
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
