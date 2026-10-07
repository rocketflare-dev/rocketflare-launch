/**
 * `/api/platform/access-requests` (D9, D25) — the sign-up review queue under
 * `SIGNUP_MODE=approval`, behind `platformAdminMiddleware` (a global admin, or in single mode the
 * organisation's owner/admin). Lodging a request is the member-facing `POST /api/access-requests`
 * (`access-requests.ts`); this is only the reviewer's side.
 *
 *   GET  /               the queue, filtered and paged
 *   POST /:id/decide     approve (join an organisation / mint a new one) or reject
 *
 * A reviewer who is NOT a global admin (a single-mode owner/admin) may only approve into their own
 * organisation, and may hand out `owner` only if they are one — the rule `POST /api/invitations`
 * already applies. `new_org` stays multi-only (`requireMultiTenant`).
 */
import {
  accessRequestListQuerySchema,
  decideAccessRequestSchema,
} from '@launch/shared/access-requests'
import { isOwnerLevel } from '../middleware/permissions'
import { decideAccessRequest, listAccessRequests } from '../services/admin'
import { ForbiddenError } from '../utils/core/errors'
import { paginated } from '../utils/routes/pagination'
import { requireMultiTenant, uuidParam, withAuth } from '../utils/routes/route-helpers'
import { createRouter } from '../utils/routes/router'
import { validate } from '../utils/routes/validate'

export const platformAccessRequestsRouter = createRouter()

/**
 * List the sign-up review queue, filtered and paged. Requires `canAdministerPlatform` (a global
 * admin, or in single mode the organisation's owner/admin).
 */
platformAccessRequestsRouter.get('/', validate('query', accessRequestListQuerySchema), async c => {
  const { db } = withAuth(c)
  const query = c.req.valid('query')
  const { items, total } = await listAccessRequests(db, query)
  return c.json(paginated(items, total, query))
})

/**
 * Approve (joining an organisation or minting a new one) or reject a sign-up request. Requires
 * `canAdministerPlatform`. A single-mode owner/admin may only approve into their own organisation,
 * and may hand out `owner` only if they are one themself; 403 otherwise. `new_org` requires
 * multi-tenant mode.
 */
platformAccessRequestsRouter.post(
  '/:id/decide',
  validate('json', decideAccessRequestSchema),
  async c => {
    const { db, cfg, logger, user, auth, tenantId } = withAuth(c)
    const decision = c.req.valid('json')
    if (decision.decision === 'approve') {
      const approve = decision.approve
      if (approve.mode === 'new_org') requireMultiTenant(cfg)
      if (!auth.isGlobalAdmin && approve.mode === 'join') {
        if (approve.tenantId !== tenantId) {
          throw new ForbiddenError('You can only approve people into your own organisation')
        }
        if (approve.role === 'owner' && !isOwnerLevel(auth)) {
          throw new ForbiddenError('Only an owner can make someone an owner')
        }
      }
    }
    const result = await decideAccessRequest(db, cfg, logger, c.env.JOBS_QUEUE, {
      id: uuidParam(c, 'id'),
      decision,
      admin: user,
    })
    return c.json(result)
  }
)
