/**
 * Organisation administration from the CLI (issue #6): members, invites, keys, groups (writes),
 * tenant + me, approval policies, approvals count/withdraw, app access, feedback votes, files and
 * the unread count — each against a fake server: `--json` reads, the body a write sends, the
 * confirmation a destructive write asks for (refused without `--yes` and no terminal), 403 → exit
 * 3, 404/409 → exit 1.
 */
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_APPROVAL_POLICIES } from '@launch/shared/launch-approvals'
import { afterEach, describe, expect, it } from 'vitest'
import {
  runAccessCheck,
  runAccessGrant,
  runAccessGrants,
  runAccessPolicy,
  runAccessRequest,
  runAccessRequests,
  runAccessUngrant,
} from '../src/commands/access'
import { runApprovalsCount, runApprovalsWithdraw } from '../src/commands/approvals'
import { runFeedbackGive, runFeedbackMine, runFeedbackRemove } from '../src/commands/feedback'
import { mimeFor, runFilesGet, runFilesPut, runFilesRemove } from '../src/commands/files'
import {
  describeInUse,
  runGroupsAdd,
  runGroupsCreate,
  runGroupsMine,
  runGroupsRemove,
  runGroupsRemoveMember,
  runGroupsSet,
  runGroupTypesCreate,
  runGroupTypesList,
  runGroupTypesRemove,
  runGroupTypesSet,
} from '../src/commands/groups-write'
import { expiresAtFrom, runKeysCreate, runKeysList, runKeysRevoke } from '../src/commands/keys'
import {
  runInvitesList,
  runInvitesPending,
  runInvitesResend,
  runInvitesRevoke,
  runInvitesSend,
  runMembersGroups,
  runMembersList,
  runMembersRemove,
  runMembersSetRole,
} from '../src/commands/members'
import { runNotificationsCount } from '../src/commands/notifications'
import {
  expiresMinutes,
  runPoliciesList,
  runPoliciesRemove,
  runPoliciesSet,
} from '../src/commands/policies'
import {
  pairsToObject,
  runMePrefs,
  runMePrefsSet,
  runMeSet,
  runMeShow,
  runTenantSet,
  runTenantSettingsSet,
  runTenantSettingsShow,
  runTenantShow,
  runTenantsList,
} from '../src/commands/tenant'
import { readDataObject } from '../src/utils/input'
import { captureError, jsonResponse, mockFetch, TENANT_ID, testContext } from './helpers'
import { APP_ID, APPROVAL_ID, appDetail, at, detail, loggedInStore } from './p4-fixtures'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(fn => fn()))
})
const store = () => loggedInStore(cleanups)

const ANA = 'a0a00000-0000-4000-8000-000000000001'
const BEN = 'b0b00000-0000-4000-8000-000000000002'
const GROUP = 'c0c00000-0000-4000-8000-000000000003'
const GROUP2 = 'c0c00000-0000-4000-8000-000000000004'
const TYPE = 'd0d00000-0000-4000-8000-000000000005'
const INVITE = 'e0e00000-0000-4000-8000-000000000006'
const KEY = 'f0f00000-0000-4000-8000-000000000007'
const POLICY = '90900000-0000-4000-8000-000000000008'
const GRANT = '80800000-0000-4000-8000-000000000009'
const FILE = '70700000-0000-4000-8000-00000000000a'
const MSG = '60600000-0000-4000-8000-00000000000b'

const pagination = (n: number) => ({ page: 1, pageSize: 200, total: n, totalPages: 1 })
const ref = (id: string, name: string) => ({ id, name, typeName: 'Department' })
const member = (userId: string, email: string, groups = [ref(GROUP, 'Finance')]) => ({
  userId,
  email,
  name: email.split('@')[0],
  avatarUrl: null,
  role: 'member',
  joinedAt: at,
  lastLoginAt: null,
  invitedByUserId: null,
  groups,
})
const members = () =>
  jsonResponse({
    items: [member(ANA, 'ana@acme.test'), member(BEN, 'ben@acme.test', [])],
    pagination: pagination(2),
  })
const group = (id = GROUP, name = 'Finance', memberCount = 1) => ({
  id,
  tenantId: TENANT_ID,
  groupTypeId: TYPE,
  typeName: 'Department',
  name,
  description: null,
  memberCount,
  createdAt: at,
  updatedAt: at,
})
const groupType = {
  id: TYPE,
  tenantId: TENANT_ID,
  name: 'Department',
  description: null,
  groupCount: 2,
  createdAt: at,
  updatedAt: at,
}
const groupDetail = () => ({
  ...group(),
  members: [{ userId: ANA, email: 'ana@acme.test', name: 'ana', avatarUrl: null, addedAt: at }],
})
const invitation = {
  id: INVITE,
  tenantId: TENANT_ID,
  email: 'cy@acme.test',
  role: 'member',
  status: 'pending',
  invitedByUserId: ANA,
  invitedByName: 'Ana',
  expiresAt: at,
  acceptedAt: null,
  revokedAt: null,
  createdAt: at,
}
const apiKey = {
  id: KEY,
  name: 'ci',
  keyPrefix: 'launch_zz99',
  scopes: ['read', 'write'],
  scope: 'tenant',
  createdByUserId: ANA,
  lastUsedAt: null,
  expiresAt: null,
  revokedAt: null,
  createdAt: at,
}
const forbidden = () => jsonResponse({ error: 'Forbidden', statusCode: 403 }, 403)
const notFound = () => jsonResponse({ error: 'Not found', statusCode: 404, code: 'not_found' }, 404)
const body = (calls: { init: RequestInit }[], i: number) =>
  JSON.parse(String(calls[i]?.init.body ?? 'null'))
const methodsOf = (calls: { url: URL; init: RequestInit }[]) =>
  calls.map(c => `${c.init.method} ${c.url.pathname}${c.url.search}`)
const no = async () => false
const yes = async () => true

