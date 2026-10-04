/**
 * Coding sessions (Launch P3, spec/07): one session (`GET /api/sessions/:id`), an app's sessions
 * (`GET /api/apps/:id/sessions`), the live sessions across the deployment for the operator
 * (`GET /api/admin/sessions`), and every act on one — start, send a message, cancel the turn, ship,
 * end, resume, extend the budget, mint a preview grant, upload a message's image, screenshot the
 * preview into one, drain.
 *
 * **Routes START work; the Workflow does it.** Every mutation here answers 202 with the row as it
 * is now (`sessionDetailResponseSchema`) and writes it into the cache, so the page moves the moment
 * the click lands; what happens next arrives through the `entity.changed { entity: 'session' }`
 * nudge (the family root IS `['session']`, `SESSION_REALTIME_ENTITY`) and, belt and braces, a poll.
 *
 * Polling (ui.md): only while the server still OWES the reader something — a pure decision on the
 * cached row, `sessionPollInterval`. A session sitting at `ready` waits on a PERSON and is not
 * polled; nor is `blocked` (it waits on someone extending the budget) or `suspended` (on a resume),
 * and a settled one never is — except a `shipped` row whose landing is still releasing or
 * deploying to staging (issue #5), polled at `SESSION_LANDING_POLL_MS` like the rest of a landing;
 * a landing parked in `approval` waits on a reviewer and is not polled.
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
  MOVING_LANDING_STAGES,
  type PreviewGrantRequest,
  type PreviewScreenshotRequestInput,
  previewGrantResponseSchema,
  previewScreenshotResponseSchema,
  type Session,
  type SessionAttachment,
  type SessionListQuery,
  type SessionStatus,
  type SessionSummary,
  type SessionTurnRequestInput,
  type ShipLandingStage,
  sessionAttachmentPath,
  sessionAttachmentUploadResponseSchema,
  sessionCancelResponseSchema,
  sessionDetailResponseSchema,
  sessionListResponseSchema,
  sessionPrResponseSchema,
} from '@launch/shared/launch-sessions'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, api } from '@/ui/lib/api-client'
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
 * Issue #5: a ship's landing still moving — `ci`, `approval`, `merging` while `shipping`, then
 * `releasing` and `deploying` after the merge, when the row is already `shipped` (terminal) but the
 * Workflow is still taking it to staging. Pure.
 */
export function landingIsMoving(landing: Session['landing'] | undefined): boolean {
  return Boolean(
    landing && (MOVING_LANDING_STAGES as readonly ShipLandingStage[]).includes(landing.stage)
  )
}

/** The landing is waiting on a PERSON (a reviewer), not on the Workflow. Pure. */
function landingWaitsOnPerson(landing: Session['landing'] | undefined): boolean {
  return landing?.stage === 'approval'
}

/** CI and the staging deploy move in minutes: a landing is polled at this pace, not every 3 s. */
export const SESSION_LANDING_POLL_MS = 15_000

type OwesAnswerInput = Pick<Session, 'status' | 'pendingMessage' | 'requestedAction'> & {
  landing?: Session['landing']
}

/**
 * Whether the server still owes this session's reader an answer. Pure. A `ready` row with a
 * message waiting (`pendingMessage`) or an action requested is about to move, so it counts; so
 * does a `shipped` row whose landing is still releasing or deploying (issue #5). A landing parked
 * on a reviewer (`approval`) waits on a person — the approval's nudge moves it, not a poll.
 */
export function sessionOwesAnswer(session: OwesAnswerInput | undefined): boolean {
  if (!session) return false
  if (landingWaitsOnPerson(session.landing) && session.requestedAction === null) return false
  if (sessionIsMoving(session.status)) return true
  if (session.status === 'shipped') return landingIsMoving(session.landing)
  return (
    isActiveSessionStatus(session.status) &&
    (session.pendingMessage || session.requestedAction !== null)
  )
}

/** `refetchInterval` for one session. Pure. */
export function sessionPollInterval(session: OwesAnswerInput | undefined): number | false {
  if (!sessionOwesAnswer(session)) return false
  // Past the PR the Workflow works in poll ROUNDS (30 s – 2 min): a 3 s poll would show nothing new.
  return landingIsMoving(session?.landing) ? SESSION_LANDING_POLL_MS : SESSION_POLL_MS
}

