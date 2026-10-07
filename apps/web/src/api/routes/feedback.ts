/**
 * `/api/feedback` (D33): thumbs on AI answers.
 *
 * - `POST /` — rate an assistant message or an agent run (`create Feedback`, every member). The
 *   service proves the caller can READ the target; a foreign id is 404. Voting again replaces the
 *   vote.
 * - `DELETE /:target/:targetId` — withdraw your own vote (204, idempotent).
 * - `GET /mine?target=&targetIds=` — your own votes on those targets, for the thumbs' state.
 * - `GET /` — every vote in the tenant (`read Feedback`, admin+): the promotion queue behind
 *   `launch feedback list`.
 */
import {
  createFeedbackRequestSchema,
  feedbackListQuerySchema,
  feedbackListResponseSchema,
  feedbackMineQuerySchema,
  feedbackMineResponseSchema,
  feedbackSchema,
  feedbackTargetParamSchema,
} from '@launch/shared/ai/evals'
import { guardPermission, isAdminLevel } from '../middleware/permissions'
import {
  type FeedbackActor,
  listFeedback,
  myFeedback,
  recordFeedback,
  withdrawFeedback,
} from '../services/feedback'
import type { AppContext } from '../types'
import { withAuthAndDb } from '../utils/routes/route-helpers'
import { createRouter } from '../utils/routes/router'
import { validate } from '../utils/routes/validate'

export const feedbackRouter = createRouter()

function actorOf(c: AppContext): FeedbackActor {
  const { tenantId, user, auth } = withAuthAndDb(c)
  return { tenantId, userId: user.id, isAdmin: isAdminLevel(auth) }
}

/**
 * Records the caller's thumbs up/down on an assistant message or agent run, replacing any
 * earlier vote. Requires `create Feedback`; a target the caller cannot read is 404.
 */
feedbackRouter.post('/', validate('json', createFeedbackRequestSchema), async c => {
  const { db, tracer } = withAuthAndDb(c)
  guardPermission(c, 'create', 'Feedback')
  const feedback = await recordFeedback(db, tracer, actorOf(c), c.req.valid('json'))
  return c.json(feedbackSchema.parse(feedback), 201)
})

/**
 * Withdraws the caller's own vote on a target. Requires `create Feedback`; idempotent (204 even
 * when there was no vote).
 */
feedbackRouter.delete(
  '/:target/:targetId',
  validate('param', feedbackTargetParamSchema),
  async c => {
    const { db } = withAuthAndDb(c)
    guardPermission(c, 'create', 'Feedback')
    const { target, targetId } = c.req.valid('param')
    await withdrawFeedback(db, actorOf(c), target, targetId)
    return c.body(null, 204)
  }
)

/** Returns the caller's own votes on the given targets, for the thumbs' UI state. Requires `create Feedback`. */
feedbackRouter.get('/mine', validate('query', feedbackMineQuerySchema), async c => {
  const { db } = withAuthAndDb(c)
  guardPermission(c, 'create', 'Feedback')
  const { target, targetIds } = c.req.valid('query')
  return c.json(
    feedbackMineResponseSchema.parse({ items: await myFeedback(db, actorOf(c), target, targetIds) })
  )
})

/**
 * Lists every feedback vote in the tenant, the promotion queue behind `launch feedback list`.
 * Requires `read Feedback` (admin+).
 */
feedbackRouter.get('/', validate('query', feedbackListQuerySchema), async c => {
  const { db, tenantId } = withAuthAndDb(c)
  guardPermission(c, 'read', 'Feedback')
  return c.json(
    feedbackListResponseSchema.parse(await listFeedback(db, tenantId, c.req.valid('query')))
  )
})
