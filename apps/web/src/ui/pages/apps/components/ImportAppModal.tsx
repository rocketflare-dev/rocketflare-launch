/**
 * "Import app" (spec/06): register an existing Rocketflare repo. Launch reads its
 * `.rocketflare.json` and both wrangler tomls through the GitHub App — nothing is provisioned —
 * then opens the new app's page. A refusal is rendered IN the modal, with the server's sentence
 * (it names the missing file or the slug rule) and a hint for the codes a person can fix.
 */
import { ArrowDownTrayIcon } from '@heroicons/react/24/outline'
import { importAppRequestSchema } from '@launch/shared/launch-apps'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { FieldError, fieldErrorFor, Modal, showToast } from '@/ui/components/shared'
import { useImportApp } from '@/ui/hooks/useApps'
import { useGroups } from '@/ui/hooks/useGroups'
import { ApiError } from '@/ui/lib/api-client'

/** What to do next, for the refusals an admin can act on. */
const HINTS: Record<string, string> = {
  github_app_not_configured: 'An owner connects the GitHub App under Admin → Setup.',
  github_app_not_installed: 'Install the GitHub App on that organisation, then try again.',
  repo_not_accessible:
    'Give the GitHub App access to this repository in its installation settings.',
  repo_not_found: 'Check the spelling of owner/name.',
  manifest_missing: 'Rocketflare apps carry .rocketflare.json at the repo root.',
  slug_taken: 'Another app already uses this slug — slugs name hostnames, so they are unique.',
  invalid_slug: 'Change app.slug in the repo’s .rocketflare.json, then import again.',
}

export function ImportAppModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate()
  const importApp = useImportApp()
  const groups = useGroups(undefined, open)
  const [repo, setRepo] = useState('')
  const [ref, setRef] = useState('')
  const [ownerGroupId, setOwnerGroupId] = useState('')
  const [issues, setIssues] = useState<{ path: PropertyKey[]; message: string }[]>()

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
        Launch reads the repo’s <code className="text-xs">.rocketflare.json</code> and both wrangler
        tomls through the GitHub App, then watches its health. Nothing is deployed or changed.
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
