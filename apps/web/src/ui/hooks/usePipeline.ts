/**
 * Creating an app (Launch P2, `docs/plans/p2-create-app.md` §3 2e): `POST /api/apps`, the pipeline
 * view of a launch or a teardown (`GET /api/apps/:id/pipeline?kind=`), "Retry from failed step",
 * "Re-scaffold" for a failed launch that never deployed, "Stop" for a launch stuck in a wait, and
 * the teardown itself.
 *
 * Polling (ui.md): the pipeline has no server nudge, so it POLLS — but only while the server owes
 * an answer. That is `pipelinePollInterval`, a pure function on the cached status: a `running` run,
 * an app whose row says a run is on its way (`requested` / `provisioning`, before the Workflow has
 * written its first step), or the short window after this tab asked for a retry or a teardown,
 * during which the view can still show the PREVIOUS run's settled state. A settled run is never
 * polled, and a run that settles refreshes the rest of the `apps` family once.
 */
import type { AppStatus, AppSummary } from '@launch/shared/launch-apps'
import {
  type CreateAppRequest,
  cancelPipelineResponseSchema,
  createAppResponseSchema,
  type PipelineKind,
  type PipelineRunStatus,
  pipelineViewSchema,
  type RetryPipelineRequest,
  rescaffoldPipelineResponseSchema,
  retryPipelineResponseSchema,
  type TeardownRequest,
  teardownResponseSchema,
} from '@launch/shared/launch-pipeline'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { api } from '@/ui/lib/api-client'
import { queryKeys } from '@/ui/lib/query-keys'
import { useApps } from './useApps'

/** How often a pipeline the server still owes an answer on is re-read. */
export const PIPELINE_POLL_MS = 3000

/**
 * After this tab starts a retry or a teardown, how long the view may keep showing the previous
 * run's settled state before we stop waiting for the new one to appear. The Workflow writes its
 * first row within seconds; a minute is the belt, not the expectation.
 */
export const PIPELINE_KICK_GRACE_MS = 60_000

/** An app row that says a launch is on its way or under way. */
export function appAwaitsPipeline(status: AppStatus | undefined): boolean {
  return status === 'requested' || status === 'provisioning'
}

export interface PipelinePollContext {
  /** The app's own row says a run is on its way (`appAwaitsPipeline`). */
  appBusy?: boolean
  /** Epoch ms until which a run this tab just started may not be visible yet. */
  expectUntil?: number | null
  now?: number
}

/**
 * `refetchInterval` for a pipeline view: `PIPELINE_POLL_MS` while the run is `running` or one is
 * owed (see the header), `false` otherwise — a succeeded or failed run is settled and never polled.
 * Pure.
 */
export function pipelinePollInterval(
  status: PipelineRunStatus | undefined,
  { appBusy = false, expectUntil = null, now = Date.now() }: PipelinePollContext = {}
): number | false {
  if (status === 'running') return PIPELINE_POLL_MS
  if (appBusy) return PIPELINE_POLL_MS
  if (expectUntil !== null && now < expectUntil) return PIPELINE_POLL_MS
  return false
}

export function usePipeline(
  appId: string | undefined,
  kind: PipelineKind,
  { enabled = true, ...poll }: Omit<PipelinePollContext, 'now'> & { enabled?: boolean } = {}
) {
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: [...queryKeys.apps.pipeline(appId ?? ''), kind] as const,
    queryFn: () =>
      api.get(`/api/apps/${appId}/pipeline?kind=${kind}`, { schema: pipelineViewSchema }),
    enabled: Boolean(appId) && enabled,
    refetchInterval: q => pipelinePollInterval(q.state.data?.status, poll),
  })

  // A run that changes state changes the app too (status, environments, deploys): refresh the
  // family once per transition, never per poll.
  const status = query.data?.status
  const previous = useRef(status)
  useEffect(() => {
    const was = previous.current
    previous.current = status
    if (was === undefined || status === undefined || was === status) return
    void queryClient.invalidateQueries({
      queryKey: queryKeys.apps.all,
      predicate: q => q.queryKey[1] !== 'pipeline',
    })
  }, [status, queryClient])

  return query
}

export function useCreateApp() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: CreateAppRequest) =>
      // The modal renders a refusal itself (slug taken, not set up), so no toast.
      api.post('/api/apps', body, { schema: createAppResponseSchema, showErrorToast: false }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.apps.all }),
  })
}

export function useRetryPipeline(appId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: RetryPipelineRequest) =>
      api.post(`/api/apps/${appId}/pipeline/retry`, body, {
        schema: retryPipelineResponseSchema,
        showErrorToast: true,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.apps.all }),
  })
}

/**
 * Scaffold a failed launch that never deployed again from the current kit pin (the view's
 * `canRescaffold` / `templateTag`); the rest of its resources are kept.
 */
export function useRescaffoldPipeline(appId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () =>
      api.post(`/api/apps/${appId}/pipeline/rescaffold`, undefined, {
        schema: rescaffoldPipelineResponseSchema,
        showErrorToast: true,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.apps.all }),
  })
}

/** Stop a create run that is still running (a stuck wait), so it can be retried. */
export function useCancelPipeline(appId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () =>
      api.post(`/api/apps/${appId}/pipeline/cancel`, undefined, {
        schema: cancelPipelineResponseSchema,
        showErrorToast: true,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.apps.all }),
  })
}

export function useTeardownApp(appId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: TeardownRequest) =>
      // The modal renders a refusal (a wrong confirmation is a 400) in place.
      api.post(`/api/apps/${appId}/teardown`, body, {
        schema: teardownResponseSchema,
        showErrorToast: false,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.apps.all }),
  })
}

// ---- The apps domain -------------------------------------------------------------------------------

/**
 * The apps domain as a created app's staging URL reveals it: `https://<slug>-staging.<domain>` is
 * the one naming rule every created app follows (plan §1 "Naming"). Imported apps are skipped —
 * their URLs are whatever their tomls said. Pure; null when no created app says.
 */
export function appsDomainFromCatalogue(apps: readonly AppSummary[]): string | null {
  for (const app of apps) {
    if (app.source !== 'created') continue
    const url = app.environments.find(env => env.name === 'staging')?.url
    if (!url) continue
    let host: string
    try {
      host = new URL(url).hostname
    } catch {
      continue
    }
    const prefix = `${app.slug}-staging.`
    if (host.startsWith(prefix) && host.length > prefix.length) return host.slice(prefix.length)
  }
  return null
}

/**
 * Where a new app will live, for the Create modal's host preview: the catalogue response's
 * `appsDomain` (`launch_settings.apps_domain`, readable by every member), else what a created
 * app's staging URL reveals — or null, and the modal shows no preview rather than a guess.
 */
export function useAppsDomain(): string | null {
  const apps = useApps()
  return apps.data?.appsDomain ?? appsDomainFromCatalogue(apps.data?.items ?? [])
}
