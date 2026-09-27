/**
 * The app's sign-in through Launch (spec/05): whether it has an OIDC client, its public id, the
 * secret's hint, and the redirect URIs Launch will send codes to. Admins register the client,
 * rotate its secret (shown once, `OidcSecretModal`) and edit the URIs; everyone may follow the
 * link to who may sign in.
 */
import { ArrowPathIcon, KeyIcon, PencilSquareIcon } from '@heroicons/react/24/outline'
import {
  type AppOidcClientSecretResponse,
  updateAppRedirectUrisRequestSchema,
} from '@launch/shared/launch-apps'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import {
  ConfirmModal,
  FieldError,
  fieldErrorFor,
  SectionPanel,
  SkeletonRows,
} from '@/ui/components/shared'
import {
  useAppOidcClient,
  useCreateOidcClient,
  useRotateOidcSecret,
  useUpdateRedirectUris,
} from '@/ui/hooks/useApps'
import { formatDateTime } from '@/ui/lib/format'
import { OidcSecretModal } from './OidcSecretModal'

function UriList({ uris }: { uris: string[] }) {
  if (uris.length === 0) return <p className="text-sm text-muted">None</p>
  return (
    <ul className="space-y-1">
      {uris.map(uri => (
        <li key={uri} className="font-mono text-xs break-all">
          {uri}
        </li>
      ))}
    </ul>
  )
}

function RedirectUriEditor({
  appId,
  initial,
  onDone,
}: {
  appId: string
  initial: { redirectUris: string[]; postLogoutRedirectUris: string[] }
  onDone: () => void
}) {
  const update = useUpdateRedirectUris(appId)
  const [redirects, setRedirects] = useState(initial.redirectUris.join('\n'))
  const [logouts, setLogouts] = useState(initial.postLogoutRedirectUris.join('\n'))
  const [issues, setIssues] = useState<{ path: PropertyKey[]; message: string }[]>()
  const lines = (text: string) =>
    text
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean)

  const save = (e: React.FormEvent) => {
    e.preventDefault()
    const parsed = updateAppRedirectUrisRequestSchema.safeParse({
      redirectUris: lines(redirects),
      postLogoutRedirectUris: lines(logouts),
    })
    if (!parsed.success) return setIssues(parsed.error.issues)
    setIssues(undefined)
    update.mutate(parsed.data, { onSuccess: onDone })
  }

  return (
    <form onSubmit={save} className="space-y-3" noValidate>
      <div>
        <label htmlFor="redirect-uris" className="label text-sm">
          Redirect URIs <span className="text-muted">(one per line)</span>
        </label>
        <textarea
          id="redirect-uris"
          className="textarea w-full font-mono text-xs"
          rows={3}
          value={redirects}
          onChange={e => setRedirects(e.target.value)}
        />
        <FieldError message={fieldErrorFor(issues, 'redirectUris')} />
      </div>
      <div>
        <label htmlFor="logout-uris" className="label text-sm">
          Post-logout URIs
        </label>
        <textarea
          id="logout-uris"
          className="textarea w-full font-mono text-xs"
          rows={2}
          value={logouts}
          onChange={e => setLogouts(e.target.value)}
        />
        <FieldError message={fieldErrorFor(issues, 'postLogoutRedirectUris')} />
      </div>
      <div className="flex justify-end gap-2">
        <button type="button" className="btn btn-sm btn-ghost" onClick={onDone}>
          Cancel
        </button>
        <button type="submit" className="btn btn-sm btn-primary" disabled={update.isPending}>
          {update.isPending ? <span className="loading loading-spinner loading-xs" /> : 'Save'}
        </button>
      </div>
    </form>
  )
}

