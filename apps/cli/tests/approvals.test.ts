/**
 * `approvals ls|show|approve|reject` (Launch P4), in-process against a fake server: the boxes and
 * filters reach the query, `--app` resolves the slug, `show` says what is being approved and why
 * you may not decide, and a 409 on decide is a plain sentence (exit 1), not a raw envelope.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  describeApproval,
  runApprovalsDecide,
  runApprovalsList,
  runApprovalsShow,
} from '../src/commands/approvals'
import { EXIT_ERROR, EXIT_FORBIDDEN, exitCodeFor } from '../src/errors'
import { captureError, jsonResponse, mockFetch, testContext } from './helpers'
import {
  APP_ID,
  APPROVAL_ID,
  appDetail,
  BOB,
  detail,
  loggedInStore,
  request,
  SERVER,
} from './p4-fixtures'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(fn => fn()))
})
const store = () => loggedInStore(cleanups)

describe('approvals ls', () => {
  it('asks for "waiting on me" by default and renders a row', async () => {
    const { fetch, calls } = mockFetch({
      '/api/approvals': () => jsonResponse({ items: [request()] }),
    })
    const { ctx, out } = await testContext({ store: await store(), fetch })
    await runApprovalsList(ctx)
    expect(calls[0]?.url.searchParams.get('box')).toBe('mine')
    expect(out.content()).toContain('deploy.production')
    expect(out.content()).toContain('0/1')
    expect(out.content()).toContain('Alice')
    expect(out.content()).toContain(APPROVAL_ID.slice(0, 8))
  })

  it('passes box, status, kind and the resolved app id; --json is the raw body', async () => {
    const { fetch, calls } = mockFetch({
      '/api/apps/expenses': () => jsonResponse(appDetail),
      '/api/approvals': () => jsonResponse({ items: [request()] }),
    })
    const { ctx, out } = await testContext({ store: await store(), fetch, json: true })
    await runApprovalsList(ctx, {
      box: 'all',
      status: 'pending',
      kind: 'deploy.production',
      app: 'expenses',
    })
    const query = calls[1]?.url.searchParams
    expect(query?.get('box')).toBe('all')
    expect(query?.get('status')).toBe('pending')
    expect(query?.get('kind')).toBe('deploy.production')
    expect(query?.get('appId')).toBe(APP_ID)
    expect(JSON.parse(out.content()).items[0].id).toBe(APPROVAL_ID)
  })
})

describe('approvals show', () => {
  it('says what is being approved, the progress, the PRs and the page', async () => {
    const { fetch } = mockFetch({
      [`/api/approvals/${APPROVAL_ID}`]: () => jsonResponse(detail()),
    })
    const { ctx, out } = await testContext({ store: await store(), fetch })
    await runApprovalsShow(ctx, APPROVAL_ID)
    const text = out.content()
    expect(text).toContain('Deploy version 1.4.0 of Expenses to production.')
    expect(text).toContain('0 of 1 approval')
    expect(text).toContain('#12 Blue button')
    expect(text).toContain("the app's owners, the organisation's admins; not the requester")
    expect(text).toContain(`approvals approve ${APPROVAL_ID}`)
    expect(text).toContain(`${SERVER}/approvals/${APPROVAL_ID}`)
  })

  it('gives the reason a person may not decide instead of the commands', async () => {
    const { fetch } = mockFetch({
      [`/api/approvals/${APPROVAL_ID}`]: () =>
        jsonResponse(
          detail({
            canDecide: false,
            whyNot: 'self_approval',
            eligible: [
              { id: crypto.randomUUID(), name: 'Bob Owner', email: 'bob@example.test' },
              { id: crypto.randomUUID(), name: null, email: 'admin@example.test' },
            ],
          })
        ),
    })
    const { ctx, out } = await testContext({ store: await store(), fetch })
    await runApprovalsShow(ctx, APPROVAL_ID)
    expect(out.content()).toContain('someone else must decide')
    expect(out.content()).toContain('Waiting:  Bob Owner, admin@example.test')
    expect(out.content()).not.toContain('approvals approve')
  })

  it('says so when nobody can approve a pending request', async () => {
    const { fetch } = mockFetch({
      [`/api/approvals/${APPROVAL_ID}`]: () =>
        jsonResponse(detail({ canDecide: false, whyNot: 'not_an_approver', eligible: [] })),
    })
    const { ctx, out } = await testContext({ store: await store(), fetch })
    await runApprovalsShow(ctx, APPROVAL_ID)
    expect(out.content()).toContain('nobody can approve this')
  })

  it('resolves a short id from the list', async () => {
    const { fetch, calls } = mockFetch({
      '/api/approvals': () => jsonResponse({ items: [request()] }),
      [`/api/approvals/${APPROVAL_ID}`]: () => jsonResponse(detail()),
    })
    const { ctx, out } = await testContext({ store: await store(), fetch, json: true })
    await runApprovalsShow(ctx, APPROVAL_ID.slice(0, 8))
    expect(calls.at(-1)?.url.pathname).toBe(`/api/approvals/${APPROVAL_ID}`)
    expect(JSON.parse(out.content()).id).toBe(APPROVAL_ID)
  })

  it('describes every built kind in plain words', () => {
    const app = { id: APP_ID, slug: 'expenses', displayName: 'Expenses' }
    const base = request() as any
    expect(
      describeApproval({
        ...base,
        context: { kind: 'app.create', slug: 'crm', displayName: 'CRM', ownerGroupId: null },
      })
    ).toBe('Create the app "CRM" (crm).')
    expect(
      describeApproval({
        ...base,
        app,
        context: { kind: 'app.access', userId: BOB, message: null },
      })
    ).toBe('Let Alice sign in to Expenses.')
    expect(
      describeApproval({
        ...base,
        app,
        context: {
          kind: 'session.budget',
          sessionId: BOB,
          sessionTitle: 'Blue button',
          extraUsd: 10,
          spentUsd: 5,
          capUsd: 5,
        },
      })
    ).toBe('Add $10.00 to the session "Blue button" on Expenses (spent $5.00 of $5.00).')
  })
})

describe('approvals approve / reject', () => {
  it('posts the decision and the comment, and reports the new state', async () => {
    const { fetch, calls } = mockFetch({
      [`/api/approvals/${APPROVAL_ID}/decide`]: () =>
        jsonResponse(
          detail({
            status: 'approved',
            approvals: 1,
            canDecide: false,
            whyNot: 'not_pending',
            decidedAt: '2026-09-28T11:00:00.000Z',
          })
        ),
    })
    const { ctx, out } = await testContext({ store: await store(), fetch })
    await runApprovalsDecide(ctx, APPROVAL_ID, 'approve', { comment: ' looks good ' })
    expect(calls[0]?.init.method).toBe('POST')
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      decision: 'approve',
      comment: 'looks good',
    })
    expect(out.content()).toContain('Approved')
    expect(out.content()).toContain('now approved')
  })

  it('a 409 not_pending is a plain sentence and exit 1', async () => {
    const { fetch } = mockFetch({
      [`/api/approvals/${APPROVAL_ID}/decide`]: () =>
        jsonResponse({ error: 'Not pending', statusCode: 409, code: 'not_pending' }, 409),
    })
    const { ctx } = await testContext({ store: await store(), fetch })
    const error = await captureError(runApprovalsDecide(ctx, APPROVAL_ID, 'reject'))
    expect(exitCodeFor(error)).toBe(EXIT_ERROR)
    expect(error.message).toContain('already been decided')
    expect(error.hint).toContain(`approvals show ${APPROVAL_ID}`)
  })

  it('a 403 self_approval is exit 3', async () => {
    const { fetch } = mockFetch({
      [`/api/approvals/${APPROVAL_ID}/decide`]: () =>
        jsonResponse({ error: 'Not yours', statusCode: 403, code: 'self_approval' }, 403),
    })
    const { ctx } = await testContext({ store: await store(), fetch })
    const error = await captureError(runApprovalsDecide(ctx, APPROVAL_ID, 'approve'))
    expect(exitCodeFor(error)).toBe(EXIT_FORBIDDEN)
  })
})
