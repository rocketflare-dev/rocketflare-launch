/**
 * Ask for a shared resource on an app (Launch P5, plan §1.7): which environments, why, and an
 * optional lapse. One `grant.request` approval opens per environment, decided by the resource's
 * owner team — so the modal says who decides, and what the app would receive (item NAMES only).
 *
 * Validated with `requestGrantSchema`, the same schema the route applies. The server's refusals
 * (already held, no values yet, grants not set up) are sentences in the modal, never a toast.
 */
import { APP_ENVIRONMENT_NAMES, type AppEnvironmentName } from '@launch/shared/launch-apps'
import {
  type AppConfigMatch,
  GRANT_ERROR_CODES,
  GRANT_REASON_MAX,
  requestGrantSchema,
} from '@launch/shared/launch-grants'
import { useState } from 'react'
import { FieldError, Modal, showToast } from '@/ui/components/shared'
import { useRequestGrant } from '@/ui/hooks/useAppConfig'
import { ApiError } from '@/ui/lib/api-client'
import { ENV_STATE, envGrantState, mayRequest, missingEnvironments } from './configModel'

/** A request refusal → the sentence the modal shows. Pure. */
export function requestRefusal(error: unknown, resourceName: string): string {
  if (!(error instanceof ApiError)) return 'The request could not be sent. Try again.'
  switch (error.code) {
    case GRANT_ERROR_CODES.alreadyHeld:
      return `This app already holds ${resourceName} there, or has already asked for it.`
    case GRANT_ERROR_CODES.valuesNotSet:
      return `${resourceName} has no values in that environment yet. Ask its owners to set them first.`
    case GRANT_ERROR_CODES.resourceArchived:
      return `${resourceName} is archived: no new grants.`
    case GRANT_ERROR_CODES.notConfigured:
      return 'Shared config is not set up on this deployment yet. Ask an administrator.'
    default:
      return error.message
  }
}

export function RequestGrantModal({
  appId,
  appName,
  match,
  open,
  onClose,
}: {
  appId: string
  appName: string
  match: AppConfigMatch
  open: boolean
  onClose: () => void
}) {
  const request = useRequestGrant(appId)
  const [environments, setEnvironments] = useState<AppEnvironmentName[]>(() =>
    missingEnvironments(match)
  )
  const [reason, setReason] = useState('')
  const [expires, setExpires] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const resource = match.resource

  const submit = () => {
    const parsed = requestGrantSchema.safeParse({
      resourceId: resource.id,
      environments,
      reason,
      ...(expires ? { expiresAt: new Date(`${expires}T23:59:59`) } : {}),
    })
    if (!parsed.success) {
      const next: Record<string, string> = {}
      for (const issue of parsed.error.issues) next[String(issue.path[0])] ??= issue.message
      if (next.environments) next.environments = 'Pick at least one environment'
      setErrors(next)
      return
    }
    if (parsed.data.expiresAt && parsed.data.expiresAt.getTime() <= Date.now()) {
      setErrors({ expiresAt: 'Pick a date in the future' })
      return
    }
    setErrors({})
    request.mutate(parsed.data, {
      onSuccess: answer => {
        const envs = answer.grants.map(g => g.environment).join(' and ')
        showToast(
          `Asked for ${resource.displayName} in ${envs}. Its owner team decides.`,
          'success'
        )
        onClose()
      },
    })
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Request ${resource.displayName}`}
      className="max-w-lg"
      actions={
        <>
          <button type="button" className="btn btn-sm btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={request.isPending}
            onClick={submit}
          >
            {request.isPending && <span className="loading loading-spinner loading-xs" />}
            Send request
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <p>
          {appName} would receive{' '}
          {resource.items.map((item, i) => (
            <span key={item.key}>
              {i > 0 && ', '}
              <span className="font-mono text-xs">{item.key}</span>
            </span>
          ))}{' '}
          as Worker secrets. The team that owns {resource.displayName} decides; one request opens
          per environment.
        </p>

        <fieldset>
          <legend className="text-xs text-muted mb-1">Environments</legend>
          <div className="flex flex-wrap gap-4">
            {APP_ENVIRONMENT_NAMES.map(env => {
              const state = envGrantState(match.grants[env])
              const allowed = mayRequest(state)
              return (
                <label key={env} className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    className="checkbox checkbox-sm"
                    checked={environments.includes(env)}
                    disabled={!allowed}
                    onChange={event =>
                      setEnvironments(current =>
                        event.target.checked
                          ? APP_ENVIRONMENT_NAMES.filter(e => e === env || current.includes(e))
                          : current.filter(e => e !== env)
                      )
                    }
                  />
                  <span className="capitalize">{env}</span>
                  {!allowed && (
                    <span className="text-xs text-muted">
                      ({ENV_STATE[state].label.toLowerCase()})
                    </span>
                  )}
                </label>
              )
            })}
          </div>
          <FieldError message={errors.environments} />
        </fieldset>

        <div>
          <label htmlFor="grant-reason" className="text-xs text-muted">
            Why the app needs it (shown to the owner team)
          </label>
          <textarea
            id="grant-reason"
            className="textarea w-full text-sm mt-1"
            rows={3}
            maxLength={GRANT_REASON_MAX}
            value={reason}
            aria-invalid={Boolean(errors.reason)}
            onChange={event => setReason(event.target.value)}
          />
          <FieldError message={errors.reason} />
        </div>

        <div>
          <label htmlFor="grant-expires" className="text-xs text-muted">
            Lapses on (optional — blank keeps it until revoked)
          </label>
          <input
            id="grant-expires"
            type="date"
            className="input input-sm w-full mt-1"
            value={expires}
            onChange={event => setExpires(event.target.value)}
          />
          <FieldError message={errors.expiresAt} />
        </div>

        {request.error && (
          <div className="alert alert-warning alert-soft text-sm" role="alert">
            <span>{requestRefusal(request.error, resource.displayName)}</span>
          </div>
        )}
      </div>
    </Modal>
  )
}