const groupsServer = (extra: Parameters<typeof mockFetch>[0] = {}) =>
  mockFetch({
    '/api/members': members,
    '/api/groups': () => jsonResponse({ items: [group(), group(GROUP2, 'Legal', 0)] }),
    '/api/groups/types': () => jsonResponse({ items: [groupType] }),
    [`/api/groups/${GROUP}`]: () => jsonResponse(groupDetail()),
    ...extra,
  })

describe('members', () => {
  it('ls --json prints the page', async () => {
    const { fetch } = mockFetch({ '/api/members': members })
    const { ctx, out } = await testContext({ store: await store(), fetch, json: true })
    await runMembersList(ctx)
    expect(JSON.parse(out.content()).items).toHaveLength(2)
  })

  it('set-role finds the member by email and PATCHes the role', async () => {
    const { fetch, calls } = mockFetch({
      '/api/members': members,
      [`/api/members/${BEN}`]: () => jsonResponse({ userId: BEN, role: 'admin' }),
    })
    const { ctx, out } = await testContext({ store: await store(), fetch })
    await runMembersSetRole(ctx, 'ben@acme.test', 'admin')
    expect(calls[1]?.init.method).toBe('PATCH')
    expect(body(calls, 1)).toEqual({ role: 'admin' })
    expect(out.content()).toContain('is now admin')
  })

  it('set-role refuses an unknown role before any request', async () => {
    const { fetch, calls } = mockFetch({})
    const { ctx } = await testContext({ store: await store(), fetch })
    const error = await captureError(runMembersSetRole(ctx, ANA, 'support'))
    expect(error.exitCode).toBe(1)
    expect(error.message).toContain('role')
    expect(calls).toHaveLength(0)
  })

  it('rm refuses without --yes and no terminal, and sends nothing', async () => {
    const { fetch, calls } = mockFetch({ '/api/members': members })
    const { ctx } = await testContext({ store: await store(), fetch })
    const error = await captureError(runMembersRemove(ctx, ANA, {}))
    expect(error.exitCode).toBe(1)
    expect(calls.every(c => c.init.method === 'GET')).toBe(true)
  })

  it('rm states the consequence, and a "no" changes nothing', async () => {
    const { fetch, calls } = mockFetch({ '/api/members': members })
    const { ctx, log } = await testContext({ store: await store(), fetch })
    let asked = ''
    await runMembersRemove(ctx, 'ana@acme.test', {
      confirm: async q => {
        asked = q
        return false
      },
    })
    expect(asked).toContain('Remove ana <ana@acme.test>')
    expect(log.lines.join('\n')).toContain('They lose access immediately.')
    expect(calls.some(c => c.init.method === 'DELETE')).toBe(false)
  })

  it('rm --yes DELETEs; a 403 exits 3', async () => {
    const { fetch, calls } = mockFetch({
      '/api/members': members,
      [`/api/members/${ANA}`]: () => new Response(null, { status: 204 }),
    })
    const { ctx } = await testContext({ store: await store(), fetch })
    await runMembersRemove(ctx, ANA, { yes: true })
    expect(methodsOf(calls)).toContain(`DELETE /api/members/${ANA}`)

    const denied = mockFetch({ '/api/members': members, [`/api/members/${ANA}`]: forbidden })
    const d = await testContext({ store: await store(), fetch: denied.fetch })
    expect((await captureError(runMembersRemove(d.ctx, ANA, { yes: true }))).exitCode).toBe(3)
  })

  it('groups replaces wholesale and asks before taking a group away', async () => {
    const { fetch, calls } = groupsServer({
      [`/api/members/${ANA}/groups`]: () => jsonResponse({ items: [ref(GROUP2, 'Legal')] }),
    })
    const { ctx } = await testContext({ store: await store(), fetch })
    const refused = await captureError(runMembersGroups(ctx, ANA, ['Legal']))
    expect(refused.exitCode).toBe(1)
    await runMembersGroups(ctx, ANA, ['Legal'], { confirm: yes })
    const put = calls.findIndex(c => c.init.method === 'PUT')
    expect(body(calls, put)).toEqual({ groupIds: [GROUP2] })
  })

  it('groups that only adds does not ask', async () => {
    const { fetch, calls } = groupsServer({
      [`/api/members/${BEN}/groups`]: () => jsonResponse({ items: [ref(GROUP, 'Finance')] }),
    })
    const { ctx } = await testContext({ store: await store(), fetch })
    await runMembersGroups(ctx, BEN, ['Finance'])
    expect(calls.some(c => c.init.method === 'PUT')).toBe(true)
  })

  it('an unknown member is exit 1 with the list hint', async () => {
    const { fetch } = mockFetch({ '/api/members': members })
    const { ctx } = await testContext({ store: await store(), fetch })
    const error = await captureError(runMembersSetRole(ctx, 'zed@acme.test', 'admin'))
    expect(error.exitCode).toBe(1)
    expect(error.hint).toContain('members ls')
  })
})

