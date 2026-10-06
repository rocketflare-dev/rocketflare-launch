/**
 * `github.event` (issue #19): one GitHub App webhook delivery, verified and deduped by
 * `POST /api/github/webhook`, mapped to the landings and releases waiting on it and each of them
 * woken — `handleGitHubEventPayload` in `services/sessions/github-events.ts` is the whole policy;
 * this file binds it to `SESSION_WORKFLOW`. Idempotent: a retried message wakes the same instances
 * again, which costs one extra read of GitHub at most.
 */
import type { JobOf } from '@launch/shared/jobs'
import { handleGitHubEventPayload } from '../../services/sessions/github-events'
import type { JobContext } from '../jobs'

export async function handleGitHubEvent(
  job: JobOf<'github.event'>,
  ctx: JobContext
): Promise<void> {
  await handleGitHubEventPayload(job.payload, {
    db: ctx.db,
    workflow: (ctx.env as { SESSION_WORKFLOW?: Workflow }).SESSION_WORKFLOW,
    logger: ctx.logger,
  })
}
