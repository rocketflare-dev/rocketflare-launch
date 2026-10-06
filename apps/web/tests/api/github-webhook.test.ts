/**
 * Issue #19: `POST /api/github/webhook` — the GitHub App's webhook. Signature first (constant-time,
 * 401 when missing or wrong, before anything is written), the delivery id claimed once (a
 * redelivery enqueues nothing more), one `github.event` job per delivery and a 202; a `ping` and
 * an event no wait reads answer 200 and queue nothing; no secret configured is a 503. Plus the
 * pure halves: the signature check and the reduction of each event to its subject.
 */
import type { JobEnvelope } from '@launch/shared/jobs'
import type { GitHubWebhookResponse } from '@launch/shared/launch-github'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import {
  pruneGitHubDeliveries,
  signGitHubPayload,
  toGitHubEventPayload,
  verifyGitHubSignature,
} from '@/api/services/launch/github-webhook'
import { githubWebhookDeliveries } from '@/db/schema'
import { setupTestDatabase } from '../helpers/db'
import {
  checkRunCompleted,
  postWebhook,
  pullRequestEvent,
  pushEvent,
  releaseEvent,
  WEBHOOK_SECRET,
  type WebhookRepo,
  workflowRunCompleted,
} from '../helpers/github-webhooks'
import { json, request } from '../helpers/request'
import { createTestEnv, stubs } from '../mocks/bindings'

const db = setupTestDatabase()
const REPO: WebhookRepo = { id: 9001, owner: 'acme', name: 'shop' }
const SHA = 'a'.repeat(40)

function env() {
  return createTestEnv({ GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET })
}
const queued = (e: ReturnType<typeof env>) =>
  stubs(e).queue.messages.map(m => m.body as JobEnvelope)