describe('invites', () => {
  const invites = () => jsonResponse({ items: [invitation], pagination: pagination(1) })

  it('ls and pending --json', async () => {
    const { fetch } = mockFetch({
      '/api/invitations': invites,
      '/api/invitations/pending': () =>
        jsonResponse({ items: [{ ...invitation, tenantName: 'Acme' }] }),
    })
    const a = await testContext({ store: await store(), fetch, json: true })
    await runInvitesList(a.ctx)
    expect(JSON.parse(a.out.content()).items[0].id).toBe(INVITE)
    const b = await testContext({ store: await store(), fetch, json: true })
    await runInvitesPending(b.ctx)
    expect(JSON.parse(b.out.content()).items[0].tenantName).toBe('Acme')
  })

  it('send: one address → POST /api/invitations; several → /bulk', async () => {
    const { fetch, calls } = mockFetch({
      '/api/invitations': () => jsonResponse(invitation, 201),
      '/api/invitations/bulk': () =>
        jsonResponse({
          results: [
            { email: 'a@acme.test', status: 'invited' },
            { email: 'b@acme.test', status: 'skipped', reason: 'already a member' },
          ],
        }),
    })
    const { ctx, out } = await testContext({ store: await store(), fetch })
    await runInvitesSend(ctx, ['Cy@Acme.test'], { role: 'admin' })
    expect(body(calls, 0)).toEqual({ email: 'cy@acme.test', role: 'admin' })
    await runInvitesSend(ctx, ['a@acme.test', 'b@acme.test'])
    expect(calls[1]?.url.pathname).toBe('/api/invitations/bulk')
    expect(body(calls, 1)).toEqual({ emails: ['a@acme.test', 'b@acme.test'], role: 'member' })
    expect(out.content()).toContain('already a member')
  })

  it('send refuses a bad address before any request', async () => {
    const { fetch, calls } = mockFetch({})
    const { ctx } = await testContext({ store: await store(), fetch })
    const error = await captureError(runInvitesSend(ctx, ['not-an-email']))
    expect(error.exitCode).toBe(1)
    expect(error.message).toContain('email')
    expect(calls).toHaveLength(0)
  })

  it('resend by email; a 409 is exit 1', async () => {
    const { fetch, calls } = mockFetch({
      '/api/invitations': invites,
      [`/api/invitations/${INVITE}/resend`]: () => jsonResponse(invitation),
    })
    const { ctx } = await testContext({ store: await store(), fetch })
    await runInvitesResend(ctx, 'cy@acme.test')
    expect(methodsOf(calls)).toContain(`POST /api/invitations/${INVITE}/resend`)

    const conflict = mockFetch({
      '/api/invitations': invites,
      [`/api/invitations/${INVITE}/resend`]: () =>
        jsonResponse({ error: 'Already accepted', statusCode: 409, code: 'conflict' }, 409),
    })
    const c = await testContext({ store: await store(), fetch: conflict.fetch })
    expect((await captureError(runInvitesResend(c.ctx, INVITE))).exitCode).toBe(1)
  })

  it('revoke asks; --yes DELETEs', async () => {
    const { fetch, calls } = mockFetch({
      '/api/invitations': invites,
      [`/api/invitations/${INVITE}`]: () => new Response(null, { status: 204 }),
    })
    const { ctx } = await testContext({ store: await store(), fetch })
    expect((await captureError(runInvitesRevoke(ctx, INVITE.slice(0, 8), {}))).exitCode).toBe(1)
    await runInvitesRevoke(ctx, INVITE.slice(0, 8), { yes: true })
    expect(methodsOf(calls)).toContain(`DELETE /api/invitations/${INVITE}`)
  })
})

describe('keys', () => {
  const keys = () => jsonResponse({ items: [apiKey], pagination: pagination(1) })

  it('ls shows prefixes only; --json is the page', async () => {
    const { fetch } = mockFetch({ '/api/keys': keys })
    const human = await testContext({ store: await store(), fetch })
    await runKeysList(human.ctx)
    expect(human.out.content()).toContain('launch_zz99…')
    const json = await testContext({ store: await store(), fetch, json: true })
    await runKeysList(json.ctx)
    expect(JSON.parse(json.out.content()).items[0].keyPrefix).toBe('launch_zz99')
  })

  it('create prints the key once to stdout and warns on stderr', async () => {
    const { fetch, calls } = mockFetch({
      '/api/keys': () => jsonResponse({ ...apiKey, key: 'launch_zz99_fullsecret' }, 201),
    })
    const { ctx, out, log } = await testContext({ store: await store(), fetch })
    await runKeysCreate(ctx, 'ci', { scopes: 'read', expires: '30d' })
    const sent = body(calls, 0)
    expect(sent.name).toBe('ci')
    expect(sent.scopes).toEqual(['read'])
    expect(typeof sent.expiresAt).toBe('string')
    expect(out.content().trim()).toBe('launch_zz99_fullsecret')
    expect(log.lines.join('\n')).toContain('only time it will be shown')
    expect(log.lines.join('\n')).not.toContain('fullsecret')
  })

  it('create refuses a bad scope before any request', async () => {
    const { fetch, calls } = mockFetch({})
    const { ctx } = await testContext({ store: await store(), fetch })
    expect((await captureError(runKeysCreate(ctx, 'ci', { scopes: 'admin' }))).exitCode).toBe(1)
    expect(calls).toHaveLength(0)
    expect(() => expiresAtFrom('soon')).toThrow()
  })

  it('revoke asks; --yes DELETEs; a 403 exits 3', async () => {
    const { fetch, calls } = mockFetch({
      '/api/keys': keys,
      [`/api/keys/${KEY}`]: () => new Response(null, { status: 204 }),
    })
    const { ctx } = await testContext({ store: await store(), fetch })
    expect((await captureError(runKeysRevoke(ctx, 'ci', {}))).exitCode).toBe(1)
    await runKeysRevoke(ctx, 'ci', { yes: true })
    expect(methodsOf(calls)).toContain(`DELETE /api/keys/${KEY}`)

    const denied = mockFetch({ '/api/keys': forbidden })
    const d = await testContext({ store: await store(), fetch: denied.fetch })
    expect((await captureError(runKeysRevoke(d.ctx, 'ci', { yes: true }))).exitCode).toBe(3)
  })
})

