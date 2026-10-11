/**
 * The pieces Settings → Kits' list (`KitList`) and a kit's page (`KitDetail`) share (D36 K1, K3,
 * K5): the status a row reads in one word, the version in tabular mono, the pin editor, the
 * scaffold-check line, and the ⋯ menu's actions. The pure helpers are tested in
 * `tests/ui/setup-page.test.tsx`.
 *
 * **Pinning** goes through `PUT /api/platform/kits/:id/pin` for every kit, the default included —
 * the server checks the kit at the new pin and mirrors the default kit's into `template_pin`. The
 * Follow latest's Check now (the cron's hourly refresh on demand) is `POST /:id/latest` for every
 * kit; the default kit alone keeps one template-pin extra, the built-in Rocketflare kit's Reset to
 * Launch's default.
 */
import {
  type Kit,
  type KitDynamicCheck,
  type KitPinRequest,
  kitPinRequestSchema,
} from '@launch/shared/kits'
import { isCommitPin, isFollowLatestPin, shortSha } from '@launch/shared/launch-setup'
import { type FormEvent, type ReactNode, useId, useState } from 'react'
import { Combobox } from '@/ui/components/Combobox'
import { ConfirmModal, FieldError } from '@/ui/components/shared'
import {
  kitCheckRunning,
  useCheckKit,
  useCheckKitLatest,
  useMakeDefaultKit,
  usePinKit,
  useRemoveKit,
} from '@/ui/hooks/useKits'
import { useKitTags } from '@/ui/hooks/useSetup'
import { formatDateTime } from '@/ui/lib/format'
import { Ago, ExternalLink, type MenuItem, StateDot } from '@/ui/pages/apps/app/bits'

// ---- words (pure) ---------------------------------------------------------------------------------

export type KitTone = 'success' | 'error' | 'muted' | 'running'

/**
 * A kit's state in one word: a scaffold check running (spinner), Checking, Verified, Failed or
 * Not checked. Pure.
 */
export function kitStatus(kit: Pick<Kit, 'status' | 'dynamicCheck'>): {
  label: string
  tone: KitTone
} {
  const dynamic = kit.dynamicCheck?.status
  if (dynamic === 'queued' || dynamic === 'running') {
    return { label: 'Scaffold check running', tone: 'running' }
  }
  if (kit.status === 'checking') return { label: 'Checking', tone: 'running' }
  if (kit.status === 'verified') return { label: 'Verified', tone: 'success' }
  if (kit.status === 'failed') return { label: 'Failed', tone: 'error' }
  return { label: 'Not checked', tone: 'muted' }
}

/** The version a kit is pinned to, and the one quiet fact about how. Pure. */
export function kitVersion(kit: Pick<Kit, 'pin' | 'pinIsCodeDefault'>): {
  version: string
  note: string | null
  unreleased: boolean
} {
  const unreleased = isCommitPin(kit.pin)
  const version = kit.pin.tag ?? shortSha(kit.pin.commit)
  if (isFollowLatestPin(kit.pin)) return { version, note: 'Follows latest', unreleased }
  if (unreleased) return { version, note: 'Unreleased commit', unreleased }
  return { version, note: kit.pinIsCodeDefault ? "Launch's default" : null, unreleased }
}

/** "Pinned to" in words, for a kit's page. Pure. */
export function pinnedToText(kit: Pick<Kit, 'pin' | 'pinIsCodeDefault'>): string {
  if (isFollowLatestPin(kit.pin)) return `Latest release, now ${kit.pin.tag}`
  if (!kit.pin.tag) return 'Unreleased commit'
  return kit.pinIsCodeDefault
    ? `Release ${kit.pin.tag}, Launch's default`
    : `Release ${kit.pin.tag}`
}

const DYNAMIC_RESULT: Record<KitDynamicCheck['status'], { text: string; tone: KitTone }> = {
  queued: { text: 'Queued', tone: 'running' },
  running: { text: 'Running', tone: 'running' },
  passed: { text: 'Passed', tone: 'success' },
  failed: { text: 'Failed', tone: 'error' },
}

/** What became of a scaffold check's throwaway repo, or null when there is nothing to say. Pure. */
export function cleanupText(
  check: Pick<KitDynamicCheck, 'status' | 'repo' | 'cleanup'>
): string | null {
  const repo = check.repo
  if (check.cleanup === 'deleted') return 'Its test repo was deleted.'
  if (check.cleanup === 'archived') {
    return `Its test repo ${repo ?? ''} was archived: the GitHub App may not delete repositories, so delete it by hand.`
  }
  if (check.cleanup === 'failed') {
    return `Its test repo ${repo ?? ''} could not be removed: delete it by hand.`
  }
  if (repo && (check.status === 'queued' || check.status === 'running')) {
    return `Running in ${repo}, removed when it finishes.`
  }
  return null
}

