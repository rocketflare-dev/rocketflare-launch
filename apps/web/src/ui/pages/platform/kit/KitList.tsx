/**
 * Settings → Kits (`/settings/kit`, D36 K1, K3, K5): the kits apps can be built from, one row
 * each — the name (a link to the kit's page, `KitDetail`), "Default" beside the one new apps are
 * cut from, the repo, the version in tabular mono with how it is pinned, the status in one word
 * with its dot, and how many apps were made from it. A failed check's problems sit under its row.
 *
 * Per row: **Check** (re-read the manifest and re-run the static check at the pin) and a ⋯ menu —
 * Run the scaffold check (the kit's scaffold job against a throwaway repo, `?dynamic=1`; minutes,
 * so the list re-reads while it runs, `kitsPollInterval`), Re-pin… (the pin editor in a dialog),
 * Make default, Remove… (asks first; disabled with the reason for the default and for a kit apps
 * were made from — an app keeps its kit for life).
 *
 * **Add a kit** is the page's one primary action: a dialog with the repo (`owner/name` or a GitHub
 * URL), the pin and the scaffold-check option. Only a verified kit (and the default) is offered by
 * Create app.
 */
import { PlusIcon } from '@heroicons/react/24/outline'
import { type Kit, kitAddRequestSchema } from '@launch/shared/kits'
import { isKitRepo, normalizeKitRepo } from '@launch/shared/launch-setup'
import { type FormEvent, useId, useState } from 'react'
import { Link } from 'react-router-dom'
import { FieldError, Modal, SkeletonRows } from '@/ui/components/shared'
import { useAddKit, useKits } from '@/ui/hooks/useKits'
import { kitPath } from '@/ui/lib/settings-paths'
import { MoreMenu } from '@/ui/pages/apps/app/bits'
import {
  DefaultLabel,
  DynamicOption,
  KitStatus,
  kitVersion,
  MISSING_REF,
  PinForm,
  type PinMode,
  PinModeFields,
  ProblemList,
  pinRequestOf,
  useKitMenu,
} from './kitBits'

/**
 * One grid for the header and every row, so the columns line up: kit · version · status · apps ·
 * actions from `sm`; below it the name and the actions share the first line and the version and
 * status sit under the name (`sm:contents` hands them back to the grid).
 */
const ROW_GRID =
  'grid grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1.2fr)_3rem_8rem] items-center gap-x-4 gap-y-1.5 px-5'

function KitRow({ kit }: { kit: Kit }) {
  const [repinOpen, setRepinOpen] = useState(false)
  const { items, dialog, check, error } = useKitMenu(kit, { onRepin: () => setRepinOpen(true) })
  const version = kitVersion(kit)
  const checkingStatic = check.isPending && check.variables?.dynamic !== true
  const showProblems = kit.status === 'failed' && kit.problems.length > 0
  return (
    <li className={`${ROW_GRID} py-3`} aria-label={kit.name}>
      <div className="min-w-0 col-start-1 row-start-1">
        <div className="flex items-baseline gap-2">
          <Link to={kitPath(kit.slug)} className="font-medium link link-hover">
            {kit.name}
          </Link>
          {kit.isDefault && <DefaultLabel />}
        </div>
        <div className="font-mono text-xs text-muted truncate" title={kit.description ?? undefined}>
          {kit.repo}
        </div>
      </div>
      <div className="col-start-1 row-start-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 sm:contents">
        <div className="sm:col-start-2 sm:row-start-1 flex items-baseline gap-2 sm:block">
          <div className="font-mono tabular-nums text-sm">{version.version}</div>
          {version.note && (
            <div className={`text-xs ${version.unreleased ? 'text-warning' : 'text-muted'}`}>
              {version.note}
            </div>
          )}
        </div>
        <div className="sm:col-start-3 sm:row-start-1">
          <KitStatus kit={kit} />
        </div>
        <div className="hidden sm:block sm:col-start-4 sm:row-start-1 text-right text-sm tabular-nums">
          {kit.appCount}
        </div>
      </div>
      <div className="col-start-2 row-start-1 sm:col-start-5 flex items-center justify-end gap-1">
        <button
          type="button"
          className="btn btn-sm btn-outline"
          disabled={check.isPending}
          onClick={() => check.mutate({ id: kit.id })}
        >
          {checkingStatic ? 'Checking…' : 'Check'}
        </button>
        <MoreMenu items={items} label={`More actions for ${kit.name}`} />
      </div>
      {(showProblems || error) && (
        <div className="col-span-full space-y-1">
          {showProblems && (
            <ProblemList problems={kit.problems} label={`Problems with ${kit.name}`} />
          )}
          {error && (
            <p className="text-xs text-error" role="alert">
              {error.message}
            </p>
          )}
        </div>
      )}
      <Modal
        open={repinOpen}
        onClose={() => setRepinOpen(false)}
        title={`Re-pin ${kit.name}`}
        className="max-w-xl"
      >
        {repinOpen && <PinForm kit={kit} onDone={() => setRepinOpen(false)} />}
      </Modal>
      {dialog}
    </li>
  )
}

