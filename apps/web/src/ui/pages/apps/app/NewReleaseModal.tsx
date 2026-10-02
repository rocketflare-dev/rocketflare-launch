/**
 * "New release" (Launch P4, plan §1.8): pick the bump — patch by default — and Launch bumps the
 * version on the default branch, tags it and lists the pull requests merged since the last tag.
 * The tag deploys to staging; Live waits for Ship and its approval. The version shown is only a
 * preview (`nextVersion`): the server reads `package.json`.
 */
import { RELEASE_BUMPS, type Release, type ReleaseBump } from '@launch/shared/launch-releases'
import { useState } from 'react'
import { Modal, showToast } from '@/ui/components/shared'
import { useCreateRelease } from '@/ui/hooks/useReleases'
import { nextVersion } from '../components/releaseModel'

const BUMP_HELP: Record<ReleaseBump, string> = {
  patch: 'Fixes only',
  minor: 'New features, nothing breaks',
  major: 'Breaking changes',
}

export function NewReleaseModal({
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
          tag deploys to staging; Live waits for an approval.
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
