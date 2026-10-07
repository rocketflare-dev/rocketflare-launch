/**
 * `grants needs|ls|request|revoke` (Launch P5), in-process against a fake server: the app is
 * resolved by slug and the resource by slug; `request` sends one body for both environments by
 * default and prints each approval's page; `revoke` finds the grant by id prefix or by resource
 * slug + environment.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { describeApproval, runApprovalsShow } from '../src/commands/approvals'
import {
  findGrant,
  grantState,
  runGrantsList,
  runGrantsNeeds,
  runGrantsRequest,
  runGrantsRevoke,
} from '../src/commands/grants'
import { captureError, jsonResponse, mockFetch, testContext } from './helpers'
import { APP_ID, APPROVAL_ID, appDetail, detail, loggedInStore } from './p4-fixtures'
import { appConfig, GRANT_ID, GRANT_PROD_ID, grant, RESOURCE_ID, resource } from './p5-fixtures'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(fn => fn()))
})
const store = () => loggedInStore(cleanups)
const configPath = `/api/apps/${APP_ID}/config`
const grantsPath = `/api/apps/${APP_ID}/grants`

function server(extra: Record<string, Parameters<typeof mockFetch>[0][string]> = {}) {
  return mockFetch({
    '/api/apps/expenses': () => jsonResponse(appDetail),
    [configPath]: () => jsonResponse(appConfig()),
    '/api/shared-resources': () => jsonResponse({ items: [resource()] }),
    ...extra,
  })
}

describe('grants needs / ls', () => {
  it('shows each matched resource per environment and the keys nothing matches', async () => {
    const { fetch } = server({
      [configPath]: () => jsonResponse(appConfig({ needs: [RESOURCE_ID] })),
    })
    const { ctx, out } = await testContext({ store: await store(), fetch })
    await runGrantsNeeds(ctx, 'expenses')
    const text = out.content()
    expect(text).toContain('staging: held (v3)')
    expect(text).toContain('production: missing')
    expect(text).toContain('Keys no secret matches: STRIPE_KEY')
    expect(text).toContain('grants request expenses m365')
  })

  it('lists the grants; --json is { items }', async () => {
    const { fetch } = server()
    const json = await testContext({ store: await store(), fetch, json: true })
    await runGrantsList(json.ctx, 'expenses')
    expect(JSON.parse(json.out.content()).items[0].id).toBe(GRANT_ID)
  })

  it('words each state', () => {
    expect(grantState(null)).toBe('missing')
    expect(grantState({ status: 'active', pushedVersion: null, pushError: null })).toBe('pushing')
    expect(grantState({ status: 'active', pushedVersion: 2, pushError: 'boom' })).toBe(
      'push failed'
    )
    expect(grantState({ status: 'rejected', pushedVersion: null, pushError: null })).toBe(
      'missing (rejected)'
    )
  })
})

describe('grants request', () => {
  it('asks for both environments by default and prints each approval page', async () => {
    const { fetch, calls } = server({
      [grantsPath]: () =>
        jsonResponse(
          {
            grants: [
              {
                id: GRANT_ID,
                environment: 'staging',
                approvalId: APPROVAL_ID,
                status: 'requested',
              },
              { id: GRANT_PROD_ID, environment: 'production', approvalId: null, status: 'active' },
            ],
          },
          202
        ),
    })
    const { ctx, out } = await testContext({ store: await store(), fetch })
    await runGrantsRequest(ctx, 'expenses', 'm365', { reason: 'The M365 connector' })
    const post = calls.find(c => c.init.method === 'POST')
    expect(JSON.parse(String(post?.init.body))).toEqual({
      resourceId: RESOURCE_ID,
      environments: ['staging', 'production'],
      reason: 'The M365 connector',
    })
    expect(out.content()).toContain(
      `staging: requested — http://server.test/approvals/${APPROVAL_ID}`
    )
    expect(out.content()).toContain('production: active')
  })

  it('refuses without a reason, before any request', async () => {
    const { fetch, calls } = server()
    const { ctx } = await testContext({ store: await store(), fetch })
    const error = await captureError(runGrantsRequest(ctx, 'expenses', 'm365', { reason: ' ' }))
    expect(error.message).toContain('--reason')
    expect(calls.some(c => c.init.method === 'POST')).toBe(false)
  })

  it('a 409 from the server exits 1 with its message', async () => {
    const { fetch } = server({
      [grantsPath]: () =>
        jsonResponse({ error: 'Already held', statusCode: 409, code: 'grant_already_held' }, 409),
    })
    const { ctx } = await testContext({ store: await store(), fetch })
    const error = await captureError(
      runGrantsRequest(ctx, 'expenses', 'm365', { reason: 'x', env: ['staging'] })
    )
    expect(error.exitCode).toBe(1)
    expect(error.code).toBe('grant_already_held')
  })
})

describe('grants revoke', () => {
  it('finds the grant by resource slug and sends the reason', async () => {
    const { fetch, calls } = server({
      [`${grantsPath}/${GRANT_ID}`]: () =>
        jsonResponse({ grant: grant({ status: 'revoking' }), pushId: null }, 202),
    })
    const { ctx, out } = await testContext({ store: await store(), fetch })
    await runGrantsRevoke(ctx, 'expenses', 'm365', { reason: 'Not used any more', yes: true })
    const del = calls.find(c => c.init.method === 'DELETE')
    expect(del?.url.pathname).toBe(`${grantsPath}/${GRANT_ID}`)
    expect(JSON.parse(String(del?.init.body))).toEqual({ reason: 'Not used any more' })
    expect(out.content()).toContain('Revoking m365 on expenses (staging): revoking')
  })

  it('asks first with the page’s words; a no sends nothing, no terminal refuses', async () => {
    const { fetch, calls } = server({})
    const { ctx, log } = await testContext({ store: await store(), fetch })
    let question = ''
    await runGrantsRevoke(ctx, 'expenses', 'm365', {
      confirm: async q => {
        question = q
        return false
      },
    })
    expect(question).toBe('Revoke m365 on expenses (staging)?')
    expect(log.lines.join('\n')).toContain('answers “not configured” until it is granted again')
    expect(calls.some(c => c.init.method === 'DELETE')).toBe(false)
    const refused = await captureError(runGrantsRevoke(ctx, 'expenses', 'm365'))
    expect(refused.message).toMatch(/Refusing without confirmation/)
  })

  it('an id prefix works; a slug held in both environments needs --env', () => {
    const both = [grant(), grant({ id: GRANT_PROD_ID, environment: 'production' })] as never[]
    expect(findGrant(both, GRANT_PROD_ID.slice(0, 8)).id).toBe(GRANT_PROD_ID)
    expect(() => findGrant(both, 'm365')).toThrow('more than one environment')
    expect(findGrant(both, 'm365', 'production').id).toBe(GRANT_PROD_ID)
  })
})

describe('approvals show — a grant request', () => {
  const grantContext = {
    kind: 'grant.request',
    resourceId: RESOURCE_ID,
    resourceName: 'Microsoft 365',
    environment: 'production',
    items: [
      { key: 'M365_TENANT_ID', kind: 'var' },
      { key: 'M365_CLIENT_SECRET', kind: 'secret' },
    ],
    declaredBy: ['m365-connector'],
    appSlug: 'expenses',
    expiresAt: null,
  }

  it('names the items, who declared them and the owner team as the approvers', async () => {
    const approval = detail({
      kind: 'grant.request',
      subjectType: 'grant',
      subjectId: GRANT_ID,
      context: grantContext,
      policy: {
        approvers: { appOwners: false, admins: false, groupIds: [], userIds: [] },
        minApprovals: 1,
        allowSelfApproval: false,
        expiresAfterMinutes: 10080,
        autoApproveRole: null,
      },
    })
    const { fetch } = mockFetch({
      [`/api/approvals/${APPROVAL_ID}`]: () => jsonResponse(approval),
    })
    const { ctx, out } = await testContext({ store: await store(), fetch })
    await runApprovalsShow(ctx, APPROVAL_ID)
    const text = out.content()
    expect(text).toContain('Let Expenses hold Microsoft 365 in production.')
    expect(text).toContain('M365_CLIENT_SECRET (secret)')
    expect(text).toContain('Declared: m365-connector')
    expect(text).toContain("the resource's owner team")
    expect(text).not.toContain('nobody')
    expect(describeApproval(approval as never)).toContain('Microsoft 365')
  })
})