describe('POST /api/github/webhook', () => {
  it('a valid signature enqueues ONE github.event job and answers 202', async () => {
    const e = env()
    const deliveryId = crypto.randomUUID()
    const res = await postWebhook(e, 'check_run', checkRunCompleted(REPO, { sha: SHA, prs: [7] }), {
      deliveryId,
    })
    expect(res.status).toBe(202)
    expect(await json<GitHubWebhookResponse>(res)).toEqual({ queued: true, deliveryId })
    const jobs = queued(e)
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({
      type: 'github.event',
      payload: {
        deliveryId,
        event: 'check_run',
        action: 'completed',
        installationId: 4242,
        repository: { id: '9001', owner: 'acme', name: 'shop' },
        headSha: SHA,
        prNumbers: [7],
      },
    })
  })

  it('a wrong or missing signature is a 401 and enqueues nothing', async () => {
    const e = env()
    const body = checkRunCompleted(REPO, { sha: SHA })
    const wrongSecret = await postWebhook(e, 'check_run', body, { secret: 'not-the-secret' })
    expect(wrongSecret.status).toBe(401)
    expect((await json<{ code: string }>(wrongSecret)).code).toBe('github_signature_invalid')
    expect((await postWebhook(e, 'check_run', body, { signature: null })).status).toBe(401)
    expect((await postWebhook(e, 'check_run', body, { signature: 'sha256=zz' })).status).toBe(401)
    expect(
      (await postWebhook(e, 'check_run', body, { signature: `sha1=${'0'.repeat(40)}` })).status
    ).toBe(401)
    expect(queued(e)).toHaveLength(0)
  })

  it('a signature over different bytes is refused (the body is verified raw)', async () => {
    const e = env()
    const body = checkRunCompleted(REPO, { sha: SHA })
    const other = await signGitHubPayload(WEBHOOK_SECRET, JSON.stringify({ ...body, extra: 1 }))
    expect((await postWebhook(e, 'check_run', body, { signature: other })).status).toBe(401)
    expect(queued(e)).toHaveLength(0)
  })

  it('a repeated delivery id enqueues nothing more', async () => {
    const e = env()
    const deliveryId = crypto.randomUUID()
    const body = workflowRunCompleted(REPO, { sha: SHA, branch: 'main' })
    expect((await postWebhook(e, 'workflow_run', body, { deliveryId })).status).toBe(202)
    const again = await postWebhook(e, 'workflow_run', body, { deliveryId })
    expect(again.status).toBe(202)
    expect(await json<GitHubWebhookResponse>(again)).toEqual({
      queued: false,
      deliveryId,
      reason: 'duplicate',
    })
    expect(queued(e)).toHaveLength(1)
    // Another delivery of the same event is a new delivery.
    expect((await postWebhook(e, 'workflow_run', body)).status).toBe(202)
    expect(queued(e)).toHaveLength(2)
  })

  it('a ping, and an event or action no wait reads, answer 200 and queue nothing', async () => {
    const e = env()
    const ping = await postWebhook(e, 'ping', { zen: 'Keep it logically awesome.' })
    expect(ping.status).toBe(200)
    expect((await json<GitHubWebhookResponse>(ping)).reason).toBe('ping')
    const created = { ...checkRunCompleted(REPO, { sha: SHA }), action: 'created' }
    const ignored = await postWebhook(e, 'check_run', created)
    expect(ignored.status).toBe(200)
    expect((await json<GitHubWebhookResponse>(ignored)).reason).toBe('ignored')
    expect((await postWebhook(e, 'issues', { action: 'opened', repository: {} })).status).toBe(200)
    expect(queued(e)).toHaveLength(0)
  })

  it('still verifies a ping: an unsigned one is a 401', async () => {
    expect((await postWebhook(env(), 'ping', {}, { signature: null })).status).toBe(401)
  })

  it('needs the delivery and event headers', async () => {
    const e = env()
    const raw = JSON.stringify(checkRunCompleted(REPO, { sha: SHA }))
    const res = await request(
      '/api/github/webhook',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Hub-Signature-256': await signGitHubPayload(WEBHOOK_SECRET, raw),
        },
        body: raw,
      },
      { env: e }
    )
    expect(res.status).toBe(400)
    expect(queued(e)).toHaveLength(0)
  })

  it('is a 503 when no webhook secret is configured (Launch polls)', async () => {
    const res = await postWebhook(
      createTestEnv(),
      'check_run',
      checkRunCompleted(REPO, { sha: SHA })
    )
    expect(res.status).toBe(503)
    expect((await json<{ code: string }>(res)).code).toBe('github_webhook_not_configured')
  })

  it('gives the claim back when the enqueue fails, so GitHub’s retry is accepted', async () => {
    const e = env()
    const deliveryId = crypto.randomUUID()
    const queue = stubs(e).queue
    const send = queue.send.bind(queue)
    queue.send = async () => {
      throw new Error('queue unavailable')
    }
    const body = pushEvent(REPO, { ref: 'refs/heads/main', after: SHA })
    expect((await postWebhook(e, 'push', body, { deliveryId })).status).toBe(503)
    expect(
      await db
        .select()
        .from(githubWebhookDeliveries)
        .where(eq(githubWebhookDeliveries.deliveryId, deliveryId))
    ).toHaveLength(0)
    queue.send = send
    expect((await postWebhook(e, 'push', body, { deliveryId })).status).toBe(202)
    expect(queued(e)).toHaveLength(1)
  })
})

describe('verifyGitHubSignature', () => {
  const body = new TextEncoder().encode('{"hello":"world"}')
  it('accepts GitHub’s signature and nothing else', async () => {
    const good = await signGitHubPayload('s3cret', '{"hello":"world"}')
    expect(good).toMatch(/^sha256=[0-9a-f]{64}$/)
    expect(await verifyGitHubSignature('s3cret', body, good)).toBe(true)
    expect(
      await verifyGitHubSignature('s3cret', body, good.toUpperCase().replace('SHA256', 'sha256'))
    ).toBe(true)
    expect(await verifyGitHubSignature('other', body, good)).toBe(false)
    expect(await verifyGitHubSignature('s3cret', body, `${good.slice(0, -2)}00`)).toBe(false)
    expect(await verifyGitHubSignature('s3cret', body, good.slice(0, -2))).toBe(false)
    expect(await verifyGitHubSignature('s3cret', body, null)).toBe(false)
    expect(await verifyGitHubSignature('', body, good)).toBe(false)
  })
})

