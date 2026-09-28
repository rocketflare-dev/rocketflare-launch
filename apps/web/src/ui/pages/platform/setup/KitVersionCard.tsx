/**
 * The kit version every new app (and every re-scaffold) is cut from — `launch_settings.template_pin`,
 * else Launch's code default. Not a setup STEP (nothing is missing without it), so it sits after the
 * stepper's cards with no status dot.
 *
 * The admin picks a release TAG (typed, or chosen from the repo's tags) or an unreleased COMMIT (a
 * SHA, or "latest main"); the server resolves either to a full commit through GitHub and refuses
 * one the repo does not have, so the page never stores what it cannot prove. A commit pin is
 * flagged: it is for trying a kit fix before it is released.
 */
import {
  isCommitPin,
  shortSha,
  type TemplatePinRequest,
  type TemplatePinStatus,
  templatePinRequestSchema,
} from '@launch/shared/launch-setup'
import { type FormEvent, useState } from 'react'
import { FieldError } from '@/ui/components/shared'
import { useKitTags, useResetTemplatePin, useSetTemplatePin } from '@/ui/hooks/useSetup'

const HEADING_ID = 'setup-kit-version-title'

export function KitVersionCard({ templatePin }: { templatePin: TemplatePinStatus }) {
  const { pin, isDefault } = templatePin
  const setPin = useSetTemplatePin()
  const reset = useResetTemplatePin()
  const [mode, setMode] = useState<'tag' | 'commit'>('tag')
  const [tag, setTag] = useState('')
  const [commit, setCommit] = useState('')
  const [showTags, setShowTags] = useState(false)
  const [invalid, setInvalid] = useState<string | undefined>()
  const tags = useKitTags(pin.repo, showTags)
  const commitPin = isCommitPin(pin)
  const busy = setPin.isPending || reset.isPending
  const error = setPin.error ?? reset.error

  function save(body: TemplatePinRequest) {
    // The server's own schema first: a malformed tag or SHA never costs a GitHub lookup.
    const parsed = templatePinRequestSchema.safeParse(body)
    if (!parsed.success) {
      setInvalid(parsed.error.issues[0]?.message ?? 'Not a valid tag or commit')
      return
    }
    setInvalid(undefined)
    setPin.mutate(parsed.data, {
      onSuccess: () => {
        setTag('')
        setCommit('')
      },
    })
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (mode === 'tag' && tag.trim()) save({ kind: 'tag', tag: tag.trim() })
    if (mode === 'commit' && commit.trim()) save({ kind: 'commit', ref: commit.trim() })
  }

  return (
    <section
      id="setup-kit-version"
      aria-labelledby={HEADING_ID}
      className="surface-panel p-5 space-y-4 scroll-mt-6"
    >
      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 id={HEADING_ID} className="text-base font-semibold leading-6">
            Kit version
          </h2>
          <div className="text-sm text-secondary mt-0.5">
            The Rocketflare kit every new app, and every re-scaffold, is cut from. Apps already
            launched keep theirs.
          </div>
        </div>
        <span className={`badge badge-sm ${isDefault ? 'badge-ghost' : 'badge-info'}`}>
          {isDefault ? 'Default' : 'Overridden'}
        </span>
      </header>

      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted">Repository</dt>
        <dd className="font-mono text-xs leading-5">{pin.repo}</dd>
        <dt className="text-muted">Pinned to</dt>
        <dd>{pin.tag ? `Release ${pin.tag}` : 'Unreleased commit'}</dd>
        <dt className="text-muted">Commit</dt>
        <dd className="font-mono text-xs leading-5" title={pin.commit}>
          {shortSha(pin.commit)}
        </dd>
      </dl>

      {commitPin && (
        <div className="alert alert-warning text-sm" role="status">
          Unreleased commit — for development. New apps are cut from a kit commit that has no
          release; pin a release tag before creating apps people will use.
        </div>
      )}

      <form className="space-y-3" onSubmit={onSubmit}>
        <div role="radiogroup" aria-label="Pin to" className="flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="radio"
              className="radio radio-sm"
              name="kit-pin-mode"
              checked={mode === 'tag'}
              onChange={() => setMode('tag')}
            />
            A release tag
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              className="radio radio-sm"
              name="kit-pin-mode"
              checked={mode === 'commit'}
              onChange={() => setMode('commit')}
            />
            A commit (unreleased)
          </label>
        </div>

        {mode === 'tag' ? (
          <div className="space-y-1">
            <label htmlFor="kit-pin-tag" className="block text-sm font-medium">
              Release tag
            </label>
            <div className="flex flex-wrap gap-2">
              <input
                id="kit-pin-tag"
                className="input input-bordered input-sm flex-1 min-w-40 font-mono"
                placeholder={templatePin.default.tag ?? '0.15.4'}
                list="kit-pin-tags"
                value={tag}
                onChange={e => setTag(e.target.value)}
              />
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => setShowTags(true)}
                disabled={showTags && tags.isFetching}
              >
                {showTags && tags.isFetching ? 'Loading…' : 'List tags'}
              </button>
              <button type="submit" className="btn btn-sm btn-primary" disabled={busy || !tag}>
                Pin tag
              </button>
            </div>
            <datalist id="kit-pin-tags">
              {(tags.data?.tags ?? []).map(t => (
                <option key={t.name} value={t.name}>
                  {shortSha(t.commit)}
                </option>
              ))}
            </datalist>
            {showTags && tags.data && (
              <p className="text-xs text-muted">
                Tags in {tags.data.repo}:{' '}
                {tags.data.tags.length === 0
                  ? 'none'
                  : tags.data.tags
                      .slice(0, 8)
                      .map(t => t.name)
                      .join(', ')}
              </p>
            )}
            {tags.isError && (
              <p className="text-xs text-error" role="alert">
                The tags could not be listed: {tags.error.message}
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-1">
            <label htmlFor="kit-pin-commit" className="block text-sm font-medium">
              Commit SHA
            </label>
            <div className="flex flex-wrap gap-2">
              <input
                id="kit-pin-commit"
                className="input input-bordered input-sm flex-1 min-w-40 font-mono"
                placeholder="6ee75e8… (a commit on any branch)"
                value={commit}
                onChange={e => setCommit(e.target.value)}
              />
              <button type="submit" className="btn btn-sm btn-primary" disabled={busy || !commit}>
                Pin commit
              </button>
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy}
                onClick={() => save({ kind: 'commit', ref: 'main' })}
              >
                Pin latest main
              </button>
            </div>
            <p className="text-xs text-muted">
              Launch looks the commit up in {pin.repo} and pins its full SHA. For testing a kit fix
              before it is released.
            </p>
          </div>
        )}
        <FieldError message={invalid} />
      </form>

      {error && (
        <p className="text-sm text-error" role="alert">
          {error.message}
        </p>
      )}

      {!isDefault && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            disabled={busy}
            onClick={() => reset.mutate()}
          >
            Reset to default
          </button>
          <span className="text-xs text-muted">
            Launch's default is {templatePin.default.repo}{' '}
            {templatePin.default.tag ?? `@${shortSha(templatePin.default.commit)}`}.
          </span>
        </div>
      )}
    </section>
  )
}
