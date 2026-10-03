/**
 * `/api/me` (D13): the signed-in user's profile and per-tenant preferences. Profile belongs to the
 * PERSON (`users`), preferences to the person-in-this-tenant (`tenant_user_settings`). §18.22: the
 * person's own AI accounts and their sign-ins are `me-agents.ts`, mounted below.
 */
import {
  updateProfileRequestSchema,
  updateTenantUserSettingsRequestSchema,
} from '@launch/shared/user-settings'
import { eq } from 'drizzle-orm'
import { users } from '../../db/schema'
import { toPublicUser } from '../services/auth'
import { getUserPreferences, updateUserPreferences } from '../services/tenants'
import { withAuth, withAuthAndDb } from '../utils/routes/route-helpers'
import { createRouter } from '../utils/routes/router'
import { validate } from '../utils/routes/validate'
import { meAgentsRouter } from './me-agents'

export const meRouter = createRouter()

// §18.22: `/agent-credentials` and `/agent-logins` — the person's own AI accounts.
meRouter.route('/', meAgentsRouter)

meRouter.get('/', async c => {
  const { db, user, tenantId } = withAuth(c)
  const preferences = tenantId ? (await getUserPreferences(db, tenantId, user.id)).preferences : {}
  return c.json({ ...toPublicUser(user), preferences })
})

meRouter.patch('/', validate('json', updateProfileRequestSchema), async c => {
  const { db, user } = withAuth(c)
  const patch = c.req.valid('json')
  const [updated] = await db
    .update(users)
    .set({
      ...(patch.name !== undefined && { name: patch.name }),
      ...(patch.avatarUrl !== undefined && { avatarUrl: patch.avatarUrl }),
    })
    .where(eq(users.id, user.id))
    .returning()
  return c.json(toPublicUser(updated ?? user))
})

meRouter.get('/preferences', async c => {
  const { db, user, tenantId } = withAuthAndDb(c)
  return c.json(await getUserPreferences(db, tenantId, user.id))
})

meRouter.patch('/preferences', validate('json', updateTenantUserSettingsRequestSchema), async c => {
  const { db, user, tenantId } = withAuthAndDb(c)
  return c.json(await updateUserPreferences(db, tenantId, user.id, c.req.valid('json').preferences))
})