describe('toGitHubEventPayload', () => {
  const reduce = (event: string, body: unknown) => toGitHubEventPayload(event, 'd-1', body)

  it('a completed check run: its head SHA, its suite’s branch (or tag) and its PRs', () => {
    expect(
      reduce(
        'check_run',
        checkRunCompleted(REPO, { sha: SHA, branch: 'session/abc', prs: [3, 3, 4] })
      )
    ).toMatchObject({ headSha: SHA, ref: 'session/abc', refKind: null, prNumbers: [3, 4] })
    expect(
      reduce('check_run', { ...checkRunCompleted(REPO, { sha: SHA }), action: 'created' })
    ).toBeNull()
  })

  it('a completed workflow run names its head branch — the tag, for a tag push', () => {
    expect(
      reduce('workflow_run', workflowRunCompleted(REPO, { sha: SHA, branch: '1.4.1' }))
    ).toMatchObject({
      headSha: SHA,
      ref: '1.4.1',
      refKind: null,
    })
    expect(
      reduce('workflow_run', {
        ...workflowRunCompleted(REPO, { sha: SHA, branch: 'main' }),
        action: 'requested',
      })
    ).toBeNull()
  })

  it('a PR closed, reopened or pushed to; nothing else', () => {
    expect(
      reduce('pull_request', pullRequestEvent(REPO, { number: 12, action: 'closed', sha: SHA }))
    ).toMatchObject({
      prNumbers: [12],
      headSha: SHA,
    })
    expect(
      reduce(
        'pull_request',
        pullRequestEvent(REPO, { number: 12, action: 'synchronize', sha: SHA })
      )
    ).not.toBeNull()
    expect(
      reduce('pull_request', pullRequestEvent(REPO, { number: 12, action: 'labeled', sha: SHA }))
    ).toBeNull()
  })

  it('a push says branch or tag; a branch delete is ignored', () => {
    expect(reduce('push', pushEvent(REPO, { ref: 'refs/heads/main', after: SHA }))).toMatchObject({
      ref: 'main',
      refKind: 'branch',
      headSha: SHA,
    })
    expect(reduce('push', pushEvent(REPO, { ref: 'refs/tags/1.4.1', after: SHA }))).toMatchObject({
      ref: '1.4.1',
      refKind: 'tag',
    })
    expect(
      reduce('push', { ...pushEvent(REPO, { ref: 'refs/heads/x', after: SHA }), deleted: true })
    ).toBeNull()
  })

  it('a release names its tag; a delete is ignored; a payload with no repository is ignored', () => {
    expect(reduce('release', releaseEvent(REPO, { tag: '1.4.1' }))).toMatchObject({
      ref: '1.4.1',
      refKind: 'tag',
    })
    expect(reduce('release', releaseEvent(REPO, { tag: '1.4.1', action: 'deleted' }))).toBeNull()
    expect(reduce('push', { ref: 'refs/heads/main', after: SHA })).toBeNull()
  })
})

describe('pruneGitHubDeliveries', () => {
  it('forgets delivery ids older than the retention, keeps recent ones', async () => {
    const old = crypto.randomUUID()
    const recent = crypto.randomUUID()
    await db.insert(githubWebhookDeliveries).values([
      { deliveryId: old, event: 'push', receivedAt: new Date(Date.now() - 8 * 86_400_000) },
      { deliveryId: recent, event: 'push' },
    ])
    await pruneGitHubDeliveries(db)
    const left = await db.select().from(githubWebhookDeliveries)
    expect(left.map(r => r.deliveryId)).toContain(recent)
    expect(left.map(r => r.deliveryId)).not.toContain(old)
  })
})
