/**
 * Settings → Kits' catalogue (D36 K1, K5): the kits apps can be built from, one row each — name,
 * repo and pin, the conformance check's result (its problems spelled out when it failed), how many
 * apps were made from it — with, per row:
 *
 * - **Check** — re-read the manifest and re-run the check at the pin;
 * - **Re-pin** — a release tag (picked from the repo's tags or typed), a commit or branch, or
 *   Follow latest, checked at the new pin before it is stored;
 * - **Make default** — the kit Create app preselects and a request with no kit is cut from;
 * - **Details** — what the manifest snapshot declares: where it came from, the init command, the
 *   release workflow, the required check, whether it supports upgrades, its default plugins;
 * - **Remove** — disabled, with the reason, for the default and for a kit apps were made from (an
 *   app keeps its kit for life); asks first.
 *
 * Below the list, a form registers another kit: its repo and a pin (Follow latest, a tag, a
 * commit). The default kit's version is also the Kit version card above.
 */
import {
  type Kit,
  type KitPinRequest,
  kitAddRequestSchema,
  kitManifestSummary,
  kitPinRequestSchema,
} from '@launch/shared/kits'
import { shortSha } from '@launch/shared/launch-setup'
import { type FormEvent, useId, useState } from 'react'
import { Combobox } from '@/ui/components/Combobox'
import { ConfirmModal, FieldError } from '@/ui/components/shared'
import {
  useAddKit,
  useCheckKit,
  useKit,
  useKits,
  useMakeDefaultKit,
  usePinKit,
  useRemoveKit,
} from '@/ui/hooks/useKits'
import { useKitTags } from '@/ui/hooks/useSetup'
import { formatDateTime, timeAgo } from '@/ui/lib/format'

const HEADING_ID = 'kits-title'

export function pinLabel(kit: Pick<Kit, 'pin' | 'pinIsCodeDefault'>): string {
  const at = kit.pin.tag ?? `@${shortSha(kit.pin.commit)}`
  if (kit.pin.follow === 'latest') return `latest (${at})`
  return kit.pinIsCodeDefault ? `${at}, Launch's default` : at
}

function statusText(kit: Kit): { text: string; className: string } {
  if (kit.status === 'verified') return { text: 'Conforms', className: 'text-success' }
  if (kit.status === 'failed') {
    const n = kit.problems.length
    return { text: `${n} problem${n === 1 ? '' : 's'}`, className: 'text-error' }
  }
  return { text: 'Not checked', className: 'text-muted' }
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

/** The pin request a mode and its typed value make, or null while the value is missing. Pure. */
export function pinRequestOf(mode: PinMode, value: string): KitPinRequest | null {
  const typed = value.trim()
  if (mode === 'latest') return { kind: 'latest' }
  if (!typed) return null
  return mode === 'tag' ? { kind: 'tag', tag: typed } : { kind: 'commit', ref: typed }
}

const PIN_MODES: readonly (readonly [PinMode, string])[] = [
  ['latest', 'Follow latest'],
  ['tag', 'A release tag'],
  ['commit', 'A commit or branch'],
]

/**
 * The three ways to pin a kit — the mode's radios and, for a tag or a commit, its field. A tag
 * field lists the repo's tags (newest first) once it is opened, when the repo is known.
 */
function PinFields({
  mode,
  onMode,
  value,
  onValue,
  repo,
}: {
  mode: PinMode
  onMode: (mode: PinMode) => void
  value: string
  onValue: (value: string) => void
  repo: string | null
}) {
  const name = useId()
  const fieldId = useId()
  const [loadTags, setLoadTags] = useState(false)
  const tags = useKitTags(repo ?? '', loadTags && Boolean(repo))
  return (
    <div className="space-y-2">
      <div role="radiogroup" aria-label="Pin to" className="flex flex-wrap gap-4 text-sm">
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
      {mode === 'tag' && (
        <div className="text-sm">
          <label htmlFor={fieldId} className="block font-medium mb-1">
            Tag
          </label>
          {repo ? (
            <Combobox
              id={fieldId}
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
              className="input input-bordered input-sm w-full font-mono"
              placeholder="1.0.0"
              value={value}
              onChange={e => onValue(e.target.value)}
            />
          )}
        </div>
      )}
      {mode === 'commit' && (
        <div className="text-sm">
          <label htmlFor={fieldId} className="block font-medium mb-1">
            Commit or branch
          </label>
          <input
            id={fieldId}
            className="input input-bordered input-sm w-full font-mono"
            placeholder="a commit SHA, or main"
            value={value}
            onChange={e => onValue(e.target.value)}
          />
        </div>
      )}
      {mode === 'latest' && (
        <p className="text-xs text-muted">
          The kit's newest release. Launch checks hourly and moves the pin when a newer one appears.
        </p>
      )}
    </div>
  )
}

function RepinForm({ kit, onDone }: { kit: Kit; onDone: () => void }) {
  const pin = usePinKit()
  const [mode, setMode] = useState<PinMode>(kit.pin.follow === 'latest' ? 'latest' : 'tag')
  const [value, setValue] = useState('')
  const [invalid, setInvalid] = useState<string>()

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    const request = pinRequestOf(mode, value)
    if (!request) {
      setInvalid(mode === 'tag' ? 'Type the release tag' : 'Type a commit SHA or a branch')
      return
    }
    const parsed = kitPinRequestSchema.safeParse(request)
    if (!parsed.success) {
      setInvalid(parsed.error.issues[0]?.message ?? 'Not a valid tag or commit')
      return
    }
    setInvalid(undefined)
    pin.mutate({ id: kit.id, pin: parsed.data }, { onSuccess: onDone })
  }

  return (
    <form
      className="surface-inset rounded-md p-3 space-y-2"
      onSubmit={onSubmit}
      aria-label={`Re-pin ${kit.name}`}
    >
      <PinFields mode={mode} onMode={setMode} value={value} onValue={setValue} repo={kit.repo} />
      <FieldError message={invalid} />
      {pin.error && (
        <p className="text-xs text-error" role="alert">
          {pin.error.message}
        </p>
      )}
      <div className="flex gap-2">
        <button type="submit" className="btn btn-sm btn-primary" disabled={pin.isPending}>
          {pin.isPending ? 'Checking…' : 'Pin'}
        </button>
        <button type="button" className="btn btn-sm btn-ghost" onClick={onDone}>
          Cancel
        </button>
      </div>
      <p className="text-xs text-muted">
        Launch checks the kit at the new pin before it stores it. Apps already made from it keep
        their version until they are upgraded.
      </p>
    </form>
  )
}

