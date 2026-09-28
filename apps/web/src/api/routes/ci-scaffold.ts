/**
 * `/ci/scaffold` (Launch P2, slice 2b) — the one-shot scaffold job's two calls. Public: the caller
 * has no session, it has a GitHub Actions OIDC token for the audience `APP_URL`. Each handler
 * proves it first — `verifyGitHubOidc` (401) then `resolveCaller` with `workflowFile:
 * launch-scaffold.yml` (403: another repo, another workflow file, another ref) — and uses only the
 * tenant of the resolved app row. The job carries no GitHub environment, so it resolves to the
 * app's production environment (`main`'s), where the pipeline opened its ticket.
 *
 * - `POST /token` → 200 `scaffoldTokenResponseSchema`, ONCE per ticket: claims the waiting scaffold
 *   ticket for this run, mints a one-hour installation token scoped to the one repo (`contents` +
 *   `workflows` write) and returns it with the plan. Nothing waiting, or already issued → 409
 *   `scaffold_token_unavailable`; GitHub refusing the mint → 502 (the ticket is then `failed`).
 *   Audit `app.scaffold.token_issued` — never the token. `Cache-Control: no-store`.
 * - `POST /done` `{ commit }` → 200: the ticket `finished` with `sha` = the pushed commit (the
 *   pipeline's wait reads the row), and `SCAFFOLD_FINISHED_EVENT { ticketId }` to the launch run
 *   as a bonus. Idempotent for the same commit. Audit `app.scaffold.finished`.
 */
import { scaffoldDoneSchema } from '@launch/shared/launch-pipeline'
import type { Context } from 'hono'
import { auditActor, recordAudit } from '../services/launch/audit'
import { resolveCaller } from '../services/launch/ci/caller'
import { bearerToken, verifyGitHubOidc } from '../services/launch/ci/github-oidc'
import { SCAFFOLD_WORKFLOW_FILE } from '../services/launch/rocketflare/scaffold-job'
import {
  completeScaffold,
  issueScaffoldToken,
  SCAFFOLD_TOKEN_PERMISSIONS,
} from '../services/launch/scaffold/service'
import { SCAFFOLD_ENVIRONMENT } from '../services/launch/scaffold/tickets'
import type { AppContext, AppEnv } from '../types'
import { ValidationError } from '../utils/core/errors'
import { createRouter } from '../utils/routes/router'

export const ciScaffoldRouter = createRouter()

/** The verified, resolved caller of a `/ci/scaffold` request. */
async function scaffoldCaller(c: Context<AppEnv>) {
  const cfg = c.get('config')
  const claims = await verifyGitHubOidc(bearerToken(c.req.header('authorization')), {
    audience: cfg.APP_URL,
  })
  return resolveCaller(c.get('db'), claims, {
    workflowFile: SCAFFOLD_WORKFLOW_FILE,
    defaultEnvironment: SCAFFOLD_ENVIRONMENT,
  })
}

/** A CI job is the app acting, not a person: `app`, with the request's ip / agent / id. */
function ciActor(c: AppContext) {
  return { ...auditActor(c), actorType: 'app' as const }
}

ciScaffoldRouter.post('/token', async c => {
  const db = c.get('db')
  const caller = await scaffoldCaller(c)
  const { response, ticket } = await issueScaffoldToken(db, c.get('config'), caller)
  await recordAudit(db, {
    tenantId: caller.tenantId,
    ...ciActor(c),
    action: 'app.scaffold.token_issued',
    targetType: 'App',
    targetId: caller.app.id,
    appId: caller.app.id,
    summary: {
      after: {
        ticketId: ticket.id,
        repository: caller.claims.repository,
        runId: caller.claims.run_id,
        actor: caller.claims.actor,
        permissions: SCAFFOLD_TOKEN_PERMISSIONS,
        expiresAt: response.expiresAt,
        // A release: repo@tag; an unreleased commit (no tag): repo@<full sha>.
        kit: `${response.plan.kitRepo}@${response.plan.tag ?? response.plan.commit}`,
        kitCommit: response.plan.commit,
      },
    },
  })
  c.header('Cache-Control', 'no-store')
  return c.json(response)
})

// The body is validated AFTER the caller is proven: an unproven caller learns nothing but 401.
ciScaffoldRouter.post('/done', async c => {
  const db = c.get('db')
  const caller = await scaffoldCaller(c)
  const parsed = scaffoldDoneSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) throw new ValidationError(parsed.error.issues, 'Invalid json')
  const { commit } = parsed.data
  const done = await completeScaffold(db, c.env.APP_LAUNCH_WORKFLOW, caller, commit)
  if (!done.notified && done.notifyError) {
    c.get('logger').warn(
      { ticketId: done.ticket.id, launchRunId: done.ticket.launchRunId, err: done.notifyError },
      'scaffold finished, but the launch run could not be told'
    )
  }
  if (!done.repeated) {
    await recordAudit(db, {
      tenantId: caller.tenantId,
      ...ciActor(c),
      action: 'app.scaffold.finished',
      targetType: 'App',
      targetId: caller.app.id,
      appId: caller.app.id,
      summary: {
        after: { ticketId: done.ticket.id, commit, runId: caller.claims.run_id },
      },
    })
  }
  return c.json({ ticketId: done.ticket.id, status: done.ticket.status, notified: done.notified })
})