describe('groups (writes)', () => {
  it('mine and types ls --json', async () => {
    const { fetch } = groupsServer({
      '/api/groups/mine': () => jsonResponse({ items: [ref(GROUP, 'Finance')] }),
    })
    const a = await testContext({ store: await store(), fetch, json: true })
    await runGroupsMine(a.ctx)
    expect(JSON.parse(a.out.content()).items[0].id).toBe(GROUP)
    const b = await testContext({ store: await store(), fetch, json: true })
    await runGroupTypesList(b.ctx)
    expect(JSON.parse(b.out.content()).items[0].id).toBe(TYPE)
  })

  it('create resolves the type by name; set PATCHes; types create/set send their bodies', async () => {
    const { fetch, calls } = mockFetch({
      '/api/groups': () => jsonResponse(group(), 201),
      '/api/groups/types': (_u, init) =>
        init.method === 'POST'
          ? jsonResponse(groupType, 201)
          : jsonResponse({ items: [groupType] }),
      [`/api/groups/${GROUP}`]: () => jsonResponse(group()),
      [`/api/groups/types/${TYPE}`]: () => jsonResponse(groupType),
    })
    const { ctx } = await testContext({ store: await store(), fetch })
    await runGroupsCreate(ctx, 'Finance', { type: 'department' })
    expect(body(calls, 1)).toEqual({ groupTypeId: TYPE, name: 'Finance' })

    calls.length = 0
    const listing = mockFetch({
      '/api/groups': () => jsonResponse({ items: [group()] }),
      [`/api/groups/${GROUP}`]: () => jsonResponse(group()),
      '/api/groups/types': () => jsonResponse({ items: [groupType] }),
      [`/api/groups/types/${TYPE}`]: () => jsonResponse(groupType),
    })
    const l = await testContext({ store: await store(), fetch: listing.fetch })
    await runGroupsSet(l.ctx, 'Finance', { description: '' })
    expect(listing.calls[1]?.init.method).toBe('PATCH')
    expect(body(listing.calls, 1)).toEqual({ description: null })
    await runGroupTypesSet(l.ctx, TYPE, { name: 'Dept' })
    expect(body(listing.calls, 3)).toEqual({ name: 'Dept' })

    const t = mockFetch({ '/api/groups/types': () => jsonResponse(groupType, 201) })
    const tc = await testContext({ store: await store(), fetch: t.fetch })
    await runGroupTypesCreate(tc.ctx, 'Department', { description: 'Who you report to' })
    expect(body(t.calls, 0)).toEqual({ name: 'Department', description: 'Who you report to' })
  })

  it('set with nothing to change is refused before the PATCH', async () => {
    const { fetch, calls } = groupsServer()
    const { ctx } = await testContext({ store: await store(), fetch })
    expect((await captureError(runGroupsSet(ctx, 'Finance', {}))).exitCode).toBe(1)
    expect(calls.some(c => c.init.method === 'PATCH')).toBe(false)
  })

  it('rm names who loses access and refuses without --yes', async () => {
    const { fetch, calls } = groupsServer()
    const { ctx, log } = await testContext({ store: await store(), fetch })
    const error = await captureError(runGroupsRemove(ctx, 'Finance'))
    expect(error.exitCode).toBe(1)
    expect(log.lines.join('\n')).toContain(
      'Its 1 member (ana@acme.test) lose what it lets them see'
    )
    expect(calls.some(c => c.init.method === 'DELETE')).toBe(false)
  })

  it('rm: a 409 group_in_use is the page sentence, exit 1 without --force', async () => {
    const inUse = () =>
      jsonResponse(
        {
          error: 'in use',
          statusCode: 409,
          code: 'group_in_use',
          details: { documents: 3, dashboards: 1 },
        },
        409
      )
    const { fetch, calls } = groupsServer({
      [`/api/groups/${GROUP}`]: (_u, init) =>
        init.method === 'DELETE' ? inUse() : jsonResponse(groupDetail()),
    })
    const { ctx } = await testContext({ store: await store(), fetch })
    const error = await captureError(runGroupsRemove(ctx, 'Finance', { yes: true }))
    expect(error.exitCode).toBe(1)
    expect(error.message).toContain('still controls access to 3 documents and 1 dashboard')
    expect(error.hint).toContain('--force')
    expect(calls.filter(c => c.init.method === 'DELETE')).toHaveLength(1)
  })

  it('rm --force re-sends with ?force=1', async () => {
    const { fetch, calls } = groupsServer({
      [`/api/groups/${GROUP}`]: (url, init) =>
        init.method !== 'DELETE'
          ? jsonResponse(groupDetail())
          : url.searchParams.get('force') === '1'
            ? new Response(null, { status: 204 })
            : jsonResponse(
                {
                  error: 'in use',
                  statusCode: 409,
                  code: 'group_in_use',
                  details: { documents: 2 },
                },
                409
              ),
    })
    const { ctx } = await testContext({ store: await store(), fetch })
    await runGroupsRemove(ctx, GROUP, { yes: true, force: true })
    expect(methodsOf(calls).filter(m => m.startsWith('DELETE'))).toEqual([
      `DELETE /api/groups/${GROUP}`,
      `DELETE /api/groups/${GROUP}?force=1`,
    ])
    expect(describeInUse({ documents: 1, dashboards: 0 })).toBe('1 document and 0 dashboards')
  })

  it('types rm names its groups; add/remove members', async () => {
    const { fetch, calls } = groupsServer({
      [`/api/groups/types/${TYPE}`]: () => new Response(null, { status: 204 }),
      [`/api/groups/${GROUP}/members`]: () => jsonResponse(groupDetail()),
      [`/api/groups/${GROUP}/members/${ANA}`]: () => new Response(null, { status: 204 }),
    })
    const { ctx, log } = await testContext({ store: await store(), fetch })
    await runGroupTypesRemove(ctx, 'Department', { confirm: yes })
    expect(log.lines.join('\n')).toContain('Finance and Legal')
    expect(methodsOf(calls)).toContain(`DELETE /api/groups/types/${TYPE}`)

    await runGroupsAdd(ctx, 'Finance', ['ana@acme.test', ANA])
    const post = calls.findIndex(c => c.init.method === 'POST')
    expect(body(calls, post)).toEqual({ userIds: [ANA] })

    expect((await captureError(runGroupsRemoveMember(ctx, 'Finance', ANA))).exitCode).toBe(1)
    await runGroupsRemoveMember(ctx, 'Finance', ANA, { yes: true })
    expect(methodsOf(calls)).toContain(`DELETE /api/groups/${GROUP}/members/${ANA}`)
  })

  it('a 403 on the list is exit 3', async () => {
    const { fetch } = mockFetch({ '/api/groups': forbidden })
    const { ctx } = await testContext({ store: await store(), fetch })
    expect((await captureError(runGroupsRemove(ctx, 'Finance', { yes: true }))).exitCode).toBe(3)
  })
})