export function OidcClientCard({
  appId,
  slug,
  canManage,
}: {
  appId: string
  slug: string
  canManage: boolean
}) {
  const { data, isLoading } = useAppOidcClient(appId)
  const create = useCreateOidcClient(appId)
  const rotate = useRotateOidcSecret(appId)
  const [secret, setSecret] = useState<AppOidcClientSecretResponse | null>(null)
  const [rotated, setRotated] = useState(false)
  const [confirmRotate, setConfirmRotate] = useState(false)
  const [editing, setEditing] = useState(false)
  const client = data?.client ?? null

  const accessLink = (
    <Link to={`/apps/${encodeURIComponent(slug)}/access`} className="link link-primary text-sm">
      Who can sign in →
    </Link>
  )

  return (
    <SectionPanel
      title={
        <span className="flex items-center gap-2">
          <KeyIcon className="w-4 h-4 text-accent" />
          Sign-in through Launch
        </span>
      }
      description="The app’s OIDC client: Launch is the issuer, the app is the relying party."
      actions={accessLink}
    >
      {isLoading ? (
        <SkeletonRows rows={3} />
      ) : !client ? (
        <div className="surface-inset p-4 flex flex-col sm:flex-row sm:items-center gap-3 justify-between">
          <p className="text-sm text-secondary">
            Not registered yet. Register a client, set three vars and one secret in the app, and its
            people sign in with their Launch account.
          </p>
          {canManage && (
            <button
              type="button"
              className="btn btn-sm btn-primary shrink-0"
              disabled={create.isPending}
              onClick={() =>
                create.mutate(undefined, {
                  onSuccess: result => {
                    setRotated(false)
                    setSecret(result)
                  },
                })
              }
            >
              {create.isPending ? (
                <span className="loading loading-spinner loading-xs" />
              ) : (
                'Register OIDC client'
              )}
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-5">
          <dl className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
            <div>
              <dt className="text-xs text-muted uppercase tracking-wide mb-1">Client ID</dt>
              <dd className="font-mono text-xs break-all">{client.clientId}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted uppercase tracking-wide mb-1">Secret</dt>
              <dd className="font-mono text-xs">
                ••••••••{client.secretHint}
                <span className="block font-sans text-muted mt-0.5">
                  {client.secretRotatedAt
                    ? `rotated ${formatDateTime(client.secretRotatedAt)}`
                    : `set ${formatDateTime(client.createdAt)}`}
                </span>
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted uppercase tracking-wide mb-1">Access</dt>
              <dd>
                <span
                  className="status-badge no-dot"
                  data-status={client.disabledAt ? 'inactive' : 'active'}
                >
                  {client.disabledAt
                    ? 'disabled'
                    : client.accessPolicy === 'restricted'
                      ? 'restricted'
                      : 'whole company'}
                </span>
              </dd>
            </div>
          </dl>

          {editing ? (
            <RedirectUriEditor appId={appId} initial={client} onDone={() => setEditing(false)} />
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <h3 className="text-xs text-muted uppercase tracking-wide mb-1.5">Redirect URIs</h3>
                <UriList uris={client.redirectUris} />
              </div>
              <div>
                <h3 className="text-xs text-muted uppercase tracking-wide mb-1.5">
                  Post-logout URIs
                </h3>
                <UriList uris={client.postLogoutRedirectUris} />
              </div>
            </div>
          )}

          {canManage && !editing && (
            <div className="flex flex-wrap gap-2 pt-1">
              <button type="button" className="btn btn-sm gap-1.5" onClick={() => setEditing(true)}>
                <PencilSquareIcon className="w-4 h-4" />
                Edit URIs
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost gap-1.5"
                onClick={() => setConfirmRotate(true)}
              >
                <ArrowPathIcon className="w-4 h-4" />
                Rotate secret
              </button>
            </div>
          )}
        </div>
      )}

      <ConfirmModal
        isOpen={confirmRotate}
        title="Rotate the client secret?"
        message="The current secret stops working immediately. The app cannot sign anyone in until you set the new one on both environments."
        confirmText="Rotate"
        confirmButtonClass="btn-warning"
        isLoading={rotate.isPending}
        onCancel={() => setConfirmRotate(false)}
        onConfirm={() =>
          rotate.mutate(undefined, {
            onSuccess: result => {
              setConfirmRotate(false)
              setRotated(true)
              setSecret(result)
            },
          })
        }
      />
      <OidcSecretModal result={secret} rotated={rotated} onClose={() => setSecret(null)} />
    </SectionPanel>
  )
}