/** The Add a kit dialog's form: repo, pin, scaffold-check option. */
function AddKitForm({ onDone }: { onDone: () => void }) {
  const add = useAddKit()
  const repoId = useId()
  const repoHelpId = useId()
  const repoErrorId = useId()
  const [repo, setRepo] = useState('')
  const [repoTouched, setRepoTouched] = useState(false)
  const [mode, setMode] = useState<PinMode>('latest')
  const [ref, setRef] = useState('')
  const [dynamic, setDynamic] = useState(false)
  const [invalid, setInvalid] = useState<string>()
  const repoValid = isKitRepo(repo)
  const repoError =
    repoTouched && !repoValid
      ? repo.trim()
        ? 'owner/name or a GitHub URL'
        : "Type the kit's repository"
      : undefined

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    setRepoTouched(true)
    if (!repoValid) return
    const pin = pinRequestOf(mode, ref)
    if (!pin) {
      setInvalid(mode === 'latest' ? undefined : MISSING_REF[mode])
      return
    }
    const parsed = kitAddRequestSchema.safeParse({ repo: repo.trim(), pin })
    if (!parsed.success) {
      setInvalid(parsed.error.issues[0]?.message ?? 'Not a valid repo or ref')
      return
    }
    setInvalid(undefined)
    add.mutate({ ...parsed.data, dynamic }, { onSuccess: onDone })
  }

  return (
    <form className="space-y-5" onSubmit={onSubmit} aria-label="Add a kit" noValidate>
      <div className="space-y-1">
        <label htmlFor={repoId} className="block text-sm font-medium text-base-content">
          Kit repository
        </label>
        <input
          id={repoId}
          className={`input input-bordered input-sm w-full font-mono ${repoError ? 'input-error' : ''}`}
          placeholder="owner/name"
          value={repo}
          aria-invalid={repoError ? true : undefined}
          aria-describedby={repoError ? repoErrorId : repoHelpId}
          onChange={e => setRepo(e.target.value)}
          onBlur={() => setRepoTouched(repo.trim() !== '')}
        />
        {repoError ? (
          <FieldError id={repoErrorId} message={repoError} />
        ) : (
          <p id={repoHelpId} className="text-xs text-muted">
            owner/name or a GitHub URL. A private repo needs the GitHub App on its owner.
          </p>
        )}
      </div>
      <PinModeFields
        mode={mode}
        onMode={next => {
          setMode(next)
          setInvalid(undefined)
        }}
        value={ref}
        onValue={setRef}
        repo={repoValid ? normalizeKitRepo(repo) : null}
      />
      <FieldError message={invalid} />
      <DynamicOption checked={dynamic} onChange={setDynamic} />
      {add.error && (
        <p className="text-xs text-error" role="alert">
          {add.error.message}
        </p>
      )}
      <div className="flex justify-end gap-2 pt-1">
        <button type="button" className="btn btn-sm btn-ghost" onClick={onDone}>
          Cancel
        </button>
        <button type="submit" className="btn btn-sm btn-primary" disabled={add.isPending}>
          {add.isPending ? 'Checking…' : 'Add kit'}
        </button>
      </div>
    </form>
  )
}

export function KitList() {
  const { data, isLoading, error } = useKits()
  const [adding, setAdding] = useState(false)
  return (
    // Not a flush `SectionPanel`: it clips, and a row's ⋯ menu must be able to hang below the list.
    <section aria-labelledby="kits-title" className="surface-panel p-0">
      <div className="flex flex-wrap items-start justify-between gap-3 px-5 pt-5 pb-3">
        <div className="min-w-0">
          <h2 id="kits-title" className="text-base font-semibold leading-6">
            Kits
          </h2>
          <p className="text-sm text-secondary mt-0.5">
            What new apps are cut from. Create app offers every verified kit, the default first.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-primary btn-sm gap-1.5"
          onClick={() => setAdding(true)}
        >
          <PlusIcon className="w-4 h-4" aria-hidden="true" />
          Add a kit
        </button>
      </div>
      {isLoading && (
        <div className="px-5 pb-5">
          <SkeletonRows rows={3} />
        </div>
      )}
      {error && (
        <p className="px-5 pb-5 text-sm text-error" role="alert">
          Could not load the kits.
        </p>
      )}
      {data && (
        <>
          <div
            className={`${ROW_GRID} hidden sm:grid py-2 border-y border-base-300 text-[11px] font-medium uppercase tracking-[0.06em] text-muted font-mono`}
            aria-hidden="true"
          >
            <span>Kit</span>
            <span>Version</span>
            <span>Status</span>
            <span className="text-right">Apps</span>
            <span />
          </div>
          <ul
            className="divide-y divide-base-300 border-t border-base-300 sm:border-t-0"
            aria-label="Kits"
          >
            {data.kits.map(kit => (
              <KitRow key={kit.id} kit={kit} />
            ))}
          </ul>
        </>
      )}
      <Modal open={adding} onClose={() => setAdding(false)} title="Add a kit" className="max-w-xl">
        {adding && <AddKitForm onDone={() => setAdding(false)} />}
      </Modal>
    </section>
  )
}
