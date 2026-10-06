/**
 * Where a new coding session's container runs — `launch_settings.session_sandbox_host`, the
 * Session sandbox section of Settings → Coding agents (`pages/platform/CodingAgents.tsx`,
 * below the agents table). Two choices (`sessionSandboxStatusSchema`): this Worker's own containers
 * (local Docker under `pnpm dev`, Cloudflare's when deployed) and the remote sandbox host
 * (development only). The server says whether each can run a session right now and, if not, why —
 * an unavailable one is disabled with that sentence under it. Deployed, only the first is offered.
 *
 * A change applies to NEW sessions: each session froze its host at create. The page keys the card
 * by the stored choice (`sessionSandboxKey`), so a save starts the draft afresh.
 */
import type { SessionSandboxHost, SessionSandboxStatus } from '@launch/shared/launch-setup'
import { type FormEvent, useState } from 'react'
import { useUpdateSessionSandbox } from '@/ui/hooks/useSetup'
import { stepAnchor } from './StepCard'

const HEADING_ID = 'setup-session-sandbox-title'

/** One line on what each choice is. */
const DESCRIPTION: Record<SessionSandboxHost, string> = {
  local: 'Local Docker under pnpm dev; Cloudflare containers when Launch is deployed.',
  remote: 'A real Cloudflare container in the launch-sandbox-dev Worker. Development only.',
}

/** The card's React key: the stored choice, so it remounts only when that changes. */
export function sessionSandboxKey(status: SessionSandboxStatus): string {
  return `${status.host}:${status.isDefault}`
}

export function SessionSandboxCard({ sessionSandbox }: { sessionSandbox: SessionSandboxStatus }) {
  const update = useUpdateSessionSandbox()
  const [draft, setDraft] = useState<SessionSandboxHost>(sessionSandbox.host)
  const chosen = sessionSandbox.options.find(o => o.host === draft)
  const current = sessionSandbox.options.find(o => o.host === sessionSandbox.host)
  const dirty = draft !== sessionSandbox.host

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (!dirty || !chosen?.available) return
    update.mutate({ host: draft })
  }

  return (
    <section
      id={stepAnchor('session-sandbox')}
      aria-labelledby={HEADING_ID}
      className="surface-panel p-5 space-y-4 scroll-mt-6"
    >
      <header className="min-w-0">
        <h2 id={HEADING_ID} className="text-base font-semibold leading-6">
          Session sandbox
        </h2>
        <p className="text-sm text-secondary mt-0.5">
          Where a new coding session's container runs.
        </p>
      </header>

      <form className="space-y-4" onSubmit={onSubmit}>
        <div role="radiogroup" aria-labelledby={HEADING_ID} className="space-y-3">
          {sessionSandbox.options.map(option => {
            const id = `session-sandbox-${option.host}`
            return (
              <div key={option.host} className="flex items-start gap-3">
                <input
                  id={id}
                  type="radio"
                  className="radio radio-sm mt-0.5"
                  name="session-sandbox-host"
                  checked={draft === option.host}
                  disabled={!option.available}
                  aria-describedby={`${id}-detail`}
                  onChange={() => setDraft(option.host)}
                />
                <div className="min-w-0 text-sm leading-5">
                  <label
                    htmlFor={id}
                    className={option.available ? 'font-medium' : 'font-medium text-muted'}
                  >
                    {option.label}
                  </label>
                  <div id={`${id}-detail`} className="text-xs text-muted">
                    {DESCRIPTION[option.host]}
                  </div>
                  {option.reason && (
                    <div className="text-xs text-warning mt-0.5">{option.reason}</div>
                  )}
                </div>
              </div>
            )
          })}
        </div>

        {current && !current.available && !dirty && (
          <p className="text-sm text-warning" role="status">
            New sessions cannot start until this is available again or you choose the other host.
          </p>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted">
            Applies to new sessions. Running sessions keep the host they started on.
          </p>
          <div className="flex items-center gap-2">
            {update.error && (
              <span className="text-sm text-error" role="alert">
                {update.error.message}
              </span>
            )}
            {dirty && (
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                disabled={update.isPending}
                onClick={() => setDraft(sessionSandbox.host)}
              >
                Discard
              </button>
            )}
            <button
              type="submit"
              className="btn btn-sm btn-primary"
              disabled={!dirty || !chosen?.available || update.isPending}
            >
              Save
            </button>
          </div>
        </div>
      </form>
    </section>
  )
}
