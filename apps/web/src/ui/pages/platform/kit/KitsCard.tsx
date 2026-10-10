/**
 * Settings → Kit version's catalogue (D36 K1): the kits apps can be built from, one row each —
 * name, repo and pin, the conformance check's result (its problems spelled out when it failed),
 * how many apps were made from it — with Check and Make default per row, and a small form to
 * register another kit. The default kit is the one the Kit version card above pins; Create app
 * gains a picker in K5. Pinning, removing and the manifest itself are `launch kits …` for now.
 */
import { type Kit, type KitPinRequest, kitAddRequestSchema } from '@launch/shared/kits'
import { shortSha } from '@launch/shared/launch-setup'
import { type FormEvent, useState } from 'react'
import { FieldError } from '@/ui/components/shared'
import { useAddKit, useCheckKit, useKits, useMakeDefaultKit } from '@/ui/hooks/useKits'
import { formatDateTime, timeAgo } from '@/ui/lib/format'

const HEADING_ID = 'kits-title'

function pinLabel(kit: Kit): string {
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

function KitRow({ kit }: { kit: Kit }) {
  const check = useCheckKit()
  const makeDefault = useMakeDefaultKit()
  const busy = check.isPending || makeDefault.isPending
  const status = statusText(kit)
  const error = check.error ?? makeDefault.error
  return (
    <li className="py-3 space-y-1">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <span className="font-medium">{kit.name}</span>
          {kit.isDefault && <span className="text-xs text-muted ml-2">Default</span>}
          <div className="font-mono text-xs text-secondary truncate">
            {kit.repo} · {pinLabel(kit)}
          </div>
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
          <button
            type="button"
            className="btn btn-xs"
            disabled={busy}
            onClick={() => check.mutate(kit.id)}
          >
            {check.isPending ? 'Checking…' : 'Check'}
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
        </div>
      </div>
      {kit.status === 'failed' && kit.problems.length > 0 && (
        <ul className="text-xs text-error list-disc pl-5 space-y-0.5">
          {kit.problems.map(p => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {error && (
        <p className="text-xs text-error" role="alert">
          {error.message}
        </p>
      )}
    </li>
  )
}

function AddKitForm() {
  const add = useAddKit()
  const [repo, setRepo] = useState('')
  const [ref, setRef] = useState('')
  const [invalid, setInvalid] = useState<string | undefined>()

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    const value = ref.trim()
    // Empty: the newest release; a version-looking ref: a tag; anything else: a commit or branch.
    const pin: KitPinRequest = !value
      ? { kind: 'latest' }
      : /^v?\d+\.\d+\.\d+/.test(value)
        ? { kind: 'tag', tag: value }
        : { kind: 'commit', ref: value }
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
      },
    })
  }

  return (
    <form className="space-y-1 pt-3" onSubmit={onSubmit} aria-label="Add a kit">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex-1 min-w-48 text-sm">
          <span className="block font-medium mb-1">Kit repository</span>
          <input
            className="input input-bordered input-sm w-full font-mono"
            placeholder="owner/name"
            value={repo}
            onChange={e => setRepo(e.target.value)}
          />
        </label>
        <label className="w-40 text-sm">
          <span className="block font-medium mb-1">Tag or commit</span>
          <input
            className="input input-bordered input-sm w-full font-mono"
            placeholder="latest release"
            value={ref}
            onChange={e => setRef(e.target.value)}
          />
        </label>
        <button type="submit" className="btn btn-sm" disabled={add.isPending || !repo.trim()}>
          {add.isPending ? 'Checking…' : 'Add kit'}
        </button>
      </div>
      <p className="text-xs text-muted">
        Launch reads the kit's launch.kit.json at that commit and checks it against the kit
        contract. A private repo needs the GitHub App installed on its owner.
      </p>
      <FieldError message={invalid} />
      {add.error && (
        <p className="text-xs text-error" role="alert">
          {add.error.message}
        </p>
      )}
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
          The kits apps can be built from. New apps use the default; an app keeps its kit for life.
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
