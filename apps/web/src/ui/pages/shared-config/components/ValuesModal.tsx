/**
 * Set one environment's values of a shared resource (Launch P5, plan §1.2–§1.3). WRITE-ONLY:
 *
 * - inputs are never pre-filled — a key the active version already carries shows "Set — hidden"
 *   and a Replace button that opens an empty input; a blank field keeps the current value (the
 *   server merges), so rotating the secret alone never needs the tenant id retyped;
 * - secrets are `type=password`; vars are plain text (their value is not secret, plan §1.3), but
 *   they are not pre-filled either — the environment card shows owners what is set;
 * - "Use the same values for <the other environment>" sends the same body there too, after this one;
 * - when apps hold the environment, saving is a ROTATION: the modal says so and names the count,
 *   and the page shows the push it started.
 *
 * Validated with `putSharedResourceValuesSchema`, the route's own. Nothing typed here is ever
 * rendered back, logged or kept after the modal closes (it unmounts).
 */
import { EyeIcon, EyeSlashIcon } from '@heroicons/react/24/outline'
import { APP_ENVIRONMENT_NAMES, type AppEnvironmentName } from '@launch/shared/launch-apps'
import {
  GRANT_ERROR_CODES,
  putSharedResourceValuesSchema,
  SHARED_RESOURCE_VALUE_MAX,
  type SharedResourceDetail,
} from '@launch/shared/launch-grants'
import { useState } from 'react'
import { FieldError, Modal, showToast } from '@/ui/components/shared'
import { useSetSharedResourceValues } from '@/ui/hooks/useSharedResources'
import { ApiError } from '@/ui/lib/api-client'
import { holdersLine } from '../sharedConfigModel'

/** A values refusal → the modal's sentence. Pure. */
export function valuesRefusal(error: unknown): string {
  if (!(error instanceof ApiError)) return 'The values could not be saved. Try again.'
  switch (error.code) {
    case GRANT_ERROR_CODES.pushInProgress:
      return 'A push is still running for this environment. Wait for it to finish, then save again.'
    case GRANT_ERROR_CODES.notResourceOwner:
      return 'Only the owner team and admins set values.'
    case GRANT_ERROR_CODES.resourceArchived:
      return 'This resource is archived: it takes no new values.'
    case GRANT_ERROR_CODES.unknownItemKey:
      return 'A key is not one of this resource’s items. Reload the page and try again.'
    case GRANT_ERROR_CODES.notConfigured:
      return 'Pushing is not set up on this deployment yet. Ask an administrator.'
    default:
      return error.message
  }
}

function SecretInput({
  id,
  secret,
  value,
  onChange,
  placeholder,
}: {
  id: string
  secret: boolean
  value: string
  onChange: (value: string) => void
  placeholder: string
}) {
  const [shown, setShown] = useState(false)
  return (
    <div className="join w-full">
      <input
        id={id}
        // Never pre-filled, never offered to a password manager as a login.
        type={secret && !shown ? 'password' : 'text'}
        autoComplete="new-password"
        spellCheck={false}
        className="input input-sm join-item w-full font-mono"
        maxLength={SHARED_RESOURCE_VALUE_MAX}
        value={value}
        placeholder={placeholder}
        onChange={event => onChange(event.target.value)}
      />
      {secret && (
        <button
          type="button"
          className="btn btn-sm join-item"
          aria-label={shown ? 'Hide what you typed' : 'Show what you typed'}
          onClick={() => setShown(s => !s)}
        >
          {shown ? <EyeSlashIcon className="w-4 h-4" /> : <EyeIcon className="w-4 h-4" />}
        </button>
      )}
    </div>
  )
}