describe('tenant and me', () => {
  const tenant = {
    id: TENANT_ID,
    name: 'Acme',
    slug: 'acme',
    status: 'active',
    createdAt: at,
    updatedAt: at,
  }
  const settings = {
    tenantId: TENANT_ID,
    timezone: 'UTC',
    notificationsEnabled: true,
    settings: {},
    updatedAt: at,
  }
  const user = {
    id: ANA,
    email: 'ana@acme.test',
    name: 'Ana',
    avatarUrl: null,
    isGlobalAdmin: false,
    emailVerifiedAt: null,
    createdAt: at,
  }
  const prefs = { tenantId: TENANT_ID, userId: ANA, preferences: { theme: 'dark' }, updatedAt: at }

  it('reads: show, ls, settings, me, prefs (--json)', async () => {
    const { fetch } = mockFetch({
      '/api/tenant': () => jsonResponse(tenant),
      '/api/tenants': () =>
        jsonResponse([{ id: TENANT_ID, name: 'Acme', slug: 'acme', role: 'owner' }]),
      '/api/tenant/settings': () => jsonResponse(settings),
      '/api/me': () => jsonResponse({ ...user, preferences: {} }),
      '/api/me/preferences': () => jsonResponse(prefs),
    })
    for (const run of [
      runTenantShow,
      runTenantsList,
      runTenantSettingsShow,
      runMeShow,
      runMePrefs,
    ]) {
      const { ctx, out } = await testContext({ store: await store(), fetch, json: true })
      await run(ctx)
      expect(JSON.parse(out.content())).toBeTruthy()
    }
  })

  it('tenant set / settings set PATCH the validated body; nothing to change is exit 1', async () => {
    const { fetch, calls } = mockFetch({
      '/api/tenant': () => jsonResponse(tenant),
      '/api/tenant/settings': () => jsonResponse(settings),
    })
    const { ctx } = await testContext({ store: await store(), fetch })
    await runTenantSet(ctx, { name: 'Acme Ltd' })
    expect(calls[0]?.init.method).toBe('PATCH')
    expect(body(calls, 0)).toEqual({ name: 'Acme Ltd' })
    await runTenantSettingsSet(ctx, {
      timezone: 'Europe/London',
      notifications: 'off',
      data: '{"settings":{"brand":"blue"}}',
    })
    expect(body(calls, 1)).toEqual({
      settings: { brand: 'blue' },
      timezone: 'Europe/London',
      notificationsEnabled: false,
    })
    expect((await captureError(runTenantSet(ctx, {}))).exitCode).toBe(1)
    expect((await captureError(runTenantSettingsSet(ctx, {}))).exitCode).toBe(1)
    expect(calls).toHaveLength(2)
  })

  it('--data that is not valid for the contract lists the issues and sends nothing', async () => {
    const { fetch, calls } = mockFetch({})
    const { ctx } = await testContext({ store: await store(), fetch })
    const error = await captureError(
      runTenantSettingsSet(ctx, { data: '{"notificationsEnabled":"yes"}' })
    )
    expect(error.exitCode).toBe(1)
    expect(error.message).toContain('notificationsEnabled')
    expect(calls).toHaveLength(0)
    expect((await captureError(runTenantSettingsSet(ctx, { data: '{oops' }))).exitCode).toBe(1)
  })

  it('tenant set and me set take --data, validated, the flags overriding it', async () => {
    const { fetch, calls } = mockFetch({
      '/api/tenant': () => jsonResponse(tenant),
      '/api/me': () => jsonResponse(user),
    })
    const { ctx } = await testContext({ store: await store(), fetch })
    await runTenantSet(ctx, { data: '{"name":"From data","slug":"acme"}', name: 'Flag' })
    expect(body(calls, 0)).toEqual({ name: 'Flag', slug: 'acme' })
    await runMeSet(ctx, { data: '-', readStdin: async () => '{"name":"Ana C"}' })
    expect(body(calls, 1)).toEqual({ name: 'Ana C' })
    const bad = await captureError(runMeSet(ctx, { data: '{"name":7}' }))
    expect(bad.exitCode).toBe(1)
    expect(bad.message).toContain('name')
    expect(calls).toHaveLength(2)
  })

  it('a 403 on tenant set exits 3', async () => {
    const { fetch } = mockFetch({ '/api/tenant': forbidden })
    const { ctx } = await testContext({ store: await store(), fetch })
    expect((await captureError(runTenantSet(ctx, { slug: 'acme-2' }))).exitCode).toBe(3)
  })

  it('me set and prefs set', async () => {
    const { fetch, calls } = mockFetch({
      '/api/me': () => jsonResponse(user),
      '/api/me/preferences': () => jsonResponse(prefs),
    })
    const { ctx } = await testContext({ store: await store(), fetch })
    await runMeSet(ctx, { name: 'Ana B', avatarUrl: '' })
    expect(body(calls, 0)).toEqual({ name: 'Ana B', avatarUrl: null })
    await runMePrefsSet(ctx, ['theme=dark', 'compact=true'])
    expect(body(calls, 1)).toEqual({ preferences: { theme: 'dark', compact: true } })
    await runMePrefsSet(ctx, [], { data: '-', readStdin: async () => '{"preferences":{"a":1}}' })
    expect(body(calls, 2)).toEqual({ preferences: { a: 1 } })
    expect(pairsToObject(['n=3', 's=x=y'])).toEqual({ n: 3, s: 'x=y' })
  })

  it('readDataObject reads @file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'launch-data-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    await writeFile(join(dir, 'b.json'), '{"x":1}')
    expect(await readDataObject(`@${join(dir, 'b.json')}`)).toEqual({ x: 1 })
    await expect(readDataObject('[1]')).rejects.toThrow('object')
  })
})

