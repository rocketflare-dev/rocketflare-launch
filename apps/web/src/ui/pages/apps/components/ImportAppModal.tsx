/**
 * "Import app" (spec/06): register an existing repo built from a registered kit. Launch works out
 * the kit (D36 K5: the repo's `launch.kit.json`, else its app manifest's `kit`), reads the app
 * manifest and both wrangler tomls through the GitHub App — nothing is provisioned — then opens
 * the new app's page. Once the repository is typed (and has settled for a moment) the modal runs
 * the import's dry run (`POST /api/apps/import/detect`) and says which kit it found and what the
 * app will be called, or why it cannot be imported. A refusal is rendered IN the modal, with the
 * server's sentence (it names the missing file, the unknown kit or the slug rule) and a hint for
 * the codes a person can fix.
 */
import { ArrowDownTrayIcon } from '@heroicons/react/24/outline'
import { KIT_NOT_REGISTERED } from '@launch/shared/kits'
import { importAppRequestSchema, importDetectRequestSchema } from '@launch/shared/launch-apps'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { FieldError, fieldErrorFor, Modal, showToast } from '@/ui/components/shared'
import { useImportApp, useImportDetect } from '@/ui/hooks/useApps'
import { useDebounce } from '@/ui/hooks/useDebounce'
import { useGroups } from '@/ui/hooks/useGroups'
import { ApiError } from '@/ui/lib/api-client'

/** How long the repository has to stay unchanged before the dry run reads it. */
export const DETECT_DEBOUNCE_MS = 500

/** What to do next, for the refusals an admin can act on. */
const HINTS: Record<string, string> = {
  github_app_not_configured: 'An administrator connects the GitHub App in Setup.',
  github_app_not_installed: 'Install the GitHub App on that organisation, then try again.',
  repo_not_accessible:
    'Give the GitHub App access to this repository in its installation settings.',
  repo_not_found: 'Check the spelling of owner/name.',
  manifest_missing:
    'An app built from a kit carries launch.kit.json, or its app manifest (.rocketflare.json for Rocketflare), at the repo root.',
  [KIT_NOT_REGISTERED]: 'A platform administrator registers that kit under Settings → Kits.',
  slug_taken: 'Another app already uses this slug — slugs name hostnames, so they are unique.',
  invalid_slug: 'Change app.slug in the repo’s app manifest, then import again.',
}

/** The dry run's input once `repo` (and `ref`) parse, else null — nothing to ask yet. Pure. */
export function detectInput(repo: string, ref: string) {
  const parsed = importDetectRequestSchema.safeParse({
    repo: repo.trim(),
    ref: ref.trim() || undefined,
  })
  return parsed.success ? parsed.data : null
}

/** What the dry run found, or why the repo cannot be imported — under the Repository field. */
function Detected({ input }: { input: { repo: string; ref?: string } | null }) {
  const detect = useImportDetect(input)
  if (!input) return null
  if (detect.isPending) {
    return (
      <p className="text-xs text-muted mt-1.5 flex items-center gap-2" role="status">
        <span className="loading loading-spinner loading-xs" />
        Reading {input.repo}…
      </p>
    )
  }
  if (detect.error) {
    const code = detect.error instanceof ApiError ? detect.error.code : undefined
    const hint = code ? HINTS[code] : undefined
    return (
      <div className="text-xs mt-1.5" role="status" data-testid="import-detect">
        <p className="text-warning">{detect.error.message}</p>
        {hint && <p className="text-muted mt-0.5">{hint}</p>}
      </div>
    )
  }
  const found = detect.data
  return (
    <dl
      className="surface-inset rounded-md px-3 py-2 mt-1.5 text-xs grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5"
      data-testid="import-detect"
    >
      <dt className="text-muted">Kit</dt>
      <dd>
        {found.kit.name}
        {found.kitVersion && (
          <span className="font-mono tabular-nums text-muted ml-1.5">{found.kitVersion}</span>
        )}
      </dd>
      <dt className="text-muted">Imports as</dt>
      <dd className="truncate">
        {found.displayName} <span className="font-mono text-muted">{found.slug}</span>
      </dd>
    </dl>
  )
}

