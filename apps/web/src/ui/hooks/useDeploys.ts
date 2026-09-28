/**
 * An app's deploys (Launch P2, DEPLOYER.md): `GET /api/apps/:id/deploys` (newest first), a decision
 * on a `pending` production ticket, and "Deploy to production" — from P4 a `deploy.production`
 * approval (approve → a pre-approved ticket plus the `deploy.yml` dispatch).
 *
 * Polling (ui.md): only while a deploy is IN FLIGHT — `approved` (a run is claiming it, and not
 * past its expiry) or `uploaded` (the build is on Cloudflare, activation is next). A `pending`
 * ticket waits on a PERSON, not the server, so it is not polled: the approver's own click refreshes
 * it, and the deployer's own wait (`WAIT_SECONDS`) is the clock. `active` is not polled either — it
 * is deployed, and the `finish` that settles it changes nothing a reader acts on.
 *
 * `useDeployProgress` is the overview's stepper (`GET /api/apps/:id/deploys/latest`, each
 * environment's newest deploy with its phase — dispatched → approved → uploaded → migrating →
 * activating → done, or failed). It polls every `DEPLOY_PROGRESS_POLL_MS` while a deploy is in
 * progress and not waiting on a person (`deployProgressPollInterval`, which the catalogue's
 * `useApps` shares), and the moment none is, it refreshes the rest of the `apps` family once — the
 * environments' versions, the deploys list and the catalogue moved with it.
 */
import {
  type AppDeployProgressResponse,
  appDeployProgressResponseSchema,
  type DeployProgress,
} from '@launch/shared/launch-apps'
import {
  type DeployDecision,
  type DeployTicket,
  deployTicketListResponseSchema,
  deployTicketSchema,
  productionDeployResponseSchema,
} from '@launch/shared/launch-pipeline'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { api } from '@/ui/lib/api-client'
import { queryKeys } from '@/ui/lib/query-keys'

export const DEPLOYS_POLL_MS = 5000

/** Whether the server still owes an answer on this ticket (see the header). Pure. */
export function deployInFlight(
  ticket: Pick<DeployTicket, 'status' | 'expiresAt'>,
  now = Date.now()
): boolean {
  if (ticket.status === 'uploaded') return true
  if (ticket.status !== 'approved') return false
  return !ticket.expiresAt || ticket.expiresAt.getTime() > now
}

/** `refetchInterval` for the deploys list: poll while any ticket is in flight. Pure. */
export function deploysPollInterval(
  items: readonly Pick<DeployTicket, 'status' | 'expiresAt'>[] | undefined,
  now = Date.now()
): number | false {
  return items?.some(t => deployInFlight(t, now)) ? DEPLOYS_POLL_MS : false
}

export function useDeploys(appId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: queryKeys.apps.deploys(appId ?? ''),
    queryFn: () =>
      api.get(`/api/apps/${appId}/deploys`, { schema: deployTicketListResponseSchema }),
    enabled: Boolean(appId) && enabled,
    refetchInterval: q => deploysPollInterval(q.state.data?.items),
  })
}

/** How often a reader re-reads while a deploy is in progress. */
export const DEPLOY_PROGRESS_POLL_MS = 5000

/**
 * `refetchInterval` for anything carrying deploy progress (the overview, the catalogue): poll
 * while one is IN PROGRESS and does not wait on a person — `awaiting_approval` changes when
 * somebody decides, and the decider's own click refreshes it. Pure.
 */
export function deployProgressPollInterval(
  items: readonly (Pick<DeployProgress, 'inProgress' | 'phase'> | null | undefined)[] | undefined
): number | false {
  return items?.some(d => d?.inProgress && d.phase !== 'awaiting_approval')
    ? DEPLOY_PROGRESS_POLL_MS
    : false
}

/** Whether any deploy in `data` still runs (the transition the effect below watches). Pure. */
function anyRunning(data: AppDeployProgressResponse | undefined): boolean {
  return deployProgressPollInterval(data?.items) !== false
}

export function useDeployProgress(appId: string | undefined, enabled = true) {
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: queryKeys.apps.deployProgress(appId ?? ''),
    queryFn: () =>
      api.get(`/api/apps/${appId}/deploys/latest`, { schema: appDeployProgressResponseSchema }),
    enabled: Boolean(appId) && enabled,
    refetchInterval: q => deployProgressPollInterval(q.state.data?.items),
  })
  // A deploy just settled (live or failed): the rest of the app moved with it — once.
  const running = anyRunning(query.data)
  const wasRunning = useRef(running)
  useEffect(() => {
    if (wasRunning.current && !running) {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.apps.all,
        predicate: q => q.queryKey[1] !== 'deploy-progress',
      })
    }
    wasRunning.current = running
  }, [running, queryClient])
  return query
}

export function useDecideDeploy(appId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ ticketId, ...body }: DeployDecision & { ticketId: string }) =>
      // A 409 (someone else decided, or it expired) is information, rendered in place: no toast.
      api.post(`/api/apps/${appId}/deploys/${ticketId}/decide`, body, {
        schema: deployTicketSchema,
        showErrorToast: false,
      }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.apps.deploys(appId) }),
  })
}

export function useDeployProduction(appId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () =>
      // P4: the answer is either a pre-approved ticket (a deployment without the approvals
      // engine) or `{ ticket: null, approvalId }` — the caller says which, and goes to the request.
      api.post(`/api/apps/${appId}/deploys/production`, undefined, {
        schema: productionDeployResponseSchema,
        showErrorToast: true,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.apps.deploys(appId) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.approvals.all })
    },
  })
}
