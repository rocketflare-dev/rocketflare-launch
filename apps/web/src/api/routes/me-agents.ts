/**
 * Personal AI accounts under `/api/me` (§18.22), mounted by `routes/me.ts` with
 * `meRouter.route('/', meAgentsRouter)`, behind the `/api/me` mount's `authMiddleware`. Everything
 * here is the CALLER's own — tenant AND user in every predicate — so another person's credential
 * or login is the same 404 as a missing one.
 *
 * - `GET /agent-credentials` → `agentAccountsResponseSchema`: the runtimes this deployment offers
 *   (the session policy's `runtimes` — the Setup page's Coding agents card), the caller's connected
 *   accounts (value-free) and their logins in flight. The Profile panel and the session picker
 *   both read it.
 * - `DELETE /agent-credentials/:runtime` → 204: disconnect (audited `agent_credential.removed`);
 *   404 when nothing was connected.
 * - `POST /agent-logins` `startAgentLoginRequestSchema` → 202 `agentLoginResponseSchema`: a
 *   `starting` row and `AGENT_LOGIN_WORKFLOW.create` — 409 `agent_logins_disabled` (the policy
 *   keeps this runtime on Launch's account), 503 `agent_logins_not_configured`, 409
 *   `agent_login_in_progress`, all before any write that
 *   sticks. The route runs nothing in a sandbox.
 * - `GET /agent-logins/:id` → `agentLoginResponseSchema` (the modal polls it).
 * - `POST /agent-logins/:id/code` `submitAgentLoginCodeRequestSchema` → 202: the code SEALED onto
 *   the row by compare-and-set, then a wake — 409 `agent_login_not_waiting`. The code is never
 *   echoed, logged or put on the wire.
 * - `POST /agent-logins/:id/cancel` → `agentLoginResponseSchema` — 409 `agent_login_finished`.
 *
 * Permission: `create Session` — a personal account exists to run sessions on.
 */
import {
  type AgentAccountsResponse,
  type AgentLoginResponse,
  agentRuntimeParamSchema,
  startAgentLoginRequestSchema,
  submitAgentLoginCodeRequestSchema,
} from '@launch/shared/launch-agents'
import { guardPermission } from '../middleware/permissions'
import { auditActor, recordAudit } from '../services/launch/audit'
import { runtimeFlagsOf, runtimeOptions } from '../services/sessions/credentials/resolve'
import { listPublic, removeForUser } from '../services/sessions/credentials/store'
import { loadSessionPolicy } from '../services/sessions/lifecycle'
import {
  assertLoginsEnabled,
  cancelLogin,
  getOwnLogin,
  listActiveLogins,
  requireLoginWorkflow,
  startLogin,
  submitLoginCode,
  toAgentLogin,
} from '../services/sessions/logins/service'
import { NotFoundError } from '../utils/core/errors'
import { uuidParam, withAuthAndDb } from '../utils/routes/route-helpers'
import { createRouter } from '../utils/routes/router'
import { validate } from '../utils/routes/validate'

export const meAgentsRouter = createRouter()

// ---- GET /api/me/agent-credentials ---------------------------------------------------------------

meAgentsRouter.get('/agent-credentials', async c => {
  guardPermission(c, 'read', 'Session')
  const { db, cfg, tenantId, user } = withAuthAndDb(c)
  const policy = await loadSessionPolicy(db)
  const [credentials, logins] = await Promise.all([
    listPublic(db, tenantId, user.id),
    listActiveLogins(db, tenantId, user.id),
  ])
  return c.json<AgentAccountsResponse>({
    runtimes: runtimeOptions(runtimeFlagsOf(cfg), policy),
    credentials,
    logins: logins.map(toAgentLogin),
  })
})

// ---- DELETE /api/me/agent-credentials/:runtime ---------------------------------------------------

meAgentsRouter.delete(
  '/agent-credentials/:runtime',
  validate('param', agentRuntimeParamSchema),
  async c => {
    guardPermission(c, 'create', 'Session')
    const { db, tenantId, user } = withAuthAndDb(c)
    const { runtime } = c.req.valid('param')
    const removed = await removeForUser(db, tenantId, user.id, runtime)
    if (!removed) throw new NotFoundError('No account is connected', 'agent_credential_not_found')
    await recordAudit(db, {
      ...auditActor(c),
      tenantId,
      action: 'agent_credential.removed',
      targetType: 'agent_credential',
      summary: { before: { runtime, credential: 'set' }, after: { runtime, credential: null } },
    })
    return c.body(null, 204)
  }
)

// ---- POST /api/me/agent-logins -------------------------------------------------------------------

meAgentsRouter.post('/agent-logins', validate('json', startAgentLoginRequestSchema), async c => {
  guardPermission(c, 'create', 'Session')
  const { db, cfg, tenantId, user } = withAuthAndDb(c)
  const { runtime } = c.req.valid('json')
  assertLoginsEnabled(runtimeFlagsOf(cfg), await loadSessionPolicy(db), runtime)
  const workflow = requireLoginWorkflow(c.env)
  const row = await startLogin(db, workflow, {
    tenantId,
    userId: user.id,
    runtime,
    actor: auditActor(c),
  })
  return c.json<AgentLoginResponse>({ login: toAgentLogin(row) }, 202)
})

// ---- GET /api/me/agent-logins/:id ----------------------------------------------------------------

meAgentsRouter.get('/agent-logins/:id', async c => {
  guardPermission(c, 'read', 'Session')
  const { db, tenantId, user } = withAuthAndDb(c)
  const row = await getOwnLogin(db, tenantId, user.id, uuidParam(c, 'id'))
  return c.json<AgentLoginResponse>({ login: toAgentLogin(row) })
})

// ---- POST /api/me/agent-logins/:id/code ----------------------------------------------------------

meAgentsRouter.post(
  '/agent-logins/:id/code',
  validate('json', submitAgentLoginCodeRequestSchema),
  async c => {
    guardPermission(c, 'create', 'Session')
    const { db, cfg, tenantId, user, logger } = withAuthAndDb(c)
    const row = await getOwnLogin(db, tenantId, user.id, uuidParam(c, 'id'))
    const workflow = requireLoginWorkflow(c.env)
    const { code } = c.req.valid('json')
    const updated = await submitLoginCode(db, cfg, workflow, row, code, { logger })
    return c.json<AgentLoginResponse>({ login: toAgentLogin(updated) }, 202)
  }
)

// ---- POST /api/me/agent-logins/:id/cancel --------------------------------------------------------

meAgentsRouter.post('/agent-logins/:id/cancel', async c => {
  guardPermission(c, 'create', 'Session')
  const { db, tenantId, user, logger } = withAuthAndDb(c)
  const row = await getOwnLogin(db, tenantId, user.id, uuidParam(c, 'id'))
  const workflow = (c.env as { AGENT_LOGIN_WORKFLOW?: Workflow }).AGENT_LOGIN_WORKFLOW
  const updated = await cancelLogin(db, workflow, row, { logger })
  return c.json<AgentLoginResponse>({ login: toAgentLogin(updated) })
})
