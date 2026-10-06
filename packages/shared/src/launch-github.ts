/**
 * GitHub App webhooks (issue #19): what `POST /api/github/webhook` accepts, what it answers, and
 * the `github.event` job it enqueues on `JOBS_QUEUE`.
 *
 * The route verifies `X-Hub-Signature-256`, claims `X-GitHub-Delivery` once, and enqueues only the
 * few fields that name a SUBJECT — the repo, a head SHA, a branch or tag, PR numbers — never the
 * raw payload (a `push` can be hundreds of kilobytes; a queue message is capped at 128 KB). The
 * queue handler maps those fields to the landings and releases waiting on them and wakes them.
 * A webhook only ever WAKES a wait early: what the wait then reads is GitHub itself, as when the
 * round timed out, so correctness stays with polling.
 */
import { z } from 'zod'

/** The events the App subscribes to (`default_events` in the provisioning manifest). */
export const GITHUB_WEBHOOK_EVENTS = [
  'check_run',
  'workflow_run',
  'pull_request',
  'push',
  'release',
] as const
export const githubWebhookEventSchema = z.enum(GITHUB_WEBHOOK_EVENTS)
export type GitHubWebhookEvent = z.infer<typeof githubWebhookEventSchema>

/** Where the App delivers (the path under `APP_URL`). */
export const GITHUB_WEBHOOK_PATH = '/api/github/webhook'

/**
 * Whether `ref` names a branch or a tag. A workflow run's or check suite's `head_branch` is a
 * branch name for a branch push and the TAG name for a tag push, and GitHub does not say which:
 * those carry `null`, and the handler tries both readings.
 */
export const githubRefKindSchema = z.enum(['branch', 'tag']).nullable()

/** The `github.event` job's payload: one delivery, reduced to its subject. */
export const githubEventPayloadSchema = z.object({
  /** `X-GitHub-Delivery` — already claimed by the route; carried for the logs. */
  deliveryId: z.string().min(1).max(100),
  event: githubWebhookEventSchema,
  action: z.string().max(100).nullable(),
  /** The App installation that sent it (`installation.id`), when the payload names one. */
  installationId: z.number().int().nullable(),
  repository: z.object({
    /** GitHub's numeric repository id, as a string (`apps.github_repo_id`). */
    id: z.string().min(1).max(32),
    owner: z.string().min(1).max(100),
    name: z.string().min(1).max(100),
  }),
  /** The commit the event is about: a check's or run's `head_sha`, a PR's head, a push's `after`. */
  headSha: z.string().max(64).nullable(),
  /** A branch or tag name (see {@link githubRefKindSchema}). */
  ref: z.string().max(255).nullable(),
  refKind: githubRefKindSchema,
  /** The pull requests the event names (a PR event's own; a check's or run's `pull_requests`). */
  prNumbers: z.array(z.number().int().positive()).max(50),
})
export type GitHubEventPayload = z.infer<typeof githubEventPayloadSchema>

/** `POST /api/github/webhook` → 202 (or 200 for a `ping` and for an event Launch ignores). */
export const githubWebhookResponseSchema = z.object({
  /** True when a `github.event` job was enqueued for this delivery. */
  queued: z.boolean(),
  deliveryId: z.string(),
  /** Why nothing was queued: `ping`, `ignored` (an event or action no wait reads), `duplicate`. */
  reason: z.enum(['ping', 'ignored', 'duplicate']).optional(),
})
export type GitHubWebhookResponse = z.infer<typeof githubWebhookResponseSchema>
