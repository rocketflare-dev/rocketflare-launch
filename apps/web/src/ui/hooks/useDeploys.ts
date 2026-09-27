/**
 * An app's deploys (Launch P2, DEPLOYER.md): `GET /api/apps/:id/deploys` (newest first), a decision
 * on a `pending` production ticket, and "Deploy to production" — a pre-approved ticket plus the
 * `deploy.yml` dispatch.
 *
 * Polling (ui.md): only while a deploy is IN FLIGHT — `approved` (a run is claiming it, and not
 * past its expiry) or `uploaded` (the build is on Cloudflare, activation is next). A `pending`
 * ticket waits on a PERSON, not the server, so it is not polled: the approver's own click refreshes
 * it, and the deployer's own wait (`WAIT_SECONDS`) is the clock. `active` is not polled either — it
 * is deployed, and the `finish` that settles it changes nothing a reader acts on.
 */
import {
  type DeployDecision,
  type DeployTicket,
  deployTicketListResponseSchema,
  deployTicketSchema,
  productionDeployResponseSchema,
} from '@launch/shared/launch-pipeline'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
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
      api.post(`/api/apps/${appId}/deploys/production`, undefined, {
        schema: productionDeployResponseSchema,
        showErrorToast: true,
        showSuccessToast: true,
        successMessage: 'Production deploy started',
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.apps.deploys(appId) }),
  })
}