describe('approval policies', () => {
  const row = {
    ...DEFAULT_APPROVAL_POLICIES['deploy.production'],
    id: POLICY,
    kind: 'deploy.production',
    scopeType: 'tenant',
    scopeId: null,
    updatedByUserId: ANA,
    createdAt: at,
    updatedAt: at,
  }
  const list = (items: unknown[] = [row]) =>
    jsonResponse({ items, defaults: DEFAULT_APPROVAL_POLICIES })

  it('ls --json is { items, defaults }', async () => {
    const { fetch } = mockFetch({ '/api/approval-policies': () => list() })
    const { ctx, out } = await testContext({ store: await store(), fetch, json: true })
    await runPoliciesList(ctx)
    const parsed = JSON.parse(out.content())
    expect(parsed.items[0].id).toBe(POLICY)
    expect(parsed.defaults['app.create']).toBeTruthy()
  })

  it('set edits one field on top of the existing row', async () => {
    const { fetch, calls } = mockFetch({
      '/api/approval-policies': (_u, init) =>
        init.method === 'PUT' ? jsonResponse({ ...row, minApprovals: 2 }) : list(),
    })
    const { ctx } = await testContext({ store: await store(), fetch })
    await runPoliciesSet(ctx, 'deploy.production', { min: 2, expires: '2d' })
    const put = body(calls, 1)
    expect(put).toMatchObject({
      kind: 'deploy.production',
      scopeType: 'tenant',
      scopeId: null,
      minApprovals: 2,
      expiresAfterMinutes: 2880,
      approvers: { appOwners: true, admins: true, groupIds: [], userIds: [] },
    })
    expect(expiresMinutes('never')).toBeNull()
  })

  it('set --app resolves the slug and starts from the default', async () => {
    const { fetch, calls } = mockFetch({
      '/api/apps/expenses': () => jsonResponse(appDetail),
      '/api/approval-policies': (_u, init) =>
        init.method === 'PUT'
          ? jsonResponse({ ...row, scopeType: 'app', scopeId: APP_ID })
          : list([]),
    })
    const { ctx } = await testContext({ store: await store(), fetch })
    await runPoliciesSet(ctx, 'deploy.production', { app: 'expenses', admins: false })
    const put = body(calls, calls.length - 1)
    expect(put.scopeType).toBe('app')
    expect(put.scopeId).toBe(APP_ID)
    expect(put.approvers.admins).toBe(false)
  })

  it('auto-approving members asks first; an unknown kind or bad body sends nothing', async () => {
    const { fetch, calls } = mockFetch({ '/api/approval-policies': () => list() })
    const { ctx } = await testContext({ store: await store(), fetch })
    expect(
      (await captureError(runPoliciesSet(ctx, 'deploy.production', { autoApprove: 'member' })))
        .exitCode
    ).toBe(1)
    await runPoliciesSet(ctx, 'deploy.production', { autoApprove: 'member', confirm: no })
    expect(calls.some(c => c.init.method === 'PUT')).toBe(false)
    expect((await captureError(runPoliciesSet(ctx, 'nope', {}))).exitCode).toBe(1)
    expect(
      (await captureError(runPoliciesSet(ctx, 'deploy.production', { min: 99 }))).exitCode
    ).toBe(1)
    expect(calls.some(c => c.init.method === 'PUT')).toBe(false)
  })

  it('rm asks; --yes DELETEs; a 404 is exit 1', async () => {
    const { fetch, calls } = mockFetch({
      '/api/approval-policies': () => list(),
      [`/api/approval-policies/${POLICY}`]: () => new Response(null, { status: 204 }),
    })
    const { ctx, log } = await testContext({ store: await store(), fetch })
    expect((await captureError(runPoliciesRemove(ctx, POLICY.slice(0, 8), {}))).exitCode).toBe(1)
    expect(log.lines.join('\n')).toContain('Launch’s default')
    await runPoliciesRemove(ctx, POLICY, { yes: true })
    expect(methodsOf(calls)).toContain(`DELETE /api/approval-policies/${POLICY}`)

    const gone = mockFetch({
      '/api/approval-policies': () => list(),
      [`/api/approval-policies/${POLICY}`]: notFound,
    })
    const g = await testContext({ store: await store(), fetch: gone.fetch })
    expect((await captureError(runPoliciesRemove(g.ctx, POLICY, { yes: true }))).exitCode).toBe(1)
  })
})

describe('approvals count / withdraw', () => {
  it('count --json', async () => {
    const { fetch } = mockFetch({ '/api/approvals/count': () => jsonResponse({ count: 2 }) })
    const { ctx, out } = await testContext({ store: await store(), fetch, json: true })
    await runApprovalsCount(ctx)
    expect(JSON.parse(out.content())).toEqual({ count: 2 })
  })

  it('withdraw asks, then POSTs /cancel with the reason; a 409 is exit 1', async () => {
    const { fetch, calls } = mockFetch({
      [`/api/approvals/${APPROVAL_ID}/cancel`]: () =>
        jsonResponse({ ...detail(), status: 'cancelled' }),
    })
    const { ctx } = await testContext({ store: await store(), fetch })
    expect((await captureError(runApprovalsWithdraw(ctx, APPROVAL_ID))).exitCode).toBe(1)
    expect(calls).toHaveLength(0)
    await runApprovalsWithdraw(ctx, APPROVAL_ID, { yes: true, reason: 'not needed' })
    expect(body(calls, 0)).toEqual({ reason: 'not needed' })

    const late = mockFetch({
      [`/api/approvals/${APPROVAL_ID}/cancel`]: () =>
        jsonResponse({ error: 'x', statusCode: 409, code: 'not_pending' }, 409),
    })
    const l = await testContext({ store: await store(), fetch: late.fetch })
    const error = await captureError(runApprovalsWithdraw(l.ctx, APPROVAL_ID, { yes: true }))
    expect(error.exitCode).toBe(1)
    expect(error.message).toContain('already been decided')
  })
})

