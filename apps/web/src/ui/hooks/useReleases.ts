/**
 * An app's releases (Launch P4, plan §1.8) over `/api/apps/:id/releases`: the list, cutting one
 * (`POST {bump}` — bump, tag, PR list), promoting one to production (`POST …/promote`, which opens
 * a `deploy.production` approval and answers its id), and a release's audit chain.
 *
 * Every key sits under the `release` root (`queryKeys.releases`, = `RELEASE_REALTIME_ENTITY`), so
 * the server's `entity.changed { entity: 'release' }` nudge refreshes the card with no socket code
 * here.
 *
 * Polling (ui.md) — only while the SERVER owes an answer: `tagged` (the tag's staging run is about
 * to start), `staging` (it is deploying) and `promoting` (the production run is deploying).
 * `staging_active` waits on a person to promote and `awaiting_approval` on an approver, so neither
 * polls; the rest are settled.
 */
import type { ApprovalDetail } from '@launch/shared/launch-approvals'
import {
  type CreateReleaseRequest,
  type PromoteReleaseRequest,
  promoteReleaseResponseSchema,
  type Release,
  type ReleaseStatus,
  releaseChainSchema,
  releaseListResponseSchema,
  releaseSchema,
} from '@launch/shared/launch-releases'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/ui/lib/api-client'
import { queryKeys } from '@/ui/lib/query-keys'

export const RELEASES_POLL_MS = 5000

const IN_FLIGHT: readonly ReleaseStatus[] = ['tagged', 'staging', 'promoting']

/** Whether the server still owes an answer on this release. Pure. */
export function releaseInFlight(release: Pick<Release, 'status'>): boolean {
  return IN_FLIGHT.includes(release.status)
}

/** `refetchInterval` for the releases list: poll while any release is in flight. Pure. */
export function releasesPollInterval(
  items: readonly Pick<Release, 'status'>[] | undefined
): number | false {
  return items?.some(releaseInFlight) ? RELEASES_POLL_MS : false
}

const base = (appId: string) => `/api/apps/${appId}/releases`

export function useReleases(appId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: queryKeys.releases.forApp(appId ?? ''),
    queryFn: () => api.get(base(appId ?? ''), { schema: releaseListResponseSchema }),
    enabled: Boolean(appId) && enabled,
    refetchInterval: q => releasesPollInterval(q.state.data?.items),
  })
}

/** The chain is read when somebody opens it — never for every row of the card. */
export function useReleaseChain(appId: string | undefined, releaseId: string | null) {
  return useQuery({
    queryKey: queryKeys.releases.chain(releaseId ?? ''),
    queryFn: () =>
      api.get(`${base(appId ?? '')}/${releaseId}/chain`, { schema: releaseChainSchema }),
    enabled: Boolean(appId && releaseId),
  })
}

/**
 * The release an approval is about, for a `deploy.production` request whose subject is a release.
 * `appId` and `releaseId` come from the approval row, so this reads nothing it was not linked to.
 */
export function releaseOfApproval(
  approval: Pick<ApprovalDetail, 'kind' | 'subjectType' | 'subjectId' | 'appId'>
): { appId: string; releaseId: string } | null {
  if (approval.kind !== 'deploy.production' || approval.subjectType !== 'release') return null
  if (!approval.appId) return null
  return { appId: approval.appId, releaseId: approval.subjectId }
}

export function useCreateRelease(appId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: CreateReleaseRequest) =>
      api.post(base(appId), body, { schema: releaseSchema }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.releases.forApp(appId) }),
  })
}

export function usePromoteRelease(appId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ releaseId, ...body }: PromoteReleaseRequest & { releaseId: string }) =>
      // A 409 (staging no longer runs it, or is not up) is rendered in the dialog: no toast.
      api.post(`${base(appId)}/${releaseId}/promote`, body, {
        schema: promoteReleaseResponseSchema,
        showErrorToast: false,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.releases.all })
      // The promote opened a request somebody is now waiting on: the inbox and badge move.
      void queryClient.invalidateQueries({ queryKey: queryKeys.approvals.all })
    },
  })
}