/** What the kit's manifest snapshot declares (`kitManifestSummary`). */
function KitDetails({ kit }: { kit: Kit }) {
  const { data, isLoading, error } = useKit(kit.id)
  if (isLoading) return <p className="text-xs text-muted">Loading the manifest…</p>
  if (error) {
    return (
      <p className="text-xs text-error" role="alert">
        Could not load the manifest: {error.message}
      </p>
    )
  }
  if (!data?.manifest) {
    return (
      <p className="text-xs text-muted">
        No manifest read yet. Check the kit to read its launch.kit.json.
      </p>
    )
  }
  const declared = kitManifestSummary(data.manifest)
  return (
    <dl
      className="surface-inset rounded-md px-3 py-2 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs"
      aria-label={`What ${kit.name} declares`}
    >
      <dt className="text-muted">Manifest</dt>
      <dd>
        {data.manifestSource === 'fallback'
          ? "Launch's built-in Rocketflare manifest"
          : `launch.kit.json, contract ${data.contractVersion ?? '1'}`}
      </dd>
      <dt className="text-muted">Init</dt>
      <dd className="font-mono break-all">{declared.init}</dd>
      <dt className="text-muted">Release workflow</dt>
      <dd className="font-mono">.github/workflows/{declared.releaseWorkflow}</dd>
      <dt className="text-muted">Required check</dt>
      <dd className="font-mono">{declared.requiredCheck}</dd>
      <dt className="text-muted">Upgrades</dt>
      <dd>
        {declared.upgrades
          ? 'Supported: apps behind the pin are offered an upgrade'
          : 'Not declared: its apps are never shown as behind'}
      </dd>
      <dt className="text-muted">Plugins</dt>
      <dd>{declared.plugins.length ? declared.plugins.join(', ') : 'None by default'}</dd>
    </dl>
  )
}