/** Why a kit cannot be removed, or null when it can. Pure. */
export function removeBlocker(kit: Pick<Kit, 'isDefault' | 'appCount' | 'name'>): string | null {
  if (kit.isDefault) return 'The default kit cannot be removed: make another kit the default first.'
  if (kit.appCount > 0) {
    return `${kit.appCount} app${kit.appCount === 1 ? ' was' : 's were'} made from ${kit.name}, and an app keeps its kit for life.`
  }
  return null
}

export type PinMode = 'latest' | 'tag' | 'commit'

export function pinModeOf(pin: Kit['pin']): PinMode {
  if (isFollowLatestPin(pin)) return 'latest'
  return isCommitPin(pin) ? 'commit' : 'tag'
}

/** The pin request a mode and its typed value make, or null while the value is missing. Pure. */
export function pinRequestOf(mode: PinMode, value: string): KitPinRequest | null {
  const typed = value.trim()
  if (mode === 'latest') return { kind: 'latest' }
  if (!typed) return null
  return mode === 'tag' ? { kind: 'tag', tag: typed } : { kind: 'commit', ref: typed }
}

/** What to say when a tag or commit mode is submitted empty. */
export const MISSING_REF: Record<Exclude<PinMode, 'latest'>, string> = {
  tag: 'Type the release tag',
  commit: 'Type a commit SHA or a branch',
}

// ---- small pieces ---------------------------------------------------------------------------------

function ToneDot({ tone }: { tone: KitTone }) {
  if (tone === 'running') {
    return <span className="loading loading-spinner loading-xs text-info" aria-hidden="true" />
  }
  return <StateDot tone={tone} />
}

/** The kit's status: a coloured dot (a spinner while running) and the word. */
export function KitStatus({ kit }: { kit: Kit }) {
  const { label, tone } = kitStatus(kit)
  const checked = kit.checkedAt ? `Checked ${formatDateTime(kit.checkedAt)}` : 'Never checked'
  return (
    <span
      className="inline-flex items-center gap-1.5 text-sm whitespace-nowrap"
      data-status={tone}
      title={checked}
    >
      <ToneDot tone={tone} />
      <span className={tone === 'error' ? 'text-error' : 'text-secondary'}>{label}</span>
    </span>
  )
}

/** "Default", quietly, beside a kit's name. */
export function DefaultLabel() {
  return <span className="text-xs font-normal text-muted">Default</span>
}

/** The last scaffold (dynamic) check: result, commit, when, its run, and its test repo. */
export function DynamicCheckLine({ check }: { check: KitDynamicCheck }) {
  const result = DYNAMIC_RESULT[check.status]
  const running = check.status === 'queued' || check.status === 'running'
  const cleanup = cleanupText(check)
  return (
    <div className="space-y-0.5" role="group" aria-label="Last scaffold check">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
        <span className="inline-flex items-center gap-1.5">
          <ToneDot tone={result.tone} />
          <span className={result.tone === 'error' ? 'text-error' : undefined}>
            Scaffold check {result.text.toLowerCase()}
          </span>
        </span>
        <span className="text-muted">
          at <span className="font-mono tabular-nums">{shortSha(check.commit)}</span>,{' '}
          {running ? (
            <>
              started <Ago at={check.startedAt} />
            </>
          ) : (
            <Ago at={check.finishedAt ?? check.startedAt} />
          )}
        </span>
        {check.runUrl && <ExternalLink href={check.runUrl}>View run</ExternalLink>}
      </div>
      {cleanup && <p className="text-xs text-muted">{cleanup}</p>}
      {check.status === 'failed' && check.problems.length > 0 && (
        <ProblemList problems={check.problems} />
      )}
    </div>
  )
}

export function ProblemList({ problems, label }: { problems: readonly string[]; label?: string }) {
  return (
    <ul className="text-xs text-error list-disc pl-5 space-y-0.5" aria-label={label}>
      {problems.map(p => (
        <li key={p}>{p}</li>
      ))}
    </ul>
  )
}