describe('app access', () => {
  const app = { id: APP_ID, slug: 'expenses', displayName: 'Expenses' }
  const policy = (accessPolicy = 'restricted') => ({
    app,
    hasClient: true,
    clientId: 'cid',
    accessPolicy,
  })
  const grant = {
    id: GRANT,
    kind: 'group',
    groupId: GROUP,
    userId: null,
    name: 'Finance',
    email: null,
    createdAt: at,
  }

  it('check and request (the requester side)', async () => {
    const { fetch, calls } = mockFetch({
      '/api/app-access/request-context': () => jsonResponse({ app, standing: 'none' }),
      '/api/app-access/requests': () =>
        jsonResponse(
          {
            standing: 'pending',
            request: {
              id: APPROVAL_ID,
              appId: APP_ID,
              userId: ANA,
              userEmail: 'ana@acme.test',
              userName: 'Ana',
              message: 'pls',
              status: 'pending',
              decidedByUserId: null,
              decidedAt: null,
              createdAt: at,
            },
          },
          201
        ),
    })
    const { ctx, out } = await testContext({ store: await store(), fetch })
    await runAccessCheck(ctx, 'cid')
    expect(calls[0]?.url.searchParams.get('clientId')).toBe('cid')
    expect(out.content()).toContain('do not have access to Expenses')
    await runAccessRequest(ctx, 'cid', { message: 'pls' })
    expect(body(calls, 1)).toEqual({ clientId: 'cid', message: 'pls' })
  })

  it('policy read --json; restricting asks; --yes PUTs', async () => {
    const { fetch, calls } = mockFetch({
      '/api/app-access/expenses/policy': (_u, init) =>
        init.method === 'PUT' ? jsonResponse(policy()) : jsonResponse(policy('company')),
      '/api/app-access/expenses/grants': () => jsonResponse({ items: [grant] }),
    })
    const json = await testContext({ store: await store(), fetch, json: true })
    await runAccessPolicy(json.ctx, 'expenses', undefined)
    expect(JSON.parse(json.out.content()).accessPolicy).toBe('company')

    const { ctx } = await testContext({ store: await store(), fetch })
    expect((await captureError(runAccessPolicy(ctx, 'expenses', 'restricted'))).exitCode).toBe(1)
    await runAccessPolicy(ctx, 'expenses', 'restricted', { yes: true })
    const put = calls.findIndex(c => c.init.method === 'PUT')
    expect(body(calls, put)).toEqual({ accessPolicy: 'restricted' })
    expect((await captureError(runAccessPolicy(ctx, 'expenses', 'open'))).exitCode).toBe(1)
  })

  it('grants, grant (by group name), requests; a 409 oidc_client_missing is exit 1', async () => {
    const { fetch, calls } = mockFetch({
      '/api/groups': () => jsonResponse({ items: [group()] }),
      '/api/app-access/expenses/grants': (_u, init) =>
        jsonResponse({ items: [grant] }, init.method === 'POST' ? 201 : 200),
      '/api/app-access/expenses/requests': () => jsonResponse({ items: [] }),
    })
    const { ctx } = await testContext({ store: await store(), fetch })
    await runAccessGrants(ctx, 'expenses')
    await runAccessGrant(ctx, 'expenses', { group: 'Finance' })
    expect(body(calls, 2)).toEqual({ groupId: GROUP })
    expect((await captureError(runAccessGrant(ctx, 'expenses', {}))).exitCode).toBe(1)
    await runAccessRequests(ctx, 'expenses', { status: 'pending' })
    expect(calls.at(-1)?.url.searchParams.get('status')).toBe('pending')

    const missing = mockFetch({
      '/api/app-access/expenses/grants': () =>
        jsonResponse({ error: 'no client', statusCode: 409, code: 'oidc_client_missing' }, 409),
    })
    const m = await testContext({ store: await store(), fetch: missing.fetch })
    expect(
      (await captureError(runAccessGrant(m.ctx, 'expenses', { email: 'a@acme.test' }))).exitCode
    ).toBe(1)
  })

  it('ungrant states who can no longer sign in; --yes DELETEs; 403 exits 3', async () => {
    const { fetch, calls } = mockFetch({
      '/api/app-access/expenses/grants': () => jsonResponse({ items: [grant] }),
      '/api/app-access/expenses/policy': () => jsonResponse(policy()),
      [`/api/app-access/expenses/grants/${GRANT}`]: () => new Response(null, { status: 204 }),
    })
    const { ctx, log } = await testContext({ store: await store(), fetch })
    expect((await captureError(runAccessUngrant(ctx, 'expenses', 'Finance'))).exitCode).toBe(1)
    expect(log.lines.join('\n')).toContain(
      'The members of Finance can no longer sign in to Expenses'
    )
    await runAccessUngrant(ctx, 'expenses', 'Finance', { yes: true })
    expect(methodsOf(calls)).toContain(`DELETE /api/app-access/expenses/grants/${GRANT}`)

    const denied = mockFetch({
      '/api/app-access/expenses/grants': forbidden,
      '/api/app-access/expenses/policy': forbidden,
    })
    const d = await testContext({ store: await store(), fetch: denied.fetch })
    expect(
      (await captureError(runAccessUngrant(d.ctx, 'expenses', GRANT, { yes: true }))).exitCode
    ).toBe(3)
  })
})