export function ValuesModal({
  resource,
  environment,
  open,
  onClose,
  onSaved,
}: {
  resource: SharedResourceDetail
  environment: AppEnvironmentName
  open: boolean
  onClose: () => void
  /** Called once per environment written, with the push it started (null: nobody holds it). */
  onSaved?: (environment: AppEnvironmentName, pushId: string | null) => void
}) {
  const save = useSetSharedResourceValues(resource.id)
  const env = resource.environments.find(e => e.environment === environment)
  const other = APP_ENVIRONMENT_NAMES.find(e => e !== environment) ?? null
  const otherEnv = resource.environments.find(e => e.environment === other)
  const keysSet = new Set(env?.keysSet ?? [])
  const [values, setValues] = useState<Record<string, string>>({})
  const [replacing, setReplacing] = useState<Set<string>>(new Set())
  const [alsoOther, setAlsoOther] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const holders = env?.holderCount ?? 0
  const otherHolders = otherEnv?.holderCount ?? 0

  const submit = async () => {
    const typed = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== ''))
    if (Object.keys(typed).length === 0) {
      setError('Type at least one value — a blank field keeps what is set.')
      return
    }
    const parsed = putSharedResourceValuesSchema.safeParse({ values: typed })
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Check the values')
      return
    }
    setError(null)
    const targets = alsoOther && other ? [environment, other] : [environment]
    try {
      for (const target of targets) {
        const answer = await save.mutateAsync({ environment: target, ...parsed.data })
        showToast(
          answer.pushId
            ? `Version ${answer.version} set for ${target}. Pushing it to the apps that hold it.`
            : `Version ${answer.version} set for ${target}.`,
          'success'
        )
        onSaved?.(target, answer.pushId)
      }
      onClose()
    } catch {
      // `save.error` holds it; the alert below renders it.
    }
  }

  const rotating = holders > 0 || (alsoOther && otherHolders > 0)

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`${env?.version ? 'Replace' : 'Set'} ${resource.displayName} values for ${environment}`}
      className="max-w-xl"
      actions={
        <>
          <button type="button" className="btn btn-sm btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={save.isPending}
            onClick={() => void submit()}
          >
            {save.isPending && <span className="loading loading-spinner loading-xs" />}
            {rotating ? 'Save and push' : 'Save'}
          </button>
        </>
      }
    >
      <form
        className="space-y-4"
        autoComplete="off"
        noValidate
        onSubmit={event => {
          event.preventDefault()
          void submit()
        }}
      >
        <p>
          Values are write-only: nobody — you included — can read a secret back. A blank field keeps
          the value that is set now.
        </p>
        {holders > 0 && (
          <div className="alert alert-warning alert-soft text-sm" role="status">
            <span>
              {holdersLine(holders)} in {environment}. Saving writes a new version and pushes it to
              every one of them — a rotation.
            </span>
          </div>
        )}

        <ul className="space-y-3" aria-label="Values">
          {resource.items.map(item => {
            const set = keysSet.has(item.key)
            const editing = !set || replacing.has(item.key)
            const inputId = `value-${item.key}`
            return (
              <li key={item.key} data-key={item.key}>
                <div className="flex items-center justify-between gap-2">
                  <label htmlFor={inputId} className="font-mono text-xs text-primary">
                    {item.key}
                  </label>
                  <span className="status-badge no-dot" data-status="draft">
                    {item.kind}
                  </span>
                </div>
                {item.description && (
                  <p className="text-xs text-muted mt-0.5">{item.description}</p>
                )}
                <div className="mt-1">
                  {editing ? (
                    <SecretInput
                      id={inputId}
                      secret={item.kind === 'secret'}
                      value={values[item.key] ?? ''}
                      placeholder={set ? 'Blank keeps the current value' : 'Not set yet'}
                      onChange={value => setValues(current => ({ ...current, [item.key]: value }))}
                    />
                  ) : (
                    <div className="flex items-center justify-between gap-2 surface-inset rounded-md px-3 py-1.5">
                      <span className="text-sm text-muted" data-testid={`hidden-${item.key}`}>
                        Set — hidden
                      </span>
                      <button
                        type="button"
                        className="btn btn-xs"
                        onClick={() => setReplacing(current => new Set(current).add(item.key))}
                      >
                        Replace
                      </button>
                    </div>
                  )}
                </div>
              </li>
            )
          })}
        </ul>

        {other && (
          <label className="flex items-start gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              className="checkbox checkbox-sm mt-0.5"
              checked={alsoOther}
              onChange={event => setAlsoOther(event.target.checked)}
            />
            <span>
              Use the same values for {other}
              {otherHolders > 0 && (
                <span className="block text-xs text-muted">
                  {holdersLine(otherHolders)} there too — they are pushed as well.
                </span>
              )}
            </span>
          </label>
        )}

        <FieldError message={error} />
        {save.error && (
          <div className="alert alert-error alert-soft text-sm" role="alert">
            <span>{valuesRefusal(save.error)}</span>
          </div>
        )}
        {/* Enter submits the form without a visible second submit button. */}
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </Modal>
  )
}
