/**
 * Issue #19's GitHub App webhook, as GitHub delivers it: signed bodies posted to the real route,
 * the deliveries GitHub would send for the events a landing waits on, and the `JOBS_QUEUE` drained
 * through the real consumer — so a test runs route → queue → handler → `instance.sendEvent` end to
 * end, with the session's `RecordingWorkflow` as the platform's event store.
 */
import { vi } from 'vitest'
import { processJobsBatch } from '@/api/queues/jobs'
import { signGitHubPayload } from '@/api/services/launch/github-webhook'
import type { Logger } from '@/api/utils/core/logger'
import { loadConfig } from '@/config'
import type { Database } from '@/db/client'
import { stubs, type TestEnv } from '../mocks/bindings'
import { request } from './request'

/** The secret the tests put on `env.GITHUB_WEBHOOK_SECRET`. */
export const WEBHOOK_SECRET = 'whsec-test-0123456789abcdef'

/** A repository as a delivery names it. */
export interface WebhookRepo {
  id: number
  owner: string
  name: string
}

/** A numeric repository id no other test uses (`apps.github_repo_id` is unique globally). */
export function uniqueRepoId(): number {
  return 100_000_000 + Math.floor(Math.random() * 1_000_000_000)
}

function envelope(repo: WebhookRepo, extra: Record<string, unknown>) {
  return {
    ...extra,
    repository: {
      id: repo.id,
      name: repo.name,
      full_name: `${repo.owner}/${repo.name}`,
      owner: { login: repo.owner },
    },
    installation: { id: 4242 },
  }
}

/** `check_run` `completed` on `sha` (a PR's check names it in `pull_requests`). */
export function checkRunCompleted(
  repo: WebhookRepo,
  input: { sha: string; name?: string; conclusion?: string; branch?: string; prs?: number[] }
) {
  return envelope(repo, {
    action: 'completed',
    check_run: {
      id: 1,
      name: input.name ?? 'Gate',
      head_sha: input.sha,
      status: 'completed',
      conclusion: input.conclusion ?? 'success',
      check_suite: { head_branch: input.branch ?? null },
      pull_requests: (input.prs ?? []).map(number => ({ number })),
    },
  })
}

/** `workflow_run` `completed` — a tag's deploy run names the TAG as its `head_branch`. */
export function workflowRunCompleted(
  repo: WebhookRepo,
  input: { sha: string; branch: string; conclusion?: string; event?: string }
) {
  return envelope(repo, {
    action: 'completed',
    workflow_run: {
      id: 7,
      name: 'Deploy',
      head_sha: input.sha,
      head_branch: input.branch,
      event: input.event ?? 'push',
      status: 'completed',
      conclusion: input.conclusion ?? 'success',
      pull_requests: [],
    },
  })
}

/** `pull_request` with `action` (`closed` with `merged` for a person's merge). */
export function pullRequestEvent(
  repo: WebhookRepo,
  input: { number: number; action: string; sha: string; merged?: boolean }
) {
  return envelope(repo, {
    action: input.action,
    number: input.number,
    pull_request: { number: input.number, merged: input.merged ?? false, head: { sha: input.sha } },
  })
}

/** `push` of `ref` (`refs/heads/main`, `refs/tags/1.2.3`) to `after`. */
export function pushEvent(repo: WebhookRepo, input: { ref: string; after: string }) {
  return envelope(repo, { ref: input.ref, after: input.after, deleted: false })
}

/** `release` `published` for `tag`. */
export function releaseEvent(repo: WebhookRepo, input: { tag: string; action?: string }) {
  return envelope(repo, { action: input.action ?? 'published', release: { tag_name: input.tag } })
}

/**
 * POST one delivery to `/api/github/webhook` as GitHub does: the raw JSON, `X-GitHub-Event`,
 * `X-GitHub-Delivery` and `X-Hub-Signature-256` under {@link WEBHOOK_SECRET} (or `signature`).
 */
export async function postWebhook(
  env: TestEnv,
  event: string,
  body: unknown,
  opts: { deliveryId?: string; signature?: string | null; secret?: string } = {}
): Promise<Response> {
  const raw = JSON.stringify(body)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-GitHub-Event': event,
    'X-GitHub-Delivery': opts.deliveryId ?? crypto.randomUUID(),
    'User-Agent': 'GitHub-Hookshot/test',
  }
  const signature =
    opts.signature === undefined
      ? await signGitHubPayload(opts.secret ?? WEBHOOK_SECRET, raw)
      : opts.signature
  if (signature !== null) headers['X-Hub-Signature-256'] = signature
  return request('/api/github/webhook', { method: 'POST', headers, body: raw }, { env })
}

function quietLogger() {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => log }
  return log as unknown as Logger & typeof log
}

/**
 * Run every message waiting on `env.JOBS_QUEUE` through the real consumer (`processJobsBatch`)
 * and empty the queue. Returns how many were acked and retried.
 */
export async function drainJobs(
  env: TestEnv,
  db: Database
): Promise<{ acked: number; retried: number }> {
  const queue = stubs(env).queue
  const pending = queue.messages.splice(0)
  const out = { acked: 0, retried: 0 }
  const messages = pending.map((m, i) => ({
    id: `m-${i}`,
    timestamp: new Date(),
    body: m.body,
    attempts: 1,
    ack: () => {
      out.acked++
    },
    retry: () => {
      out.retried++
    },
  }))
  const batch = {
    queue: 'launch-jobs',
    messages,
    ackAll: () => {},
    retryAll: () => {},
  } as unknown as MessageBatch<unknown>
  await processJobsBatch(batch, {
    env,
    config: loadConfig(env),
    logger: quietLogger(),
    createDb: () => ({ db, close: async () => {} }) as never,
  })
  return out
}
