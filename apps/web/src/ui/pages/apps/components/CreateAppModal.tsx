/**
 * "Create app" (Launch P2): name the app, and Launch does the rest — a private repo scaffolded from
 * the pinned kit, a database, storage, sign-in, both Workers, and (unless unticked) a first staging
 * deploy. The slug is checked as it is typed with `newAppSlugProblem`, the rule the server applies,
 * and the host it will answer on is previewed when the apps domain is known. On success the app's
 * page opens and shows the launch as it happens.
 */
import { RocketLaunchIcon } from '@heroicons/react/24/outline'
import { APP_SLUG_MAX_LENGTH } from '@launch/shared/launch-apps'
import { createAppRequestSchema, newAppSlugProblem } from '@launch/shared/launch-pipeline'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { FieldError, fieldErrorFor, Modal, showToast } from '@/ui/components/shared'
import { useGroups } from '@/ui/hooks/useGroups'
import { usePermissions } from '@/ui/hooks/usePermissions'
import { useAppsDomain, useCreateApp } from '@/ui/hooks/usePipeline'
import { ApiError } from '@/ui/lib/api-client'

/**
 * What to do next, for the refusals a person can act on — keyed on the HTTP status, since that is
 * what each refusal means here whatever its code: 409 the slug is taken, 403 the role is below
 * `app_create_role`, 503 Launch is not set up (a credential, the apps domain, or the Workflow).
 */
const HINTS: Record<number, string> = {
  409: 'Pick another slug — slugs name hostnames, so each is used once.',
  403: 'Creating apps is limited to a higher role (Admin → Setup).',
  503: 'An owner finishes Admin → Setup first: the credentials and the apps domain.',
}

/**
 * A slug suggested from the display name — lower-case, hyphenated, starting with a letter, at most
 * `APP_SLUG_MAX_LENGTH`. The person can overwrite it; once they do, the name stops driving it. Pure.
 */
export function slugFromName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .slice(0, APP_SLUG_MAX_LENGTH)
    .replace(/-+$/, '')
}

/** `<slug>-staging.<domain>` and `<slug>.<domain>`, or null until both halves are usable. Pure. */
export function hostPreview(
  slug: string,
  domain: string | null
): { staging: string; production: string } | null {
  if (!domain || newAppSlugProblem(slug)) return null
  return { staging: `${slug}-staging.${domain}`, production: `${slug}.${domain}` }
}

