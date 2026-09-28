/**
 * Coding sessions (Launch P3, spec/07): one session (`GET /api/sessions/:id`), an app's sessions
 * (`GET /api/apps/:id/sessions`), the live sessions across the deployment for the operator
 * (`GET /api/admin/sessions`), and every act on one — start, send a message, cancel the turn, ship,
 * end, resume, extend the budget, mint a preview grant, drain.
 *
 * **Routes START work; the Workflow does it.** Every mutation here answers 202 with the row as it
 * is now (`sessionDetailResponseSchema`) and writes it into the cache, so the page moves the moment
 * the click lands; what happens next arrives through the `entity.changed { entity: 'session' }`
 * nudge (the family root IS `['session']`, `SESSION_REALTIME_ENTITY`) and, belt and braces, a poll.
 *
 * Polling (ui.md): only while the server still OWES the reader something — a pure decision on the
 * cached row, `sessionPollInterval`. A session sitting at `ready` waits on a PERSON and is not
 * polled; nor is `blocked` (it waits on someone extending the budget) or `suspended` (on a resume),
 * and a settled one never is.
 *
 * The chat transcript is NOT here: it is `useSessionStream`, under its own `['session-agui']` root,
 * which the nudge must never reach.
 */
import {
  type AdminSession,
  adminSessionListResponseSchema,
  type CreateSessionRequest,
  drainResponseSchema,
  type ExtendBudgetRequest,
  extendBudgetResponseSchema,
  isActiveSessionStatus,
  previewGrantResponseSchema,
  type Session,
  type SessionListQuery,
  type SessionStatus,
  type SessionSummary,
  sessionCancelResponseSchema,
  sessionDetailResponseSchema,
  sessionListResponseSchema,
  sessionPrResponseSchema,
} from '@launch/shared/launch-sessions'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/ui/lib/api-client'
import { queryKeys } from '@/ui/lib/query-keys'
import { useApprovals } from './useApprovals'

export const SESSION_POLL_MS = 3000
/** CI moves in minutes, and the server refreshes `pr_checks` at most every 30 s anyway. */
export const SESSION_PR_POLL_MS = 15_000

/**
 * Statuses in which the WORKFLOW is doing something the reader is waiting to see: booting, a turn,
 * the ship gate, the teardown. `ready`, `blocked` and `suspended` wait on a person instead.
 */
const MOVING_STATUSES: readonly SessionStatus[] = [
  'requested',
  'booting',
  'working',
  'shipping',
  'ending',
]

export function sessionIsMoving(status: SessionStatus | undefined): boolean {
  return status !== undefined && MOVING_STATUSES.includes(status)
}

/**
 * Whether the server still owes this session's reader an answer. Pure. A `ready` row with a
 * message waiting (`pendingMessage`) or an action requested is about to move, so it counts.
 */
export function sessionOwesAnswer(
  session: Pick<Session, 'status' | 'pendingMessage' | 'requestedAction'> | undefined
): boolean {
  if (!session) return false
  if (sessionIsMoving(session.status)) return true
  return (
    isActiveSessionStatus(session.status) &&
    (session.pendingMessage || session.requestedAction !== null)
  )
}

/** `refetchInterval` for one session. Pure. */
export function sessionPollInterval(
  session: Pick<Session, 'status' | 'pendingMessage' | 'requestedAction'> | undefined
): number | false {
  return sessionOwesAnswer(session) ? SESSION_POLL_MS : false
}

/** `refetchInterval` for a list: poll while any listed row is moving. Pure. */
export function sessionListPollInterval(
  items: readonly Pick<SessionSummary, 'status'>[] | undefined
): number | false {
  return items?.some(s => sessionIsMoving(s.status)) ? SESSION_POLL_MS : false
}

/** A turn is queued or running: the composer offers Cancel instead of Send. Pure. */
export function turnInProgress(session: Pick<Session, 'status' | 'pendingMessage'>): boolean {
  return session.status === 'working' || session.pendingMessage
}

/**
 * The sandbox is up and serving (or about to be asked to): the preview can be shown. `shipping`
 * still has its sandbox — the gate runs in it.
 */
export function sessionHasSandbox(status: SessionStatus): boolean {
  return status === 'ready' || status === 'working' || status === 'blocked' || status === 'shipping'
}

const sessionPath = (id: string) => `/api/sessions/${encodeURIComponent(id)}`

export function useSession(id: string | undefined) {
  return useQuery({
    queryKey: queryKeys.sessions.detail(id ?? ''),
    queryFn: async () =>
      (await api.get(sessionPath(id ?? ''), { schema: sessionDetailResponseSchema })).session,
    enabled: Boolean(id),
    refetchInterval: q => sessionPollInterval(q.state.data),
  })
}

export function useAppSessions(appId: string | undefined, scope: SessionListQuery['scope']) {
  return useQuery({
    queryKey: queryKeys.sessions.forApp(appId ?? '', { scope }),
    queryFn: () =>
      api.get(`/api/apps/${appId}/sessions?scope=${scope}`, { schema: sessionListResponseSchema }),
    enabled: Boolean(appId),
    refetchInterval: q => sessionListPollInterval(q.state.data?.items),
  })
}

/**
 * `POST /api/apps/:id/sessions`. No toast: the refusals (`session_limit`, `sessions_paused`,
 * `session_budget_exhausted`, `sessions_not_configured`) are the card's to explain in place.
 */
