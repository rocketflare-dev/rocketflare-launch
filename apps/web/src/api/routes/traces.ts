/**
 * `/api/traces` (D32): the local trace store read back — `GET /` lists traces
 * (`?runId|conversationId|since|agent|status`, paginated), `GET /:id` returns one trace's spans,
 * where `:id` is a trace id, an agent run id or an assistant message id. Admin+ (`read Trace`): a
 * span carries other people's prompts and tool results, so this is not a member surface even for
 * their own runs. The CLI's `launch traces list|show` is the main reader.
 */
import {
  traceDetailSchema,
  traceListQuerySchema,
  traceListResponseSchema,
  traceLookupParamSchema,
} from '@launch/shared/ai/traces'
import { guardPermission } from '../middleware/permissions'
import { getTrace, listTraces } from '../services/traces'
import { withAuthAndDb } from '../utils/routes/route-helpers'
import { createRouter } from '../utils/routes/router'
import { validate } from '../utils/routes/validate'

export const tracesRouter = createRouter()

/**
 * Lists trace runs (`?runId|conversationId|since|agent|status`), paginated. Requires `read
 * Trace` (admin+ and support — a span carries other people's prompts).
 */
tracesRouter.get('/', validate('query', traceListQuerySchema), async c => {
  const { db, cfg, tenantId } = withAuthAndDb(c)
  guardPermission(c, 'read', 'Trace')
  return c.json(
    traceListResponseSchema.parse(await listTraces(db, cfg, tenantId, c.req.valid('query')))
  )
})

/**
 * Returns one trace's full span tree, by trace id, agent run id or assistant message id.
 * Requires `read Trace` (admin+ and support).
 */
tracesRouter.get('/:id', validate('param', traceLookupParamSchema), async c => {
  const { db, cfg, tenantId } = withAuthAndDb(c)
  guardPermission(c, 'read', 'Trace')
  return c.json(traceDetailSchema.parse(await getTrace(db, cfg, tenantId, c.req.valid('param').id)))
})