export function ImportAppModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate()
  const importApp = useImportApp()
  const groups = useGroups(undefined, open)
  const [repo, setRepo] = useState('')
  const [ref, setRef] = useState('')
  const [ownerGroupId, setOwnerGroupId] = useState('')
  const [issues, setIssues] = useState<{ path: PropertyKey[]; message: string }[]>()
  // Strings, not the parsed object: a new object every render would never settle.
  const settledRepo = useDebounce(repo, DETECT_DEBOUNCE_MS)
  const settledRef = useDebounce(ref, DETECT_DEBOUNCE_MS)
  const settled = useMemo(() => detectInput(settledRepo, settledRef), [settledRepo, settledRef])

  const close = () => {
    setRepo('')
    setRef('')
    setOwnerGroupId('')
    setIssues(undefined)
    importApp.reset()
    onClose()
  }

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const parsed = importAppRequestSchema.safeParse({
      repo,
      ref: ref.trim() || undefined,
      ownerGroupId: ownerGroupId || undefined,
    })
    if (!parsed.success) return setIssues(parsed.error.issues)
    setIssues(undefined)
    importApp.mutate(parsed.data, {
      onSuccess: app => {
        showToast(`${app.displayName} imported`, 'success')
        close()
        navigate(`/apps/${encodeURIComponent(app.slug)}`)
      },
    })
  }

  const error = importApp.error
  const code = error instanceof ApiError ? error.code : undefined
  const hint = code ? HINTS[code] : undefined

  return (
    <Modal
      open={open}
      onClose={close}
      title="Import an app"
      className="max-w-lg"
      actions={
        <>
          <button
            type="button"
            className="btn btn-sm"
            onClick={close}
            disabled={importApp.isPending}
          >
            Cancel
          </button>
          <button
            type="submit"
            form="import-app-form"
            className="btn btn-sm btn-primary btn-flame gap-1.5"
            disabled={importApp.isPending}
          >
            {importApp.isPending ? (
              <span className="loading loading-spinner loading-xs" />
            ) : (
              <ArrowDownTrayIcon className="w-4 h-4" />
            )}
            Import
          </button>
        </>
      }
    >
      <p className="mb-4">
        Launch works out which kit the repo was built from, reads its app manifest and wrangler
        config through the GitHub App, then watches its health. Nothing is deployed or changed.
      </p>
      {error && (
        <div className="alert alert-error alert-soft text-sm mb-4 items-start" role="alert">
          <div>
            <p className="font-medium">{error.message}</p>
            {hint && <p className="mt-0.5 opacity-80">{hint}</p>}
          </div>
        </div>
      )}
      <form id="import-app-form" onSubmit={submit} className="space-y-4" noValidate>
        <div>
          <label htmlFor="import-repo" className="label text-sm">
            Repository
          </label>
          <input
            id="import-repo"
            className="input w-full font-mono text-sm"
            placeholder="acme/expense-tracker"
            autoComplete="off"
            spellCheck={false}
            value={repo}
            onChange={e => setRepo(e.target.value)}
          />
          <FieldError message={fieldErrorFor(issues, 'repo')} />
          {open && <Detected input={settled} />}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label htmlFor="import-ref" className="label text-sm">
              Branch or tag <span className="text-muted">(optional)</span>
            </label>
            <input
              id="import-ref"
              className="input w-full font-mono text-sm"
              placeholder="default branch"
              autoComplete="off"
              spellCheck={false}
              value={ref}
              onChange={e => setRef(e.target.value)}
            />
            <FieldError message={fieldErrorFor(issues, 'ref')} />
          </div>
          <div>
            <label htmlFor="import-team" className="label text-sm">
              Owner team <span className="text-muted">(optional)</span>
            </label>
            <select
              id="import-team"
              className="select w-full"
              value={ownerGroupId}
              onChange={e => setOwnerGroupId(e.target.value)}
            >
              <option value="">No team yet</option>
              {groups.data?.items.map(group => (
                <option key={group.id} value={group.id}>
                  {group.name} ({group.typeName})
                </option>
              ))}
            </select>
          </div>
        </div>
      </form>
    </Modal>
  )
}
