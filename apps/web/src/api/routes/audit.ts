/**
 * `GET /api/audit` (spec/08): the organisation's audit log, newest first, admin+ (`read
 * AuditEvent`). Filter by `appId` and by `action` (the action or anything beneath it); page with
 * the previous response's `nextCursor`. There is no write route — rows are appended by the
 * services that act, through `recordAudit`, and the table refuses UPDATE and DELETE.
 */
import { auditListQuerySchema } from '@launch/shared/launch-audit'
import { guardPermission } from '../middleware/permissions'
import { listAudit } from '../services/launch/audit'
import { withAuthAndDb } from '../utils/routes/route-helpers'
import { createRouter } from '../utils/routes/router'
import { validate } from '../utils/routes/validate'

export const auditRouter = createRouter()

auditRouter.get('/', validate('query', auditListQuerySchema), async c => {
  guardPermission(c, 'read', 'AuditEvent')
  const { db, tenantId } = withAuthAndDb(c)
  const { cursor, ...filters } = c.req.valid('query')
  return c.json(await listAudit(db, tenantId, filters, cursor))
})
