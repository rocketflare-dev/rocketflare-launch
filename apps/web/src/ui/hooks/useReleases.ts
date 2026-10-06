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
 * polls; the rest are settled. With the realtime socket open the poll slows to a fallback: every
 * deploy-run call (`/ci/deploy`), release write and changed tag-run reading nudges `release`.
 */
import type { ApprovalDetail } from '@launch/shared/launch-approvals'
import { type AppPromotion, appPromotionSchema } from '@launch/shared/launch-promotion'
import {
  type CreateReleaseRequest,
  cancelReleaseResponseSchema,
  type PromoteReleaseRequest,
  promoteReleaseResponseSchema,
  RELEASE_COMPARE_TTL_SECONDS,
  type Release,
  type ReleaseStatus,
  type RetryReleaseRequest,
  type RollbackReleaseRequest,
  releaseChainSchema,
  releaseCompareSchema,
  releaseListResponseSchema,
  releaseSchema,
  retryReleaseResponseSchema,
  rollbackReleaseResponseSchema,
} from '@launch/shared/launch-releases'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/ui/lib/api-client'
import { queryKeys } from '@/ui/lib/query-keys'
import { useRealtimeConnected } from '@/ui/stores/websocketStore'

export const RELEASES_POLL_MS = 5000
/** The socket is open: a release's moves arrive as nudges, so the poll is only a safety net. */
export const RELEASES_CONNECTED_POLL_MS = 30_000
/**
 * The strip while its candidate is `tagged` or `staging` with the socket open. Its own read is what
 * follows the tag's deploy run on GitHub (`tag-run.ts`, one read per release per 20 s however many
 * readers), so it keeps that pace: slower would leave the run's jobs unread for longer.
 */
export const PROMOTION_FOLLOW_POLL_MS = 20_000

const IN_FLIGHT: readonly ReleaseStatus[] = ['tagged', 'staging', 'promoting']

/** Whether the server still owes an answer on this release. Pure. */
export function releaseInFlight(release: Pick<Release, 'status'>): boolean {
  return IN_FLIGHT.includes(release.status)
}

/**
 * `refetchInterval` for the releases list: poll while any release is in flight — at the fallback
 * pace while the realtime socket is open (`connected`). Pure.
 */
export function releasesPollInterval(
  items: readonly Pick<Release, 'status'>[] | undefined,
  connected = false
): number | false {
  if (!items?.some(releaseInFlight)) return false
  return connected ? RELEASES_CONNECTED_POLL_MS : RELEASES_POLL_MS
}

const base = (appId: string) => `/api/apps/${appId}/releases`

export function useReleases(appId: string | undefined, enabled = true) {
  const connected = useRealtimeConnected()
  return useQuery({
    queryKey: queryKeys.releases.forApp(appId ?? ''),
    queryFn: () => api.get(base(appId ?? ''), { schema: releaseListResponseSchema }),
    enabled: Boolean(appId) && enabled,
    refetchInterval: q => releasesPollInterval(q.state.data?.items, connected),
  })
}

/**
 * `refetchInterval` for the pipeline strip: poll while its candidate release is in flight. With
 * the socket open (`connected`), a candidate still on its tag run keeps the GitHub-follow pace
 * (`PROMOTION_FOLLOW_POLL_MS`) and a promoting one falls back to `RELEASES_CONNECTED_POLL_MS`. Pure.
 */
export function promotionPollInterval(
  view: Pick<AppPromotion, 'candidate'> | undefined,
  connected = false
): number | false {
  const candidate = view?.candidate
  if (!candidate || !releaseInFlight(candidate)) return false
  if (!connected) return RELEASES_POLL_MS
  return candidate.status === 'promoting' ? RELEASES_CONNECTED_POLL_MS : PROMOTION_FOLLOW_POLL_MS
}

/**
 * The app page's pipeline strip (`GET /api/apps/:id/promotion`): the candidate release, what each
 * environment runs, what promoting would ship and who a pending request waits on. Under the
 * `release` root, so the release and promote nudges refresh it; it polls only while the candidate
 * is deploying (`tagged` / `staging` / `promoting`) — waiting on a promoter or an approver is a
 * person, not the server.
 */
export function useAppPromotion(appId: string | undefined, enabled = true) {
  const connected = useRealtimeConnected()
  return useQuery({
    queryKey: queryKeys.releases.promotion(appId ?? ''),
    queryFn: () => api.get(`/api/apps/${appId}/promotion`, { schema: appPromotionSchema }),
    enabled: Boolean(appId) && enabled,
    refetchInterval: q => promotionPollInterval(q.state.data, connected),
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
  if (approval.kind !== 'deploy.production') return null
  // A rollback's subject is the release it goes back to (app page P3).
  if (approval.subjectType !== 'release' && approval.subjectType !== 'rollback') return null
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

/**
 * App page P2: the stage-aware Retry (`POST …/:rid/retry`). The stage the reader saw travels with
 * it, so a release that moved on is a 409 `release_stage_changed` rather than a different retry.
 * The server's message is the toast on a refusal; the caller words the success
 * (`retryOutcomeMessage`).
 */
export function useRetryRelease(appId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ releaseId, ...body }: RetryReleaseRequest & { releaseId: string }) =>
      api.post(`${base(appId)}/${releaseId}/retry`, body, { schema: retryReleaseResponseSchema }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.releases.all })
      // A re-run opens a deploy, a health check moves the environments, a re-request an approval.
      void queryClient.invalidateQueries({ queryKey: queryKeys.apps.all })
      void queryClient.invalidateQueries({ queryKey: queryKeys.approvals.all })
    },
  })
}

/** App page P2: Cancel release (`POST …/:rid/cancel`) — stops its deploy run on GitHub. */
export function useCancelRelease(appId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (releaseId: string) =>
      api.post(`${base(appId)}/${releaseId}/cancel`, undefined, {
        schema: cancelReleaseResponseSchema,
      }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.releases.all })
      void queryClient.invalidateQueries({ queryKey: queryKeys.apps.all })
    },
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

/**
 * App page P3: main against the latest release tag (`GET …/releases/compare`) — the Overview's
 * "main  N commits ahead" row. Never polled: nothing Launch does moves main except a release
 * (whose nudge refreshes the `release` root), and the server caches GitHub's answer for
 * `RELEASE_COMPARE_TTL_SECONDS`, which is also how long this copy stays fresh.
 */
export function useReleaseCompare(appId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: queryKeys.releases.compare(appId ?? ''),
    queryFn: () => api.get(`${base(appId ?? '')}/compare`, { schema: releaseCompareSchema }),
    enabled: Boolean(appId) && enabled,
    staleTime: RELEASE_COMPARE_TTL_SECONDS * 1000,
  })
}

/**
 * App page P3: Roll back to here (`POST …/:rid/rollback`) — the same production approval as Ship,
 * then the repo's own deploy workflow at the old tag. A 409 (not eligible, Live busy) is the
 * server's sentence in a toast.
 */
export function useRollbackRelease(appId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ releaseId, ...body }: RollbackReleaseRequest & { releaseId: string }) =>
      api.post(`${base(appId)}/${releaseId}/rollback`, body, {
        schema: rollbackReleaseResponseSchema,
      }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.releases.all })
      void queryClient.invalidateQueries({ queryKey: queryKeys.approvals.all })
      void queryClient.invalidateQueries({ queryKey: queryKeys.apps.all })
    },
  })
}