describe('feedback votes', () => {
  const vote = {
    id: KEY,
    target: 'message',
    targetId: MSG,
    rating: -1,
    comment: 'wrong',
    userId: ANA,
    traceId: null,
    createdAt: at,
    updatedAt: at,
  }

  it('give sends the vote; rm withdraws; mine --json', async () => {
    const { fetch, calls } = mockFetch({
      '/api/feedback': () => jsonResponse(vote, 201),
      [`/api/feedback/agent_run/${MSG}`]: () => new Response(null, { status: 204 }),
      '/api/feedback/mine': () => jsonResponse({ items: [vote] }),
    })
    const { ctx } = await testContext({ store: await store(), fetch })
    await runFeedbackGive(ctx, MSG, 'down', { comment: 'wrong' })
    expect(body(calls, 0)).toEqual({
      target: 'message',
      targetId: MSG,
      rating: -1,
      comment: 'wrong',
    })
    await runFeedbackRemove(ctx, MSG, { run: true })
    expect(methodsOf(calls)).toContain(`DELETE /api/feedback/agent_run/${MSG}`)
    const json = await testContext({ store: await store(), fetch, json: true })
    await runFeedbackMine(json.ctx, [MSG])
    expect(JSON.parse(json.out.content()).items[0].rating).toBe(-1)
    expect(calls.at(-1)?.url.searchParams.get('targetIds')).toBe(MSG)
  })

  it('refuses a bad vote or id before any request; a 404 target is exit 1', async () => {
    const { fetch, calls } = mockFetch({ '/api/feedback': notFound })
    const { ctx } = await testContext({ store: await store(), fetch })
    expect((await captureError(runFeedbackGive(ctx, MSG, 'meh'))).exitCode).toBe(1)
    expect((await captureError(runFeedbackGive(ctx, 'nope', 'up'))).exitCode).toBe(1)
    expect(calls).toHaveLength(0)
    expect((await captureError(runFeedbackGive(ctx, MSG, 'up'))).exitCode).toBe(1)
  })
})

describe('files', () => {
  it('get streams into a 0600 file and refuses to overwrite without --force', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'launch-files-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const out = join(dir, 'a.png')
    const { fetch } = mockFetch({
      [`/api/files/${FILE}`]: () =>
        new Response('PNGDATA', { status: 200, headers: { 'Content-Type': 'image/png' } }),
    })
    const { ctx } = await testContext({ store: await store(), fetch })
    await runFilesGet(ctx, FILE, { out })
    expect(await readFile(out, 'utf8')).toBe('PNGDATA')
    expect((await stat(out)).mode & 0o777).toBe(0o600)
    const error = await captureError(runFilesGet(ctx, FILE, { out }))
    expect(error.exitCode).toBe(1)
    expect(error.hint).toContain('--force')
    await runFilesGet(ctx, FILE, { out, force: true })
  })

  it('rm asks; --yes DELETEs; 409 owned_by_document is exit 1; 403 exits 3', async () => {
    const { fetch, calls } = mockFetch({
      [`/api/files/${FILE}`]: () => new Response(null, { status: 204 }),
    })
    const { ctx } = await testContext({ store: await store(), fetch })
    expect((await captureError(runFilesRemove(ctx, FILE))).exitCode).toBe(1)
    expect(calls).toHaveLength(0)
    await runFilesRemove(ctx, FILE, { yes: true })
    expect(methodsOf(calls)).toEqual([`DELETE /api/files/${FILE}`])

    const owned = mockFetch({
      [`/api/files/${FILE}`]: () =>
        jsonResponse(
          { error: 'delete the document', statusCode: 409, code: 'owned_by_document' },
          409
        ),
    })
    const o = await testContext({ store: await store(), fetch: owned.fetch })
    expect((await captureError(runFilesRemove(o.ctx, FILE, { yes: true }))).exitCode).toBe(1)
    const denied = mockFetch({ [`/api/files/${FILE}`]: forbidden })
    const d = await testContext({ store: await store(), fetch: denied.fetch })
    expect((await captureError(runFilesRemove(d.ctx, FILE, { yes: true }))).exitCode).toBe(3)
    expect((await captureError(runFilesRemove(d.ctx, 'x', { yes: true }))).exitCode).toBe(1)
  })
})

describe('notifications count', () => {
  it('--json', async () => {
    const { fetch } = mockFetch({
      '/api/notifications/unread-count': () => jsonResponse({ count: 4 }),
    })
    const { ctx, out } = await testContext({ store: await store(), fetch, json: true })
    await runNotificationsCount(ctx)
    expect(JSON.parse(out.content())).toEqual({ count: 4 })
  })
})

describe('files put', () => {
  const stored = {
    id: FILE,
    tenantId: TENANT_ID,
    ownerUserId: ANA,
    scope: 'uploads',
    filename: 'notes.txt',
    contentType: 'text/plain',
    sizeBytes: 5,
    url: `/api/files/${FILE}`,
    createdAt: at,
  }

  it('sends multipart with the scope; refuses an empty file or a non-image avatar first', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'launch-put-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const path = join(dir, 'notes.txt')
    await writeFile(path, 'hello')
    const { fetch, calls } = mockFetch({ '/api/files': () => jsonResponse(stored, 201) })
    const { ctx, out } = await testContext({ store: await store(), fetch })
    await runFilesPut(ctx, path)
    const sent = calls[0]?.init.body
    expect(sent).toBeInstanceOf(FormData)
    const file = (sent as FormData).get('file') as File
    expect(file.name).toBe('notes.txt')
    expect(file.type).toBe('text/plain')
    expect(calls[0]?.url.searchParams.get('scope')).toBe('uploads')
    expect(out.content()).toContain(FILE)

    expect((await captureError(runFilesPut(ctx, path, { scope: 'avatars' }))).exitCode).toBe(1)
    await writeFile(join(dir, 'empty.png'), '')
    expect((await captureError(runFilesPut(ctx, join(dir, 'empty.png')))).exitCode).toBe(1)
    expect(calls).toHaveLength(1)
    expect(mimeFor('a.JPG')).toBe('image/jpeg')
  })

  it('a 403 exits 3; a 413 is exit 1', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'launch-put-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const path = join(dir, 'a.png')
    await writeFile(path, 'PNG')
    const denied = mockFetch({ '/api/files': forbidden })
    const d = await testContext({ store: await store(), fetch: denied.fetch })
    expect((await captureError(runFilesPut(d.ctx, path, { scope: 'avatars' }))).exitCode).toBe(3)
    const big = mockFetch({
      '/api/files': () =>
        jsonResponse({ error: 'too big', statusCode: 413, code: 'payload_too_large' }, 413),
    })
    const b = await testContext({ store: await store(), fetch: big.fetch })
    expect((await captureError(runFilesPut(b.ctx, path))).exitCode).toBe(1)
  })
})
