/**
 * `/ci/kit-check` (D36 K3) — the two calls of a kit's DYNAMIC conformance check job: the scaffold
 * job (`scaffold/job.ts`, generated with `endpoint: '/ci/kit-check'`) running in the throwaway repo
 * `launch-kit-check-<kit>-<id>` that `kits/dynamic-check.ts` created. Public, like `/ci/scaffold`:
 * the caller has a GitHub Actions OIDC token for the audience `APP_URL`. Each handler proves it
 * first — `verifyGitHubOidc` (401) then `resolveKitCheckCaller` (403 `ci_caller_refused`: not the
 * running check's repo, another workflow file, another ref).
 *
 * - `POST /token` → 200 `scaffoldTokenResponseSchema`, ONCE per check (409
 *   `scaffold_token_unavailable` after): a one-hour token for the throwaway repo (`contents` +
 *   `workflows` write), a kit read token for a private kit, the plan (`ticketId` is the check's
 *   id). Audit `kit.check_token_issued` — never a token. `Cache-Control: no-store`.
 * - `POST /done` `{ commit }` → 200: the pushed commit recorded on the check, and its `finish`
 *   phase enqueued (the copy is checked, the repo removed). Idempotent for the same commit.
 *
 * There is no tenant: a kit is the platform's. The audit row goes to the tenant the check was
 * started from (`dynamic_check.auditTenantId`).
 */
import { scaffoldDoneSchema } from '@launch/shared/launch-pipeline'
import type { Context } from 'hono'
import { auditActor, recordAudit } from '../services/launch/audit'
import { bearerToken, verifyGitHubOidc } from '../services/launch/ci/github-oidc'
import {
  completeKitCheck,
  issueKitCheckToken,
  resolveKitCheckCaller,
} from '../services/launch/kits/dynamic-check'
import {
  KIT_TOKEN_PERMISSIONS,
  SCAFFOLD_TOKEN_PERMISSIONS,
} from '../services/launch/scaffold/service'
import type { AppEnv } from '../types'
import { ValidationError } from '../utils/core/errors'
import { createRouter } from '../utils/routes/router'

export const ciKitCheckRouter = createRouter()

async function kitCheckCaller(c: Context<AppEnv>) {
  const claims = await verifyGitHubOidc(bearerToken(c.req.header('authorization')), {
    audience: c.get('config').APP_URL,
  })
  return resolveKitCheckCaller(c.get('db'), claims)
}

ciKitCheckRouter.post('/token', async c => {
  const db = c.get('db')
  const caller = await kitCheckCaller(c)
  const response = await issueKitCheckToken(
    { db, cfg: c.get('config'), queue: c.env.JOBS_QUEUE },
    caller
  )
  await recordAudit(db, {
    tenantId: caller.check.auditTenantId,
    ...auditActor(c),
    actorType: 'app',
    action: 'kit.check_token_issued',
    targetType: 'Kit',
    targetId: caller.kit.id,
    summary: {
      after: {
        checkId: caller.check.id,
        repository: caller.claims.repository,
        runId: caller.claims.run_id,
        permissions: SCAFFOLD_TOKEN_PERMISSIONS,
        kit: `${response.plan.kitRepo}@${response.plan.tag ?? response.plan.commit}`,
        kitToken: response.kitToken
          ? { repository: response.plan.kitRepo, permissions: KIT_TOKEN_PERMISSIONS }
          : null,
        expiresAt: response.expiresAt,
      },
    },
  })
  c.header('Cache-Control', 'no-store')
  return c.json(response)
})

// The body is validated AFTER the caller is proven: an unproven caller learns nothing but 401.
ciKitCheckRouter.post('/done', async c => {
  const caller = await kitCheckCaller(c)
  const parsed = scaffoldDoneSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) throw new ValidationError(parsed.error.issues, 'Invalid json')
  const done = await completeKitCheck(
    { db: c.get('db'), queue: c.env.JOBS_QUEUE },
    caller,
    parsed.data.commit
  )
  return c.json({ ticketId: done.checkId, status: 'finished', notified: !done.repeated })
})