/** The "also run the scaffold check" checkbox the pin editor and Add share. */
export function DynamicOption({
  checked,
  onChange,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <label className="flex items-start gap-2 text-sm">
      <input
        type="checkbox"
        className="checkbox checkbox-sm mt-0.5"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
      />
      <span>
        Also run the scaffold check
        <span className="block text-xs text-muted">
          A few minutes against a throwaway repo; the kit is offered once it passes.
        </span>
      </span>
    </label>
  )
}

const PIN_MODES: readonly (readonly [PinMode, string])[] = [
  ['latest', 'Follow latest'],
  ['tag', 'A release tag'],
  ['commit', 'A commit (unreleased)'],
]

/**
 * The three ways to pin a kit — the mode's radios and, for a tag or a commit, its field. The tag
 * field lists the repo's tags (newest first) once it is opened, when the repo is known.
 */
export function PinModeFields({
  mode,
  onMode,
  value,
  onValue,
  repo,
  actions,
}: {
  mode: PinMode
  onMode: (mode: PinMode) => void
  value: string
  onValue: (value: string) => void
  repo: string | null
  /** Buttons beside the field (the pin editor's submit). */
  actions?: ReactNode
}) {
  const name = useId()
  const fieldId = useId()
  const [loadTags, setLoadTags] = useState(false)
  const tags = useKitTags(repo ?? '', loadTags && Boolean(repo))
  return (
    <div className="space-y-3">
      <div role="radiogroup" aria-label="Pin to" className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
        {PIN_MODES.map(([option, label]) => (
          <label key={option} className="flex items-center gap-2">
            <input
              type="radio"
              className="radio radio-sm"
              name={name}
              checked={mode === option}
              onChange={() => onMode(option)}
            />
            {label}
          </label>
        ))}
      </div>
      {mode === 'latest' && (
        <div className="space-y-2">
          <p className="text-xs text-muted">
            The newest release. Launch looks for a newer one every hour; apps already made keep
            theirs.
          </p>
          {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
        </div>
      )}
      {mode !== 'latest' && (
        <div className="space-y-1">
          <label htmlFor={fieldId} className="block text-sm font-medium text-base-content">
            {mode === 'tag' ? 'Release tag' : 'Commit or branch'}
          </label>
          <div className="flex flex-wrap items-start gap-2">
            {mode === 'tag' && repo ? (
              <Combobox
                id={fieldId}
                className="flex-1 min-w-40"
                inputClassName="font-mono"
                placeholder={tags.data?.latest ?? '1.0.0'}
                value={value}
                onChange={onValue}
                onOpenChange={open => {
                  if (open) setLoadTags(true)
                }}
                options={(tags.data?.tags ?? []).map(t => ({
                  value: t.name,
                  description: t.name === tags.data?.latest ? 'latest' : shortSha(t.commit),
                }))}
                loading={tags.isFetching}
                emptyMessage={tags.isError ? 'The tags could not be listed' : 'No matching tags'}
              />
            ) : (
              <input
                id={fieldId}
                className="input input-bordered input-sm flex-1 min-w-40 font-mono"
                placeholder={mode === 'tag' ? '1.0.0' : 'a commit SHA, or main'}
                value={value}
                onChange={e => onValue(e.target.value)}
              />
            )}
            {actions}
          </div>
          <p className="text-xs text-muted">
            {mode === 'tag'
              ? 'Pick from the repo’s tags, or type one: Launch looks it up.'
              : 'For trying a kit fix before it is released.'}
          </p>
        </div>
      )}
    </div>
  )
}

// ---- the pin editor -------------------------------------------------------------------------------

/**
 * Re-pin a kit: Follow latest, a release tag, or a commit or branch — resolved and checked by the
 * server before it is stored (a malformed ref never leaves: the server's own schema first). A kit
 * following latest also gets Check now.
 */
export function PinForm({ kit, onDone }: { kit: Kit; onDone?: () => void }) {
  const pin = usePinKit()
  const checkNow = useCheckKitLatest()
  const following = isFollowLatestPin(kit.pin)
  const [mode, setMode] = useState<PinMode>(() => pinModeOf(kit.pin))
  const [value, setValue] = useState('')
  const [dynamic, setDynamic] = useState(false)
  const [invalid, setInvalid] = useState<string>()
  const busy = pin.isPending || checkNow.isPending
  const error = pin.error ?? checkNow.error

  function save(request: KitPinRequest | null) {
    if (!request) {
      setInvalid(mode === 'latest' ? undefined : MISSING_REF[mode])
      return
    }
    const parsed = kitPinRequestSchema.safeParse(request)
    if (!parsed.success) {
      setInvalid(parsed.error.issues[0]?.message ?? 'Not a valid tag or commit')
      return
    }
    setInvalid(undefined)
    checkNow.reset()
    pin.mutate(
      { id: kit.id, pin: parsed.data, dynamic },
      {
        onSuccess: () => {
          setValue('')
          onDone?.()
        },
      }
    )
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    save(pinRequestOf(mode, value))
  }

  const submitLabel =
    mode === 'latest' ? 'Follow latest' : mode === 'tag' ? 'Pin tag' : 'Pin commit'
  const showSubmit = !(mode === 'latest' && following)
  const actions = (
    <>
      {showSubmit && (
        <button type="submit" className="btn btn-sm btn-primary" disabled={busy}>
          {pin.isPending ? 'Checking…' : submitLabel}
        </button>
      )}
      {mode === 'commit' && (
        <button
          type="button"
          className="btn btn-sm btn-outline"
          disabled={busy}
          onClick={() => save({ kind: 'commit', ref: 'main' })}
        >
          Pin latest main
        </button>
      )}
      {mode === 'latest' && following && (
        <button
          type="button"
          className="btn btn-sm btn-outline"
          disabled={busy}
          title="Look for a newer release now"
          onClick={() => {
            pin.reset()
            checkNow.mutate(kit.id)
          }}
        >
          {checkNow.isPending ? 'Checking…' : 'Check now'}
        </button>
      )}
    </>
  )

  return (
    <form className="space-y-3" onSubmit={onSubmit} aria-label={`Re-pin ${kit.name}`} noValidate>
      <PinModeFields
        mode={mode}
        onMode={next => {
          setMode(next)
          setInvalid(undefined)
        }}
        value={value}
        onValue={setValue}
        repo={kit.repo}
        actions={actions}
      />
      <FieldError message={invalid} />
      {showSubmit && <DynamicOption checked={dynamic} onChange={setDynamic} />}
      {error && (
        <p className="text-xs text-error" role="alert">
          {error.message}
        </p>
      )}
    </form>
  )
}

// ---- the ⋯ menu -----------------------------------------------------------------------------------

/**
 * A kit's secondary actions, for its row and its page: Run the scaffold check, Re-pin (when the
 * caller offers it), Make default, Remove (asks first; disabled with the reason when it cannot
 * run). `dialog` is the Remove confirmation, rendered by the caller.
 */
export function useKitMenu(
  kit: Kit,
  { onRepin, onRemoved }: { onRepin?: () => void; onRemoved?: () => void } = {}
): {
  items: MenuItem[]
  dialog: ReactNode
  check: ReturnType<typeof useCheckKit>
  error: Error | null
} {
  const check = useCheckKit()
  const makeDefault = useMakeDefaultKit()
  const remove = useRemoveKit()
  const [confirmRemove, setConfirmRemove] = useState(false)
  const running = kitCheckRunning(kit)
  const busy = check.isPending || makeDefault.isPending || remove.isPending
  const items: MenuItem[] = [
    {
      label: 'Run the scaffold check',
      disabledReason: running
        ? 'A scaffold check is running.'
        : busy
          ? 'Working on the last action.'
          : null,
      onSelect: () => check.mutate({ id: kit.id, dynamic: true }),
    },
    ...(onRepin ? [{ label: 'Re-pin…', onSelect: onRepin }] : []),
    ...(kit.isDefault
      ? []
      : [{ label: 'Make default', onSelect: () => makeDefault.mutate(kit.id) }]),
    {
      label: 'Remove…',
      destructive: true,
      disabledReason: removeBlocker(kit),
      onSelect: () => setConfirmRemove(true),
    },
  ]
  const dialog = (
    <ConfirmModal
      isOpen={confirmRemove}
      title={`Remove ${kit.name}?`}
      message={`${kit.name} leaves the catalogue, so no new app can be made from it. Its repository is not touched, and it can be added again.`}
      confirmText="Remove kit"
      confirmButtonClass="btn-error"
      isLoading={remove.isPending}
      onCancel={() => setConfirmRemove(false)}
      onConfirm={() =>
        remove.mutate(kit.id, {
          onSettled: () => setConfirmRemove(false),
          onSuccess: () => onRemoved?.(),
        })
      }
    />
  )
  return { items, dialog, check, error: check.error ?? makeDefault.error ?? remove.error }
}
