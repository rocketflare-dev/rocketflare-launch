/**
 * The kit version every new app (and every re-scaffold) is cut from — `launch_settings.template_pin`,
 * else Launch's code default. Settings → Kit version.
 *
 * Three ways to pin it, each resolved by the SERVER through GitHub (it refuses what the repo does
 * not have, so the page never stores what it cannot prove):
 *
 * - **Follow latest** — the kit's newest release (highest `X.Y.Z` tag, pre-releases never). Launch
 *   re-checks hourly and moves the pin when a newer release appears; apps already launched are not
 *   upgraded, they show as behind. "Check now" runs the same refresh.
 * - **A release tag** — typed, or picked from the repo's tags (newest first) in a combobox; a tag
 *   not in the list is still sent and the server looks it up.
 * - **A commit (unreleased)** — a SHA, or "latest main"; flagged, it is for trying a kit fix
 *   before it is released.
 */
import {
  isCommitPin,
  isFollowLatestPin,
  shortSha,
  type TemplatePinRequest,
  type TemplatePinStatus,
  templatePinRequestSchema,
} from '@launch/shared/launch-setup'
import { type FormEvent, useState } from 'react'
import { Combobox } from '@/ui/components/Combobox'
import { FieldError } from '@/ui/components/shared'
import {
  useCheckLatestKit,
  useKitTags,
  useResetTemplatePin,
  useSetTemplatePin,
} from '@/ui/hooks/useSetup'
import { formatDateTime, timeAgo } from '@/ui/lib/format'

const HEADING_ID = 'kit-version-title'

type Mode = 'latest' | 'tag' | 'commit'

function modeOf(pin: TemplatePinStatus['pin']): Mode {
  if (isFollowLatestPin(pin)) return 'latest'
  return isCommitPin(pin) ? 'commit' : 'tag'
}

export function KitVersionCard({ templatePin }: { templatePin: TemplatePinStatus }) {
  const { pin, isDefault, latestCheck } = templatePin
  const setPin = useSetTemplatePin()
  const reset = useResetTemplatePin()
  const checkNow = useCheckLatestKit()
  const [mode, setMode] = useState<Mode>(() => modeOf(pin))
  const [tag, setTag] = useState('')
  const [commit, setCommit] = useState('')
  const [loadTags, setLoadTags] = useState(false)
  const [invalid, setInvalid] = useState<string | undefined>()
  const tags = useKitTags(pin.repo, loadTags)
  const following = isFollowLatestPin(pin)
  const commitPin = isCommitPin(pin)
  const busy = setPin.isPending || reset.isPending || checkNow.isPending
  const error = setPin.error ?? reset.error ?? checkNow.error
  const check = latestCheck && latestCheck.repo === pin.repo ? latestCheck : null

  function save(body: TemplatePinRequest) {
    // The server's own schema first: a malformed tag or SHA never costs a GitHub lookup.
    const parsed = templatePinRequestSchema.safeParse(body)
    if (!parsed.success) {
      setInvalid(parsed.error.issues[0]?.message ?? 'Not a valid tag or commit')
      return
    }
    setInvalid(undefined)
    checkNow.reset()
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

  const pinnedTo = following
    ? `Latest release, now ${pin.tag}`
    : pin.tag
      ? `Release ${pin.tag}`
      : 'Unreleased commit'

  return (
    <section
      id="kit-version"
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
            launched keep theirs until they are upgraded.
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
        <dd>{pinnedTo}</dd>
        <dt className="text-muted">Commit</dt>
        <dd className="font-mono text-xs leading-5" title={pin.commit}>
          {shortSha(pin.commit)}
        </dd>
        {following && (
          <>
            <dt className="text-muted">Checked</dt>
            <dd>
              {check ? (
                <time
                  dateTime={check.checkedAt.toISOString()}
                  title={formatDateTime(check.checkedAt)}
                >
                  {timeAgo(check.checkedAt)}
                </time>
              ) : (
                'Not yet'
              )}
            </dd>
            <dt className="text-muted">Latest</dt>
            <dd>{check?.latest ?? pin.tag}</dd>
          </>
        )}
      </dl>

      {following && check?.error && (
        <p className="text-sm text-error" role="alert">
          The last check failed: {check.error}. Launch tries again within five minutes.
        </p>
      )}

      {commitPin && (
        <div className="alert alert-warning text-sm" role="status">
          Unreleased commit — for development. New apps are cut from a kit commit that has no
          release; pin a release tag before creating apps people will use.
        </div>
      )}

      <form className="space-y-3" onSubmit={onSubmit}>
        <div role="radiogroup" aria-label="Pin to" className="flex flex-wrap gap-4 text-sm">
          {(
            [
              ['latest', 'Follow latest'],
              ['tag', 'A release tag'],
              ['commit', 'A commit (unreleased)'],
            ] as const
          ).map(([value, label]) => (
            <label key={value} className="flex items-center gap-2">
              <input
                type="radio"
                className="radio radio-sm"
                name="kit-pin-mode"
                checked={mode === value}
                onChange={() => {
                  setMode(value)
                  setInvalid(undefined)
                }}
              />
              {label}
            </label>
          ))}
        </div>

        {mode === 'latest' && (
          <div className="space-y-2">
            <p className="text-sm text-secondary">
              New apps use the kit's newest release. Launch checks {pin.repo} every hour and moves
              the pin when a newer release appears. Apps already launched are not upgraded: they
              show as behind, and their upgrade is offered as usual.
            </p>
            {following ? (
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy}
                onClick={() => {
                  setPin.reset()
                  checkNow.mutate()
                }}
              >
                {checkNow.isPending ? 'Checking…' : 'Check now'}
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={busy}
                onClick={() => save({ kind: 'latest' })}
              >
                Follow latest
              </button>
            )}
          </div>
        )}

        {mode === 'tag' && (
          <div className="space-y-1">
            <label htmlFor="kit-pin-tag" className="block text-sm font-medium">
              Release tag
            </label>
            <div className="flex flex-wrap items-start gap-2">
              <Combobox
                id="kit-pin-tag"
                className="flex-1 min-w-40"
                inputClassName="font-mono"
                placeholder={tags.data?.latest ?? templatePin.default.tag ?? '0.16.0'}
                value={tag}
                onChange={setTag}
                onOpenChange={open => {
                  if (open) setLoadTags(true)
                }}
                options={(tags.data?.tags ?? []).map(t => ({
                  value: t.name,
                  description: t.name === tags.data?.latest ? 'latest' : shortSha(t.commit),
                }))}
                loading={tags.isFetching}
                emptyMessage={tags.isError ? 'The tags could not be listed' : 'No matching tags'}
                aria-describedby="kit-pin-tag-hint"
              />
              <button type="submit" className="btn btn-sm btn-primary" disabled={busy || !tag}>
                Pin tag
              </button>
            </div>
            <p id="kit-pin-tag-hint" className="text-xs text-muted">
              Type to filter the tags in {pin.repo}, newest first. A tag not listed can be typed;
              Launch looks it up.
            </p>
            {tags.isError && (
              <p className="text-xs text-error" role="alert">
                The tags could not be listed: {tags.error.message}
              </p>
            )}
          </div>
        )}

        {mode === 'commit' && (
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
