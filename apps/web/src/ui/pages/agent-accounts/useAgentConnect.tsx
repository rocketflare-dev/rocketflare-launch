/**
 * Connecting a personal AI account (§18.22), for any surface that offers it (Home's coding agents
 * section): `connect(runtime)` starts the relayed sign-in (`POST /api/me/agent-logins`) — or
 * resumes the one already in flight — and `modal` is the sign-in dialog to render, which polls the
 * login until it ends. The provider's page opens in a new tab (Launch never sees a password);
 * Claude's code is pasted back in the dialog. Each runtime draws its own body
 * (`logins/registry.ts`).
 */
import {
  type AgentAccountsResponse,
  type AgentRuntimeId,
  isActiveAgentLoginStatus,
} from '@launch/shared/launch-agents'
import { useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useEffect, useState } from 'react'
import { Modal, SkeletonRows, showToast } from '@/ui/components/shared'
import {
  useAgentLogin,
  useCancelAgentLogin,
  useStartAgentLogin,
  useSubmitAgentLoginCode,
} from '@/ui/hooks/useAgentAccounts'
import { ApiError } from '@/ui/lib/api-client'
import { queryKeys } from '@/ui/lib/query-keys'
import { AGENT_LOGIN_BODIES } from './logins/registry'

export function useAgentConnect(data: AgentAccountsResponse | undefined): {
  connect: (runtime: AgentRuntimeId) => void
  /** A sign-in for this runtime is already under way (the button says Continue). */
  inFlight: (runtime: AgentRuntimeId) => boolean
  starting: boolean
  startError: string | null
  modal: ReactNode
} {
  const start = useStartAgentLogin()
  const [loginId, setLoginId] = useState<string | null>(null)
  const [startError, setStartError] = useState<string | null>(null)

  const loginFor = (runtime: AgentRuntimeId) =>
    data?.logins.find(l => l.runtime === runtime && isActiveAgentLoginStatus(l.status))

  const connect = (runtime: AgentRuntimeId) => {
    const current = loginFor(runtime)
    if (current) return setLoginId(current.id)
    setStartError(null)
    start.mutate(runtime, {
      onSuccess: ({ login }) => setLoginId(login.id),
      onError: err =>
        setStartError(err instanceof ApiError ? err.message : 'The sign-in could not start.'),
    })
  }

  return {
    connect,
    inFlight: runtime => Boolean(loginFor(runtime)),
    starting: start.isPending,
    startError,
    modal: loginId ? <AgentLoginModal loginId={loginId} onClose={() => setLoginId(null)} /> : null,
  }
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