export function CreateAppModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate()
  const create = useCreateApp()
  const { can } = usePermissions()
  const canListGroups = can('manage', 'Group')
  const groups = useGroups(undefined, open && canListGroups)
  const domain = useAppsDomain(open)

  const [displayName, setDisplayName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugEdited, setSlugEdited] = useState(false)
  const [slugTouched, setSlugTouched] = useState(false)
  const [description, setDescription] = useState('')
  const [ownerGroupId, setOwnerGroupId] = useState('')
  const [deployStaging, setDeployStaging] = useState(true)
  const [issues, setIssues] = useState<{ path: PropertyKey[]; message: string }[]>()

  const close = () => {
    setDisplayName('')
    setSlug('')
    setSlugEdited(false)
    setSlugTouched(false)
    setDescription('')
    setOwnerGroupId('')
    setDeployStaging(true)
    setIssues(undefined)
    create.reset()
    onClose()
  }

  const onName = (value: string) => {
    setDisplayName(value)
    if (!slugEdited) setSlug(slugFromName(value))
  }

  // Live: once there is something to judge. An empty, untouched field is not yet wrong.
  const liveSlugProblem = slug || slugTouched ? newAppSlugProblem(slug) : null
  const slugMessage = liveSlugProblem ?? fieldErrorFor(issues, 'slug')
  const preview = hostPreview(slug, domain)

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    setSlugTouched(true)
    const parsed = createAppRequestSchema.safeParse({
      slug,
      displayName,
      description: description.trim() || undefined,
      ownerGroupId: ownerGroupId || undefined,
      options: { deployStaging },
    })
    if (!parsed.success) return setIssues(parsed.error.issues)
    setIssues(undefined)
    create.mutate(parsed.data, {
      onSuccess: ({ app }) => {
        showToast(`Launching ${app.displayName}`, 'success')
        close()
        navigate(`/apps/${encodeURIComponent(app.slug)}`)
      },
    })
  }

  const error = create.error
  const hint = error instanceof ApiError ? HINTS[error.status] : undefined

  return (
    <Modal
      open={open}
      onClose={close}
      title={
        <span className="flex items-center gap-2">
          <RocketLaunchIcon className="w-5 h-5 text-primary" />
          Create an app
        </span>
      }
      className="max-w-xl"
      actions={
        <>
          <button type="button" className="btn btn-sm" onClick={close} disabled={create.isPending}>
            Cancel
          </button>
          <button
            type="submit"
            form="create-app-form"
            className="btn btn-sm btn-primary btn-flame gap-1.5"
            disabled={create.isPending}
          >
            {create.isPending ? (
              <span className="loading loading-spinner loading-xs" />
            ) : (
              <RocketLaunchIcon className="w-4 h-4" />
            )}
            Create app
          </button>
        </>
      }
    >
      <p className="mb-4">
        Launch creates a private repository from the Rocketflare template, then its database,
        storage, sign-in and Workers. You can follow every step on the app’s page.
      </p>
      {error && (
        <div className="alert alert-error alert-soft text-sm mb-4 items-start" role="alert">
          <div>
            <p className="font-medium">{error.message}</p>
            {hint && <p className="mt-0.5 opacity-80">{hint}</p>}
          </div>
        </div>
      )}
      <form id="create-app-form" onSubmit={submit} className="space-y-4" noValidate>
        <div>
          <label htmlFor="create-name" className="label text-sm">
            Name
          </label>
          <input
            id="create-name"
            className="input w-full"
            placeholder="Expense Tracker"
            autoComplete="off"
            value={displayName}
            onChange={e => onName(e.target.value)}
          />
          <FieldError message={fieldErrorFor(issues, 'displayName')} />
        </div>

        <div>
          <label htmlFor="create-slug" className="label text-sm">
            Slug
          </label>
          <input
            id="create-slug"
            className={`input w-full font-mono text-sm ${slugMessage ? 'input-error' : ''}`}
            placeholder="expense-tracker"
            autoComplete="off"
            spellCheck={false}
            maxLength={APP_SLUG_MAX_LENGTH + 10}
            aria-invalid={Boolean(slugMessage)}
            aria-describedby="create-slug-help"
            value={slug}
            onChange={e => {
              setSlug(e.target.value)
              setSlugEdited(true)
            }}
            onBlur={() => setSlugTouched(true)}
          />
          <FieldError message={slugMessage} />
          <div id="create-slug-help" className="mt-1.5 text-xs text-muted">
            {preview ? (
              <dl className="surface-inset rounded-md px-3 py-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
                <dt>Staging</dt>
                <dd className="font-mono text-secondary truncate" data-testid="host-preview">
                  {preview.staging}
                </dd>
                <dt>Production</dt>
                <dd className="font-mono text-secondary truncate">{preview.production}</dd>
              </dl>
            ) : (
              <span>
                Names the repository, the Workers and the hosts. Lower-case letters, digits and
                hyphens; it cannot be changed later.
              </span>
            )}
          </div>
        </div>

        {canListGroups && (
          <div>
            <label htmlFor="create-team" className="label text-sm">
              Owner team <span className="text-muted">(optional)</span>
            </label>
            <select
              id="create-team"
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
        )}

        <div>
          <label htmlFor="create-description" className="label text-sm">
            Description <span className="text-muted">(optional)</span>
          </label>
          <textarea
            id="create-description"
            className="textarea w-full"
            rows={2}
            placeholder="What it is for, in a sentence"
            value={description}
            onChange={e => setDescription(e.target.value)}
          />
          <FieldError message={fieldErrorFor(issues, 'description')} />
        </div>

        <label className="flex items-start gap-3 cursor-pointer rounded-lg border border-base-300 p-3">
          <input
            type="checkbox"
            className="toggle toggle-primary toggle-sm mt-0.5"
            checked={deployStaging}
            onChange={e => setDeployStaging(e.target.checked)}
          />
          <span>
            <span className="block text-sm font-medium text-base-content">Deploy staging now</span>
            <span className="block text-xs text-muted mt-0.5">
              Build the new repository and put it on staging as soon as it is ready. Untick to stop
              once the infrastructure exists and deploy later from GitHub.
            </span>
          </span>
        </label>
      </form>
    </Modal>
  )
}