/** `refetchInterval` for a list: poll while any listed row is moving. Pure. */
export function sessionListPollInterval(
  items: readonly Pick<SessionSummary, 'status'>[] | undefined
): number | false {
  return items?.some(s => sessionIsMoving(s.status)) ? SESSION_POLL_MS : false
}

/** A turn is queued or running: nothing else (a ship) may start, and Stop is offered. Pure. */
export function turnInProgress(session: Pick<Session, 'status' | 'pendingMessage'>): boolean {
  return session.status === 'working' || session.pendingMessage
}

/**
 * What the composer's send does now. Pure:
 * - `full` — a message already waits (one at most): nothing more until it starts or is withdrawn;
 * - `queue` — a turn is running: the message waits for it (Enter, Queue) or stops it (Send now);
 * - `send` — the message runs as soon as the session can.
 */
export function composerSendMode(
  session: Pick<Session, 'status' | 'pendingMessage'>
): 'send' | 'queue' | 'full' {
  if (session.pendingMessage) return 'full'
  return session.status === 'working' ? 'queue' : 'send'
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
 * `session_budget_exhausted` is rendered under the composer, and the text is kept. `model` only
 * when the person picked another one than the session's (the caller decides).
 */
export function useSendTurn(id: string) {
  return useSessionAction<SessionTurnRequestInput>(id, 'turns', { toast: false })
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

/**
 * `POST /:id/queued/withdraw` — take the waiting message back (while a turn runs too). No toast:
 * a 409 `nothing_queued` means it already started, which the transcript shows.
 */
export function useWithdrawQueued(id: string) {
  return useSessionAction(id, 'queued/withdraw', { toast: false })
}

/**
 * `POST /:id/attachments` — one image for the next message (multipart). A plain function, not a
 * hook: the composer runs several at once and owns their state (`useComposerAttachments`). No
 * toast — a refusal (415, 413) is shown on the image's own chip.
 */
export function uploadSessionAttachment(id: string, file: File) {
  const form = new FormData()
  form.append('file', file)
  return api.upload(`${sessionPath(id)}/attachments`, form, {
    schema: sessionAttachmentUploadResponseSchema,
    showErrorToast: false,
  })
}

/** How often a queued preview screenshot is looked for, and for how long. */
export const SCREENSHOT_POLL_MS = 1000
export const SCREENSHOT_WAIT_MS = 25_000

/**
 * The preview pane's camera: `POST /:id/preview-screenshot` (202, an image id reserved and the
 * capture queued), then `HEAD` the image until it lands — 404 while the job runs, 422 once it
 * could not be taken — for at most `SCREENSHOT_WAIT_MS`. A plain function the composer's chip
 * waits on (`useComposerAttachments.addPending`), not a query: it is one bounded wait for one job,
 * and nothing about it belongs in the cache. Throws a sentence for the chip.
 */
export async function takePreviewScreenshot(
  id: string,
  body: PreviewScreenshotRequestInput,
  opts: { pollMs?: number; waitMs?: number } = {}
): Promise<SessionAttachment> {
  const { attachmentId } = await api.post(`${sessionPath(id)}/preview-screenshot`, body, {
    schema: previewScreenshotResponseSchema,
    showErrorToast: false,
  })
  const pollMs = opts.pollMs ?? SCREENSHOT_POLL_MS
  const deadline = Date.now() + (opts.waitMs ?? SCREENSHOT_WAIT_MS)
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, pollMs))
    try {
      await api.head(sessionAttachmentPath(id, attachmentId))
      return { id: attachmentId, contentType: 'image/png' }
    } catch (err) {
      if (err instanceof ApiError && err.status === 422) {
        throw new Error('The screenshot could not be taken. Check that the page loads.')
      }
      if (!(err instanceof ApiError && err.status === 404)) throw err
    }
  }
  throw new Error('The screenshot took too long. Try again.')
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
 * not a query: every load needs a fresh one, and nothing about it belongs in the cache. `path`
 * (the page the frame was on, as the preview bridge reported it) is where the grant lands.
 */
export function usePreviewGrant(id: string) {
  return useMutation({
    mutationFn: (path?: string | null) =>
      api.post(
        `${sessionPath(id)}/preview-grant`,
        (path ? { path } : {}) satisfies PreviewGrantRequest,
        {
          schema: previewGrantResponseSchema,
          showErrorToast: false,
        }
      ),
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