function KitRow({ kit }: { kit: Kit }) {
  const check = useCheckKit()
  const makeDefault = useMakeDefaultKit()
  const remove = useRemoveKit()
  const [open, setOpen] = useState<'details' | 'pin' | null>(null)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const rowId = useId()
  const busy = check.isPending || makeDefault.isPending || remove.isPending
  const status = statusText(kit)
  const error = check.error ?? makeDefault.error ?? remove.error
  const blocker = removeBlocker(kit)
  const toggle = (panel: 'details' | 'pin') => setOpen(open === panel ? null : panel)

  return (
    <li className="py-3 space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <span className="font-medium">{kit.name}</span>
          {kit.isDefault && <span className="text-xs text-muted ml-2">Default</span>}
          <div className="font-mono text-xs text-secondary truncate">
            {kit.repo} · {pinLabel(kit)}
          </div>
          {kit.description && <div className="text-xs text-muted">{kit.description}</div>}
        </div>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className={status.className}>
            {status.text}
            {kit.checkedAt && (
              <time
                className="text-xs text-muted ml-1"
                dateTime={kit.checkedAt.toISOString()}
                title={formatDateTime(kit.checkedAt)}
              >
                {timeAgo(kit.checkedAt)}
              </time>
            )}
          </span>
          <span className="text-xs text-muted tabular-nums">
            {kit.appCount} app{kit.appCount === 1 ? '' : 's'}
          </span>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn btn-xs"
          disabled={busy}
          onClick={() => check.mutate(kit.id)}
        >
          {check.isPending ? 'Checking…' : 'Check'}
        </button>
        <button
          type="button"
          className="btn btn-xs btn-ghost"
          aria-expanded={open === 'pin'}
          onClick={() => toggle('pin')}
        >
          Re-pin
        </button>
        {!kit.isDefault && (
          <button
            type="button"
            className="btn btn-xs btn-ghost"
            disabled={busy}
            onClick={() => makeDefault.mutate(kit.id)}
          >
            Make default
          </button>
        )}
        <button
          type="button"
          className="btn btn-xs btn-ghost"
          aria-expanded={open === 'details'}
          aria-controls={`${rowId}-details`}
          onClick={() => toggle('details')}
        >
          Details
        </button>
        <span className={blocker ? 'tooltip' : undefined} data-tip={blocker ?? undefined}>
          <button
            type="button"
            className="btn btn-xs btn-ghost text-error"
            disabled={busy || Boolean(blocker)}
            aria-describedby={blocker ? `${rowId}-remove` : undefined}
            onClick={() => setConfirmRemove(true)}
          >
            Remove
          </button>
          {blocker && (
            <span id={`${rowId}-remove`} className="sr-only">
              {blocker}
            </span>
          )}
        </span>
      </div>
      {kit.status === 'failed' && kit.problems.length > 0 && (
        <ul className="text-xs text-error list-disc pl-5 space-y-0.5">
          {kit.problems.map(p => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {open === 'pin' && <RepinForm kit={kit} onDone={() => setOpen(null)} />}
      {open === 'details' && (
        <div id={`${rowId}-details`}>
          <KitDetails kit={kit} />
        </div>
      )}
      {error && (
        <p className="text-xs text-error" role="alert">
          {error.message}
        </p>
      )}
      <ConfirmModal
        isOpen={confirmRemove}
        title={`Remove ${kit.name}?`}
        message={`${kit.name} leaves the catalogue, so no new app can be made from it. Its repository is not touched, and it can be added again.`}
        confirmText="Remove kit"
        confirmButtonClass="btn-error"
        isLoading={remove.isPending}
        onCancel={() => setConfirmRemove(false)}
        onConfirm={() => remove.mutate(kit.id, { onSettled: () => setConfirmRemove(false) })}
      />
    </li>
  )
}

function AddKitForm() {
  const add = useAddKit()
  const [repo, setRepo] = useState('')
  const [mode, setMode] = useState<PinMode>('latest')
  const [ref, setRef] = useState('')
  const [invalid, setInvalid] = useState<string | undefined>()
  const repoValid = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo.trim())

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    const pin = pinRequestOf(mode, ref)
    if (!pin) {
      setInvalid(mode === 'tag' ? 'Type the release tag' : 'Type a commit SHA or a branch')
      return
    }
    const parsed = kitAddRequestSchema.safeParse({ repo: repo.trim(), pin })
    if (!parsed.success) {
      setInvalid(parsed.error.issues[0]?.message ?? 'Not a valid repo or ref')
      return
    }
    setInvalid(undefined)
    add.mutate(parsed.data, {
      onSuccess: () => {
        setRepo('')
        setRef('')
        setMode('latest')
      },
    })
  }

  return (
    <form className="space-y-2 pt-3" onSubmit={onSubmit} aria-label="Add a kit">
      <h3 className="text-sm font-semibold">Add a kit</h3>
      <label className="block text-sm">
        <span className="block font-medium mb-1">Kit repository</span>
        <input
          className="input input-bordered input-sm w-full font-mono"
          placeholder="owner/name"
          value={repo}
          onChange={e => setRepo(e.target.value)}
        />
      </label>
      <PinFields
        mode={mode}
        onMode={setMode}
        value={ref}
        onValue={setRef}
        repo={repoValid ? repo.trim() : null}
      />
      <FieldError message={invalid} />
      {add.error && (
        <p className="text-xs text-error" role="alert">
          {add.error.message}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className="btn btn-sm" disabled={add.isPending || !repo.trim()}>
          {add.isPending ? 'Checking…' : 'Add kit'}
        </button>
        <p className="text-xs text-muted">
          Launch reads the kit's launch.kit.json at that pin and checks it against the kit contract.
          A private repo needs the GitHub App installed on its owner.
        </p>
      </div>
    </form>
  )
}

export function KitsCard() {
  const { data, isLoading, error } = useKits()
  return (
    <section aria-labelledby={HEADING_ID} className="surface-panel p-5 space-y-2">
      <header>
        <h2 id={HEADING_ID} className="text-base font-semibold leading-6">
          Kits
        </h2>
        <div className="text-sm text-secondary mt-0.5">
          The kits apps can be built from. Create app offers every kit that passes its check, the
          default first; an app keeps its kit for life.
        </div>
      </header>
      {isLoading && <p className="text-sm text-muted">Loading the kits…</p>}
      {error && (
        <p className="text-sm text-error" role="alert">
          Could not load the kits.
        </p>
      )}
      {data && (
        <ul className="divide-y divide-base-300" aria-label="Kits">
          {data.kits.map(kit => (
            <KitRow key={kit.id} kit={kit} />
          ))}
        </ul>
      )}
      <AddKitForm />
    </section>
  )
}
