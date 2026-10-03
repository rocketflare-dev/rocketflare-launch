/**
 * Personal AI accounts (§18.22): `GET /api/me/agent-credentials` (what this deployment offers and
 * what the person has connected — the Profile panel and the session picker both read it), and the
 * relayed sign-in: start it, poll it while the server still owes an answer, paste a code back,
 * cancel it, disconnect. Routes START a sign-in; a Workflow runs it in a sandbox — so the modal
 * polls the login row, never a stream.
 *
 * Polling is a pure decision on the cached row (`agentLoginPollInterval`, ui.md): a login waiting
 * on the PERSON (the URL is up and no code has been pasted) is polled slowly — the person may
 * finish at the provider (Codex) or paste (Claude); one waiting on the Workflow (`starting`,
 * `submitting`, `finishing`) quickly; a finished one never.
 */
import {
  type AgentLogin,
  type AgentRuntimeId,
  agentAccountsResponseSchema,
  agentLoginResponseSchema,
  isActiveAgentLoginStatus,
} from '@launch/shared/launch-agents'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/ui/lib/api-client'
import { queryKeys } from '@/ui/lib/query-keys'

const BASE = '/api/me'

/** While the Workflow is working on it. */
export const AGENT_LOGIN_POLL_MS = 1500
/** While it waits on the person (the URL is shown; Codex finishes at the provider). */
export const AGENT_LOGIN_IDLE_POLL_MS = 3000

/** `refetchInterval` for one login. Pure. */
export function agentLoginPollInterval(
  login: Pick<AgentLogin, 'status' | 'needsCode'> | undefined
): number | false {
  if (!login || !isActiveAgentLoginStatus(login.status)) return false
  if (login.status === 'awaiting_user') {
    // Claude waits for a paste in THIS tab — nothing changes until the person acts.
    return login.needsCode ? false : AGENT_LOGIN_IDLE_POLL_MS
  }
  return AGENT_LOGIN_POLL_MS
}

export function useAgentAccounts(enabled = true) {
  return useQuery({
    queryKey: queryKeys.agentAccounts.list,
    // An auxiliary read (the panel and the picker hide without it): never a toast.
    queryFn: () =>
      api.get(`${BASE}/agent-credentials`, {
        schema: agentAccountsResponseSchema,
        showErrorToast: false,
      }),
    retry: false,
    enabled,
  })
}

export function useAgentLogin(id: string | null) {
  return useQuery({
    queryKey: queryKeys.agentAccounts.login(id ?? 'none'),
    queryFn: () =>
      api.get(`${BASE}/agent-logins/${id}`, {
        schema: agentLoginResponseSchema,
        showErrorToast: false,
      }),
    enabled: Boolean(id),
    select: data => data.login,
    refetchInterval: query => agentLoginPollInterval(query.state.data?.login),
  })
}

function useLoginMutation<TBody>(request: (body: TBody) => Promise<{ login: AgentLogin }>) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: request,
    onSuccess: ({ login }) => {
      queryClient.setQueryData(queryKeys.agentAccounts.login(login.id), { login })
      void queryClient.invalidateQueries({ queryKey: queryKeys.agentAccounts.list })
    },
  })
}

export function useStartAgentLogin() {
  return useLoginMutation((runtime: AgentRuntimeId) =>
    api.post(
      `${BASE}/agent-logins`,
      { runtime },
      { schema: agentLoginResponseSchema, showErrorToast: false }
    )
  )
}

export function useSubmitAgentLoginCode(id: string) {
  return useLoginMutation((code: string) =>
    api.post(
      `${BASE}/agent-logins/${id}/code`,
      { code },
      { schema: agentLoginResponseSchema, showErrorToast: false }
    )
  )
}

export function useCancelAgentLogin(id: string) {
  return useLoginMutation(() =>
    api.post(`${BASE}/agent-logins/${id}/cancel`, undefined, {
      schema: agentLoginResponseSchema,
      showErrorToast: false,
    })
  )
}

export function useDisconnectAgentAccount() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (runtime: AgentRuntimeId) =>
      api.delete<undefined>(`${BASE}/agent-credentials/${runtime}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.agentAccounts.all }),
  })
}
