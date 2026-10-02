/**
 * `releases ls|create|promote [--wait]` (Launch P4), in-process against a fake server: the app is
 * resolved by slug, `create` posts the bump, `promote` accepts a version and prints the approval's
 * page, and `--wait` follows the approval then the release — exit 1 unless production is live.
 * `retry` (app page P2) sends the stage the release is stuck at and says what Launch did; a release
 * with nothing failing exits 1 before any POST; `cancel` posts and points at `retry`.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  runReleasesCancel,
  runReleasesCreate,
  runReleasesList,
  runReleasesPromote,
  runReleasesRetry,
} from '../src/commands/releases'
import { EXIT_ERROR, exitCodeFor } from '../src/errors'
import { captureError, jsonResponse, mockFetch, testContext } from './helpers'
import {
  APP_ID,
  APPROVAL_ID,
  appDetail,
  BOB,
  detail,
  loggedInStore,
  RELEASE_ID,
  release,
  SERVER,
} from './p4-fixtures'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(fn => fn()))
})
const store = () => loggedInStore(cleanups)
const noSleep = async () => {}
const releases = `/api/apps/${APP_ID}/releases`
const promoted = () =>
  jsonResponse(
    {
      release: release({ status: 'awaiting_approval', approvalId: APPROVAL_ID }),
      approvalId: APPROVAL_ID,
    },
    202
  )

describe('releases ls / create', () => {
  it('lists an app’s releases; --json is the raw body', async () => {
    const { fetch } = mockFetch({
      '/api/apps/expenses': () => jsonResponse(appDetail),
      [releases]: () => jsonResponse({ items: [release()] }),
    })
    const human = await testContext({ store: await store(), fetch })
    await runReleasesList(human.ctx, 'expenses')
    expect(human.out.content()).toContain('live on staging')
    const json = await testContext({ store: await store(), fetch, json: true })
    await runReleasesList(json.ctx, 'expenses')
    expect(JSON.parse(json.out.content()).items[0].version).toBe('1.4.0')
  })

  it('creates a release with the bump (patch by default)', async () => {
    const { fetch, calls } = mockFetch({
      '/api/apps/expenses': () => jsonResponse(appDetail),
      [releases]: () => jsonResponse(release({ status: 'tagged' }), 201),
    })
    const { ctx, out } = await testContext({ store: await store(), fetch })
    await runReleasesCreate(ctx, 'expenses')
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({ bump: 'patch' })
    await runReleasesCreate(ctx, 'expenses', { bump: 'minor' })
    expect(JSON.parse(String(calls[3]?.init.body))).toEqual({ bump: 'minor' })
    expect(out.content()).toContain('Tagged 1.4.0')
    expect(out.content()).toContain('#12 Blue button')
  })
})

describe('releases promote', () => {
  it('resolves a version, posts the reason and prints the approval page', async () => {
    const { fetch, calls } = mockFetch({
      '/api/apps/expenses': () => jsonResponse(appDetail),
      [releases]: () => jsonResponse({ items: [release()] }),
      [`${releases}/${RELEASE_ID}/promote`]: promoted,
    })
    const { ctx, out } = await testContext({ store: await store(), fetch })
    await runReleasesPromote(ctx, 'expenses', '1.4.0', { reason: 'Ship it' })
    expect(calls[2]?.url.pathname).toBe(`${releases}/${RELEASE_ID}/promote`)
    expect(JSON.parse(String(calls[2]?.init.body))).toEqual({ reason: 'Ship it' })
    expect(out.content()).toContain(`${SERVER}/approvals/${APPROVAL_ID}`)
  })

  it('--wait follows the approval and then the release until production is live', async () => {
    const approvals = [detail(), detail(), detail({ status: 'approved', approvals: 1 })]
    const statuses = ['promoting', 'production_active']
    const { fetch } = mockFetch({
      '/api/apps/expenses': () => jsonResponse(appDetail),
      [`${releases}/${RELEASE_ID}`]: () =>
        jsonResponse(release({ status: statuses.shift() ?? 'production_active' })),
      [`${releases}/${RELEASE_ID}/promote`]: promoted,
      [`/api/approvals/${APPROVAL_ID}`]: () => jsonResponse(approvals.shift() ?? detail()),
    })
    const { ctx, out } = await testContext({ store: await store(), fetch })
    await runReleasesPromote(ctx, 'expenses', RELEASE_ID, { wait: true, sleep: noSleep })
    expect(approvals).toHaveLength(0)
    expect(statuses).toHaveLength(0)
    expect(out.content()).toContain('1.4.0 is live in production')
  })

  it('--wait on a rejection exits 1 with the comment; --json prints one document', async () => {
    const rejected = detail({
      status: 'rejected',
      decisions: [
        {
          id: 'dec00000-0000-4000-8000-000000000001',
          requestId: APPROVAL_ID,
          userId: BOB,
          userEmail: 'bob@example.com',
          userName: 'Bob',
          decision: 'reject',
          comment: 'Staging is flaky',
          at: '2026-09-28T11:00:00.000Z',
        },
      ],
    })
    const { fetch } = mockFetch({
      '/api/apps/expenses': () => jsonResponse(appDetail),
      [`${releases}/${RELEASE_ID}`]: () => jsonResponse(release()),
      [`${releases}/${RELEASE_ID}/promote`]: promoted,
      [`/api/approvals/${APPROVAL_ID}`]: () => jsonResponse(rejected),
    })
    const { ctx, out } = await testContext({ store: await store(), fetch, json: true })
    const error = await captureError(
      runReleasesPromote(ctx, 'expenses', RELEASE_ID, { wait: true, sleep: noSleep })
    )
    expect(exitCodeFor(error)).toBe(EXIT_ERROR)
    expect(error.message).toContain('rejected')
    expect(error.hint).toBe('Bob: Staging is flaky')
    expect(JSON.parse(out.content()).approval.status).toBe('rejected')
  })

  it('--wait exits 1 when the production deploy fails', async () => {
    const { fetch } = mockFetch({
      '/api/apps/expenses': () => jsonResponse(appDetail),
      [`${releases}/${RELEASE_ID}`]: () =>
        jsonResponse(release({ status: 'failed', error: 'upload failed' })),
      [`${releases}/${RELEASE_ID}/promote`]: promoted,
      [`/api/approvals/${APPROVAL_ID}`]: () =>
        jsonResponse(detail({ status: 'approved', approvals: 1 })),
    })
    const { ctx } = await testContext({ store: await store(), fetch })
    const error = await captureError(
      runReleasesPromote(ctx, 'expenses', RELEASE_ID, { wait: true, sleep: noSleep })
    )
    expect(exitCodeFor(error)).toBe(EXIT_ERROR)
    expect(error.hint).toBe('upload failed')
  })

  it('an unknown version is a clear error', async () => {
    const { fetch } = mockFetch({
      '/api/apps/expenses': () => jsonResponse(appDetail),
      [releases]: () => jsonResponse({ items: [release()] }),
    })
    const { ctx } = await testContext({ store: await store(), fetch })
    const error = await captureError(runReleasesPromote(ctx, 'expenses', '9.9.9'))
    expect(error.message).toBe('No release 9.9.9 on this app')
  })
})

describe('releases retry / cancel', () => {
  const stuck = () =>
    release({ status: 'failed', error: 'staging: refused', failedStage: 'staging_deploy' })
  const retried = () =>
    jsonResponse(
      {
        release: release({ status: 'staging' }),
        stage: 'staging_deploy',
        action: 'rerun',
        attempt: 2,
        runUrl: 'https://github.com/acme/expenses/actions/runs/77',
        approvalId: null,
        health: null,
      },
      202
    )

  it('retries the stage the release is stuck at and says what it did; --json is the raw body', async () => {
    const { fetch, calls } = mockFetch({
      '/api/apps/expenses': () => jsonResponse(appDetail),
      [releases]: () => jsonResponse({ items: [stuck()] }),
      [`${releases}/${RELEASE_ID}/retry`]: retried,
    })
    const { ctx, out } = await testContext({ store: await store(), fetch })
    await runReleasesRetry(ctx, 'expenses', '1.4.0')
    expect(calls[2]?.url.pathname).toBe(`${releases}/${RELEASE_ID}/retry`)
    expect(JSON.parse(String(calls[2]?.init.body))).toEqual({ stage: 'staging_deploy' })
    expect(out.content()).toContain(
      'Retry staging deploy: re-running the failed jobs on GitHub (attempt 2)'
    )

    const json = await testContext({ store: await store(), fetch, json: true })
    await runReleasesRetry(json.ctx, 'expenses', '1.4.0')
    const body = JSON.parse(json.out.content())
    expect(body).toMatchObject({ stage: 'staging_deploy', action: 'rerun', attempt: 2 })
  })

  it('a release with nothing failing exits 1 without posting', async () => {
    const { fetch, calls } = mockFetch({
      '/api/apps/expenses': () => jsonResponse(appDetail),
      [releases]: () => jsonResponse({ items: [release()] }),
    })
    const { ctx } = await testContext({ store: await store(), fetch })
    const error = await captureError(runReleasesRetry(ctx, 'expenses', '1.4.0'))
    expect(exitCodeFor(error)).toBe(EXIT_ERROR)
    expect(error.message).toMatch(/nothing about it is failing/)
    expect(calls.some(c => c.url.pathname.endsWith('/retry'))).toBe(false)
  })

  it('cancels the run in flight and points at retry', async () => {
    const { fetch, calls } = mockFetch({
      '/api/apps/expenses': () => jsonResponse(appDetail),
      [releases]: () => jsonResponse({ items: [release({ status: 'staging' })] }),
      [`${releases}/${RELEASE_ID}/cancel`]: () =>
        jsonResponse(
          {
            release: stuck(),
            runUrl: 'https://github.com/acme/expenses/actions/runs/77',
          },
          202
        ),
    })
    const { ctx, out } = await testContext({ store: await store(), fetch })
    await runReleasesCancel(ctx, 'expenses', '1.4.0')
    expect(calls[2]?.init.method).toBe('POST')
    expect(out.content()).toContain('Cancelled the deploy run of 1.4.0')
    expect(out.content()).toContain('releases retry expenses 1.4.0')
  })
})
