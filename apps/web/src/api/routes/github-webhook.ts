/**
 * `POST /api/github/webhook` (issue #19) — the GitHub App's webhook. PUBLIC by design (GitHub has
 * no session): mounted before the authed table in `api/index.ts`, and it proves the caller itself.
 *
 * 1. No `GITHUB_WEBHOOK_SECRET` → 503 `github_webhook_not_configured` (Launch polls, as before).
 * 2. `X-Hub-Signature-256` over the RAW body, constant-time (`verifyGitHubSignature`): missing or
 *    wrong → 401 `github_signature_invalid`, before anything is parsed or written.
 * 3. `X-GitHub-Delivery` and `X-GitHub-Event` are required (400 otherwise). A `ping` (sent when
 *    the hook is created or edited) answers 200 and queues nothing; so does an event or action no
 *    wait reads (`toGitHubEventPayload` → null, `reason: 'ignored'`).
 * 4. The delivery is CLAIMED (`github_webhook_deliveries`); a repeated delivery id answers 202
 *    `reason: 'duplicate'` and enqueues nothing more.
 * 5. One `github.event` job on `JOBS_QUEUE`, then 202. The route never looks an app up and never
 *    wakes anything: the job does (`queues/handlers/github-event.ts`). A failed enqueue gives the
 *    claim back and answers 503, so GitHub's own retry is not mistaken for a duplicate.
 *
 * Body cap: the `/api/*` JSON cap (1 MB). A larger delivery is a 413 GitHub records as failed —
 * the poll that follows the wait reads the same state anyway.
 */
import type { GitHubWebhookResponse } from '@launch/shared/launch-github'
import { enqueueJob } from '../services/jobs'
import {
  claimGitHubDelivery,
  releaseGitHubDelivery,
  toGitHubEventPayload,
  verifyGitHubSignature,
} from '../services/launch/github-webhook'
import { BadRequestError, ServiceUnavailableError, UnauthorizedError } from '../utils/core/errors'
import { createRouter } from '../utils/routes/router'

export const githubWebhookRouter = createRouter()

/**
 * Receives GitHub's webhook delivery and enqueues a `github.event` job. Public — verified by its
 * own HMAC signature instead of a session. Returns 401 `github_signature_invalid` for a bad
 * signature, 503 `github_webhook_not_configured` without a secret, and 202 `reason: duplicate`
 * for a delivery id already claimed.
 */
githubWebhookRouter.post('/webhook', async c => {
  const cfg = c.get('config')
  const secret = cfg.GITHUB_WEBHOOK_SECRET
  if (!secret) {
    throw new ServiceUnavailableError(
      'GitHub webhooks are not configured on this deployment',
      'github_webhook_not_configured'
    )
  }
  const raw = new Uint8Array(await c.req.arrayBuffer())
  if (!(await verifyGitHubSignature(secret, raw, c.req.header('x-hub-signature-256')))) {
    throw new UnauthorizedError(
      'The webhook signature is missing or wrong',
      'github_signature_invalid'
    )
  }

  const deliveryId = c.req.header('x-github-delivery')?.trim() ?? ''
  const event = c.req.header('x-github-event')?.trim() ?? ''
  if (!deliveryId || deliveryId.length > 100 || !event) {
    throw new BadRequestError(
      'X-GitHub-Delivery and X-GitHub-Event are required',
      'github_webhook_headers_missing'
    )
  }
  if (event === 'ping') {
    return c.json<GitHubWebhookResponse>({ queued: false, deliveryId, reason: 'ping' }, 200)
  }
  let body: unknown
  try {
    body = JSON.parse(new TextDecoder().decode(raw))
  } catch {
    throw new BadRequestError('The webhook body is not JSON', 'github_webhook_body_invalid')
  }
  const payload = toGitHubEventPayload(event, deliveryId, body)
  if (!payload) {
    return c.json<GitHubWebhookResponse>({ queued: false, deliveryId, reason: 'ignored' }, 200)
  }

  const db = c.get('db')
  if (!(await claimGitHubDelivery(db, deliveryId, event))) {
    return c.json<GitHubWebhookResponse>({ queued: false, deliveryId, reason: 'duplicate' }, 202)
  }
  try {
    await enqueueJob(c.env.JOBS_QUEUE, { type: 'github.event', payload })
  } catch (err) {
    await releaseGitHubDelivery(db, deliveryId)
    c.get('logger')?.warn({ err, deliveryId, event }, 'github webhook: could not enqueue')
    throw new ServiceUnavailableError(
      'Could not queue the delivery',
      'github_webhook_enqueue_failed'
    )
  }
  return c.json<GitHubWebhookResponse>({ queued: true, deliveryId }, 202)
})