export function useStartSession(appId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: CreateSessionRequest = {}) =>
      api.post(`/api/apps/${appId}/sessions`, body, {
        schema: sessionDetailResponseSchema,
        showErrorToast: false,
      }),
    onSuccess: ({ session }) => {
      queryClient.setQueryData(queryKeys.sessions.detail(session.id), session)
      void queryClient.invalidateQueries({ queryKey: queryKeys.sessions.forApp(appId) })
    },
  })
}

/** Write a 202's row into the cache — the page moves on the click, not on the next poll. */
function useSessionAction<TBody = void>(
  id: string,
  path: string,
  options: { toast?: boolean; successMessage?: string } = {}
) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: TBody) =>
      api.post(`${sessionPath(id)}/${path}`, body ?? undefined, {
        schema: sessionDetailResponseSchema,
        showErrorToast: options.toast ?? true,
        showSuccessToast: Boolean(options.successMessage),
        successMessage: options.successMessage,
      }),
    onSuccess: ({ session }) => {
      queryClient.setQueryData(queryKeys.sessions.detail(id), session)
      // The app's card and the admin list show this row too.
      void queryClient.invalidateQueries({
        queryKey: queryKeys.sessions.all,
        predicate: q => q.queryKey[1] !== 'detail',
      })
    },
  })
}

/**
 * `POST /:id/turns`. No toast: a 409 `turn_in_progress` (another tab sent one) or
 * `session_budget_exhausted` is rendered under the composer, and the text is kept.
 */
export function useSendTurn(id: string) {
  return useSessionAction<{ message: string }>(id, 'turns', { toast: false })
}

export function useShipSession(id: string) {
  return useSessionAction(id, 'ship')
}

export function useEndSession(id: string) {
  return useSessionAction(id, 'end')
}

export function useResumeSession(id: string) {
  return useSessionAction(id, 'resume')
}

/**
 * `POST /:id/budget` (P4: `session.budget` through the approvals engine). The route opens — or
 * joins — a request whose requester is the session's creator; an eligible approver other than the
 * creator records their approval in the same call (P3's one click). The answer
 * (`extendBudgetResponseSchema`) is the row as it is now plus the request's `approvalId`, and the
 * CALLER says which happened — the cap moved, or it is waiting.
 */
export function useExtendBudget(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: ExtendBudgetRequest) =>
      api.post(`${sessionPath(id)}/budget`, body, { schema: extendBudgetResponseSchema }),
    onSuccess: ({ session }) => {
      queryClient.setQueryData(queryKeys.sessions.detail(id), session)
      void queryClient.invalidateQueries({
        queryKey: queryKeys.sessions.all,
        predicate: q => q.queryKey[1] !== 'detail',
      })
      // A request may have opened, or been approved: the inbox, the badge and this page's link.
      void queryClient.invalidateQueries({ queryKey: queryKeys.approvals.all })
    },
  })
}

/**
 * The creator's open `session.budget` request for this session, if any — so the page can say
 * "waiting for approval" and link to it after a reload. Read from the requester's own box; the
 * approval nudge keeps it fresh.
 */
export function usePendingBudgetApproval(sessionId: string, enabled: boolean) {
  const { data } = useApprovals(
    { box: 'requested', kind: 'session.budget', status: 'pending' },
    enabled
  )
  return (
    data?.items.find(
      item => item.context.kind === 'session.budget' && item.context.sessionId === sessionId
    ) ?? null
  )
}

/** `POST /:id/cancel` — the turn polls `cancel_requested_at` and stops within a couple of seconds. */
export function useCancelTurn(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () =>
      api.post(`${sessionPath(id)}/cancel`, undefined, { schema: sessionCancelResponseSchema }),
    onSuccess: () => {
      queryClient.setQueryData<Session>(queryKeys.sessions.detail(id), prev =>
        prev ? { ...prev, cancelRequested: true } : prev
      )
    },
  })
}

/**
 * `POST /:id/preview-grant` — a 60-second grant the iframe (or a new tab) loads once. A mutation,
 * not a query: every load needs a fresh one, and nothing about it belongs in the cache.
 */
export function usePreviewGrant(id: string) {
  return useMutation({
    mutationFn: () =>
      api.post(`${sessionPath(id)}/preview-grant`, undefined, {
        schema: previewGrantResponseSchema,
        showErrorToast: false,
      }),
  })
}

/** `GET /:id/pr`, polled while the PR's checks are still running. */
export function useSessionPr(id: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.sessions.pr(id),
    queryFn: () => api.get(`${sessionPath(id)}/pr`, { schema: sessionPrResponseSchema }),
    enabled,
    refetchInterval: q =>
      q.state.data?.checks?.state === 'pending' || (q.state.data && !q.state.data.checks)
        ? SESSION_PR_POLL_MS
        : false,
  })
}

// ---- the operator's view -------------------------------------------------------------------

export function useAdminSessions(scope: SessionListQuery['scope']) {
  return useQuery({
    queryKey: queryKeys.sessions.admin({ scope }),
    queryFn: () =>
      api.get(`/api/admin/sessions?scope=${scope}`, { schema: adminSessionListResponseSchema }),
    refetchInterval: q => sessionListPollInterval(q.state.data?.items),
  })
}

function useDrainToggle(path: 'drain' | 'undrain', successMessage: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () =>
      api.post(`/api/admin/sessions/${path}`, undefined, {
        schema: drainResponseSchema,
        showSuccessToast: true,
        successMessage,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.sessions.admin() }),
  })
}

export function useDrainSessions() {
  return useDrainToggle('drain', 'Sessions drained — new sessions are paused')
}

export function useUndrainSessions() {
  return useDrainToggle('undrain', 'Sessions resumed — people can start and resume again')
}

export type { AdminSession }
