/**
 * Your AI accounts (§18.22) — the Profile panel where a person connects their own Claude
 * subscription or ChatGPT plan, so coding sessions can bill it instead of Launch's key.
 *
 * - **Hidden unless an admin allows it**: only runtimes with `userCredentials` (the Setup page's
 *   Coding agents card set "Who pays" to the person's own account, or Either — off by default)
 *   get a row, and with none the panel renders nothing at all.
 * - **Connect** starts the relayed sign-in (`POST /api/me/agent-logins`) and opens a modal that
 *   polls it: the provider's page opens in a new tab (Launch never sees a password), and Claude's
 *   code is pasted back here. The body is the runtime's own component (`agent-logins/registry.ts`).
 *   A sign-in already in flight is resumed, not restarted.
 * - **Disconnect** deletes the stored credential. A credential the provider refused reads "needs
 *   reconnecting"; one close to expiry says when.
 */
import {
  AGENT_CREDENTIAL_EXPIRY_WARNING_DAYS,
  type AgentCredential,
  type AgentRuntimeId,
  type AgentRuntimeOption,
  isActiveAgentLoginStatus,
} from '@launch/shared/launch-agents'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Modal, SectionPanel, SkeletonRows, showToast } from '@/ui/components/shared'
import {
  useAgentAccounts,
  useAgentLogin,
  useCancelAgentLogin,
  useDisconnectAgentAccount,
  useStartAgentLogin,
  useSubmitAgentLoginCode,
} from '@/ui/hooks/useAgentAccounts'
import { ApiError } from '@/ui/lib/api-client'
import { formatDate } from '@/ui/lib/format'
import { queryKeys } from '@/ui/lib/query-keys'
import { AGENT_LOGIN_BODIES } from './agent-logins/registry'

const DAY_MS = 24 * 60 * 60 * 1000

/** What the row says about a connected credential. Pure. */
export function credentialStatusText(
  credential: AgentCredential | undefined,
  now: Date = new Date()
): { text: string; tone: 'muted' | 'warning' } {
  if (!credential) return { text: 'Not connected', tone: 'muted' }
  if (credential.status === 'needs_login') return { text: 'Needs reconnecting', tone: 'warning' }
  if (credential.expiresAt) {
    const left = credential.expiresAt.getTime() - now.getTime()
    if (left <= 0) return { text: 'Expired — reconnect it', tone: 'warning' }
    if (left < AGENT_CREDENTIAL_EXPIRY_WARNING_DAYS * DAY_MS) {
      return { text: `Expires ${formatDate(credential.expiresAt)}`, tone: 'warning' }
    }
  }
  return { text: credential.inUse ? 'Connected · in use' : 'Connected', tone: 'muted' }
}

/** The runtimes a person may connect an account for. Pure. */
export function connectableRuntimes(runtimes: readonly AgentRuntimeOption[]) {
  return runtimes.filter(r => r.enabled && r.userCredentials)
}

export function AgentAccountsPanel() {
  const { data, isLoading } = useAgentAccounts()
  const disconnect = useDisconnectAgentAccount()
  const start = useStartAgentLogin()
  const [loginId, setLoginId] = useState<string | null>(null)
  const [startError, setStartError] = useState<string | null>(null)

  const runtimes = connectableRuntimes(data?.runtimes ?? [])
  if (isLoading) return null
  if (runtimes.length === 0) return null

  const credentialFor = (runtime: AgentRuntimeId) =>
    data?.credentials.find(c => c.runtime === runtime)
  const loginFor = (runtime: AgentRuntimeId) =>
    data?.logins.find(l => l.runtime === runtime && isActiveAgentLoginStatus(l.status))

  const connect = (runtime: AgentRuntimeId) => {
    const inFlight = loginFor(runtime)
    if (inFlight) return setLoginId(inFlight.id)
    setStartError(null)
    start.mutate(runtime, {
      onSuccess: ({ login }) => setLoginId(login.id),
      onError: err =>
        setStartError(err instanceof ApiError ? err.message : 'The sign-in could not start.'),
    })
  }

  return (
    <SectionPanel
      title="AI accounts"
      description="Connect your own AI subscription so your coding sessions can run on it instead of the organisation's key."
    >
      {!data ? (
        <SkeletonRows rows={2} />
      ) : (
        <ul className="divide-y divide-[color:var(--border-subtle)]">
          {runtimes.map(option => {
            const credential = credentialFor(option.runtime)
            const status = credentialStatusText(credential)
            const reconnect = credential && status.tone === 'warning'
            return (
              <li key={option.runtime} className="flex items-center gap-3 py-3">
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium">{option.accountLabel}</div>
                  <div
                    className={`text-xs ${status.tone === 'warning' ? 'text-warning' : 'text-muted'}`}
                  >
                    {status.text} · for {option.label} sessions
                  </div>
                </div>
                {(!credential || reconnect) && (
                  <button
                    type="button"
                    className="btn btn-outline btn-xs"
                    disabled={start.isPending}
                    onClick={() => connect(option.runtime)}
                  >
                    {loginFor(option.runtime) ? 'Continue' : reconnect ? 'Reconnect' : 'Connect'}
                  </button>
                )}
                {credential && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-xs"
                    disabled={disconnect.isPending}
                    onClick={() =>
                      disconnect.mutate(option.runtime, {
                        onSuccess: () =>
                          showToast(`${option.accountLabel} disconnected`, 'success'),
                      })
                    }
                  >
                    Disconnect
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {startError && (
        <div className="alert alert-soft alert-warning mt-3 text-sm" role="status">
          {startError}
        </div>
      )}
      {loginId && <AgentLoginModal loginId={loginId} onClose={() => setLoginId(null)} />}
    </SectionPanel>
  )
}

/** The sign-in in flight: polls the login row until it ends. */
function AgentLoginModal({ loginId, onClose }: { loginId: string; onClose: () => void }) {
  const queryClient = useQueryClient()
  const { data: login } = useAgentLogin(loginId)
  const submit = useSubmitAgentLoginCode(loginId)
  const cancel = useCancelAgentLogin(loginId)
  const active = login ? isActiveAgentLoginStatus(login.status) : true

  useEffect(() => {
    if (login?.status !== 'succeeded') return
    void queryClient.invalidateQueries({ queryKey: queryKeys.agentAccounts.list })
    showToast('Account connected', 'success')
    onClose()
  }, [login?.status, queryClient, onClose])

  const Body = login ? AGENT_LOGIN_BODIES[login.runtime] : null
  const submitError =
    submit.error instanceof ApiError
      ? submit.error.message
      : submit.error
        ? 'The code could not be sent.'
        : null

  return (
    <Modal
      open
      onClose={onClose}
      title="Connect your account"
      actions={
        active ? (
          <button
            type="button"
            className="btn btn-sm"
            disabled={cancel.isPending}
            onClick={() => cancel.mutate(undefined, { onSettled: onClose })}
          >
            Cancel sign-in
          </button>
        ) : (
          <button type="button" className="btn btn-sm" onClick={onClose}>
            Close
          </button>
        )
      }
    >
      {login && Body ? (
        <Body
          login={login}
          onSubmitCode={code => submit.mutate(code)}
          submitting={submit.isPending}
          submitError={submitError}
        />
      ) : (
        <SkeletonRows rows={2} />
      )}
    </Modal>
  )
}
