/**
 * Issue #6, in-process against a fake server: `deploys production|approve|reject`, `shared
 * create|edit|archive` and `agent-accounts ls|login|cancel|rm`. Bodies are the shared contracts'
 * (checked before any request), destructive commands refuse without `--yes`, a login is followed
 * to its end, a code is read hidden or from stdin and never printed, a 403 exits 3 and a 409 / 404
 * exits 1.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  claudeCodeProblem,
  runAgentAccountsCancel,
  runAgentAccountsList,
  runAgentAccountsLogin,
  runAgentAccountsRemove,
} from '../src/commands/agent-accounts'
import { runDeploysDecide, runDeploysProduction } from '../src/commands/deploys'
import { runSharedArchive, runSharedCreate, runSharedEdit } from '../src/commands/shared-manage'
import { EXIT_ERROR, EXIT_FORBIDDEN, exitCodeFor } from '../src/errors'
import type { Route } from './helpers'
import { jsonResponse, mockFetch, testContext } from './helpers'
import { APP_ID, APPROVAL_ID, appDetail, at, loggedInStore } from './p4-fixtures'
import { GROUP_ID, RESOURCE_ID, resource, resourceDetail } from './p5-fixtures'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(fn => fn()))
})

const noSleep = async () => {}
const forbidden = () =>
  jsonResponse({ error: 'Forbidden', statusCode: 403, code: 'forbidden' }, 403)
const conflict = (error: string, code: string) =>
  jsonResponse({ error, statusCode: 409, code }, 409)
const bodyOf = (init: RequestInit | undefined) => JSON.parse(String(init?.body))

async function run(
  fn: (ctx: Awaited<ReturnType<typeof testContext>>['ctx']) => Promise<void>,
  routes: Record<string, Route>,
  json = false
) {
  const { fetch, calls } = mockFetch({
    '/api/apps/expenses': () => jsonResponse(appDetail),
    '/api/shared-resources': () => jsonResponse({ items: [resource()] }),
    [`/api/shared-resources/${RESOURCE_ID}`]: () => jsonResponse(resourceDetail()),
    ...routes,
  })
  const t = await testContext({ store: await loggedInStore(cleanups), fetch, json })
  const error: any = await fn(t.ctx).then(
    () => null,
    (e: unknown) => e
  )
  return { ...t, calls, error }
}

// ---- deploys -------------------------------------------------------------------------------

const TICKET_ID = 'd0000000-0000-4000-8000-000000000001'
const ticket = (over: Record<string, unknown> = {}) => ({
  id: TICKET_ID,
  appId: APP_ID,
  environmentId: '5a000000-0000-4000-8000-000000000001',
  environment: 'production',
  purpose: 'deploy',
  status: 'pending',
  repository: 'acme/expenses',
  runId: '42',
  runAttempt: 1,
  sha: 'abcdef1234567890',
  ref: 'refs/tags/1.4.0',
  actor: 'alice',
  version: '1.4.0',
  cfVersionId: null,
  activatedAt: null,
  refused: null,
  decisionSource: 'approval',
  decidedByUserId: null,
  decidedAt: null,
  expiresAt: null,
  error: null,
  createdAt: at,
  updatedAt: at,
  finishedAt: null,
  ...over,
})
const deploys = `/api/apps/${APP_ID}/deploys`

describe('deploys production', () => {
  it('refuses without --yes before any POST', async () => {
    const r = await run(ctx => runDeploysProduction(ctx, 'expenses'), {})
    expect(exitCodeFor(r.error)).toBe(EXIT_ERROR)
    expect(r.calls.some(c => c.init.method === 'POST')).toBe(false)
  })

  it('--yes asks for approval and prints the request; --json is the body', async () => {
    const r = await run(ctx => runDeploysProduction(ctx, 'expenses', { yes: true }), {
      [`${deploys}/production`]: () => jsonResponse({ ticket: null, approvalId: APPROVAL_ID }, 202),
    })
    expect(r.error).toBeNull()
    expect(r.out.content()).toContain('waiting for approval')
    expect(r.out.content()).toContain(`approvals show ${APPROVAL_ID}`)
    const json = await run(
      ctx => runDeploysProduction(ctx, 'expenses', { yes: true }),
      {
        [`${deploys}/production`]: () =>
          jsonResponse({ ticket: null, approvalId: APPROVAL_ID }, 202),
      },
      true
    )
    expect(JSON.parse(json.out.content()).approvalId).toBe(APPROVAL_ID)
  })

  it('a 409 is the server’s sentence; a 403 exits 3', async () => {
    const busy = await run(ctx => runDeploysProduction(ctx, 'expenses', { yes: true }), {
      [`${deploys}/production`]: () => conflict('Launch is not reachable', 'launch_not_reachable'),
    })
    expect(exitCodeFor(busy.error)).toBe(EXIT_ERROR)
    expect(busy.error.message).toBe('Launch is not reachable')
    const denied = await run(ctx => runDeploysProduction(ctx, 'expenses', { yes: true }), {
      [`${deploys}/production`]: forbidden,
    })
    expect(exitCodeFor(denied.error)).toBe(EXIT_FORBIDDEN)
  })
})

describe('deploys approve / reject', () => {
  it('finds the ticket by prefix and POSTs the decision with its reason', async () => {
    const r = await run(
      ctx => runDeploysDecide(ctx, 'expenses', TICKET_ID.slice(0, 8), 'reject', { reason: 'no' }),
      {
        [deploys]: () => jsonResponse({ items: [ticket()] }),
        [`${deploys}/${TICKET_ID}/decide`]: () => jsonResponse(ticket({ status: 'rejected' })),
      }
    )
    expect(r.error).toBeNull()
    const post = r.calls.find(c => c.init.method === 'POST')
    expect(bodyOf(post?.init)).toEqual({ decision: 'reject', reason: 'no' })
    expect(r.out.content()).toContain('nothing is deployed')
  })

  it('someone else decided is a 409 (exit 1); not an approver is a 403 (exit 3)', async () => {
    const decided = await run(ctx => runDeploysDecide(ctx, 'expenses', TICKET_ID, 'approve'), {
      [`${deploys}/${TICKET_ID}/decide`]: () => conflict('Already decided', 'already_decided'),
    })
    expect(exitCodeFor(decided.error)).toBe(EXIT_ERROR)
    const denied = await run(ctx => runDeploysDecide(ctx, 'expenses', TICKET_ID, 'approve'), {
      [`${deploys}/${TICKET_ID}/decide`]: forbidden,
    })
    expect(exitCodeFor(denied.error)).toBe(EXIT_FORBIDDEN)
  })
})

// ---- shared resources ----------------------------------------------------------------------

describe('shared create / edit / archive', () => {
  it('create sends the contract body from flags', async () => {
    const r = await run(
      ctx =>
        runSharedCreate(ctx, 'm365', {
          name: 'Microsoft 365',
          team: GROUP_ID,
          item: [
            { key: 'M365_TENANT_ID', kind: 'var' },
            { key: 'M365_CLIENT_SECRET', kind: 'secret' },
          ],
        }),
      { '/api/shared-resources': () => jsonResponse(resourceDetail(), 201) },
      true
    )
    expect(r.error).toBeNull()
    expect(bodyOf(r.calls[0]?.init)).toEqual({
      slug: 'm365',
      displayName: 'Microsoft 365',
      ownerGroupId: GROUP_ID,
      items: [
        { key: 'M365_TENANT_ID', kind: 'var' },
        { key: 'M365_CLIENT_SECRET', kind: 'secret' },
      ],
      policies: {},
    })
    expect(JSON.parse(r.out.content()).id).toBe(RESOURCE_ID)
  })

  it('create refuses a bad body before any request; a taken slug is 409 → 1', async () => {
    const bad = await run(ctx => runSharedCreate(ctx, 'm365', { name: 'X' }), {})
    expect(exitCodeFor(bad.error)).toBe(EXIT_ERROR)
    expect(bad.error.message).toContain('ownerGroupId')
    expect(bad.calls).toHaveLength(0)
    const taken = await run(
      ctx =>
        runSharedCreate(ctx, 'm365', {
          name: 'X',
          team: GROUP_ID,
          item: [{ key: 'A', kind: 'secret' }],
        }),
      {
        '/api/shared-resources': (_u, init) =>
          init.method === 'POST'
            ? conflict('That slug is taken', 'shared_resource_slug_taken')
            : jsonResponse({ items: [] }),
      }
    )
    expect(exitCodeFor(taken.error)).toBe(EXIT_ERROR)
  })

  it('edit PATCHes the change by slug; a team change as an owner is a 403', async () => {
    const r = await run(ctx => runSharedEdit(ctx, 'm365', { description: '' }), {})
    expect(r.error).toBeNull()
    const patch = r.calls.find(c => c.init.method === 'PATCH')
    expect(patch?.url.pathname).toBe(`/api/shared-resources/${RESOURCE_ID}`)
    expect(bodyOf(patch?.init)).toEqual({ description: null })
    const denied = await run(ctx => runSharedEdit(ctx, 'm365', { team: GROUP_ID }), {
      [`/api/shared-resources/${RESOURCE_ID}`]: (_u, init) =>
        init.method === 'PATCH' ? forbidden() : jsonResponse(resourceDetail()),
    })
    expect(exitCodeFor(denied.error)).toBe(EXIT_FORBIDDEN)
  })

  it('archive refuses without --yes; with it, DELETEs; held by an app is a 409', async () => {
    const refused = await run(ctx => runSharedArchive(ctx, 'm365'), {})
    expect(exitCodeFor(refused.error)).toBe(EXIT_ERROR)
    expect(refused.calls.some(c => c.init.method === 'DELETE')).toBe(false)
    const r = await run(ctx => runSharedArchive(ctx, 'm365', { yes: true }), {
      [`/api/shared-resources/${RESOURCE_ID}`]: (_u, init) =>
        init.method === 'DELETE'
          ? new Response(null, { status: 204 })
          : jsonResponse(resourceDetail()),
    })
    expect(r.error).toBeNull()
    expect(r.out.content()).toContain('Archived Microsoft 365')
    const held = await run(ctx => runSharedArchive(ctx, 'm365', { yes: true }), {
      [`/api/shared-resources/${RESOURCE_ID}`]: (_u, init) =>
        init.method === 'DELETE'
          ? conflict('Apps still hold it', 'resource_has_holders')
          : jsonResponse(resourceDetail()),
    })
    expect(exitCodeFor(held.error)).toBe(EXIT_ERROR)
    expect(held.error.message).toBe('Apps still hold it')
  })
})

// ---- agent accounts ------------------------------------------------------------------------

const LOGIN_ID = '10910000-0000-4000-8000-000000000001'
const CODE = 'abc123sentinel#state456'
const option = (runtime: string, over: Record<string, unknown> = {}) => ({
  runtime,
  label: runtime === 'codex' ? 'Codex' : 'Claude Code',
  accountLabel: runtime === 'codex' ? 'ChatGPT plan' : 'Claude subscription',
  enabled: true,
  credentialMode: 'user_or_platform',
  userCredentials: true,
  needsCode: runtime !== 'codex',
  ...over,
})
const login = (status: string, over: Record<string, unknown> = {}) => ({
  id: LOGIN_ID,
  runtime: 'claude_code',
  status,
  verificationUrl: status === 'starting' ? null : 'https://claude.ai/oauth/authorize?x=1',
  userCode: null,
  needsCode: true,
  error: null,
  expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  createdAt: at,
  finishedAt: null,
  ...over,
})
const accounts = (over: Record<string, unknown> = {}) => ({
  runtimes: [option('claude_code'), option('codex')],
  credentials: [],
  logins: [],
  defaultRuntime: 'claude_code',
  ...over,
})
const loginBase = `/api/me/agent-logins/${LOGIN_ID}`

describe('agent-accounts ls / rm / cancel', () => {
  it('lists what is offered and connected; --json is the body', async () => {
    const credential = {
      id: '1c000000-0000-4000-8000-000000000001',
      runtime: 'claude_code',
      kind: 'claude_oauth_token',
      status: 'active',
      metadata: {},
      expiresAt: null,
      lastUsedAt: null,
      inUse: true,
      createdAt: at,
      updatedAt: at,
    }
    const body = accounts({ credentials: [credential] })
    const r = await run(ctx => runAgentAccountsList(ctx), {
      '/api/me/agent-credentials': () => jsonResponse(body),
    })
    expect(r.out.content()).toContain('Connected · in use')
    expect(r.out.content()).toContain('agent-accounts login codex')
    expect(r.out.content()).toContain('A new session runs Claude Code unless you name one')
    const json = await run(
      ctx => runAgentAccountsList(ctx),
      { '/api/me/agent-credentials': () => jsonResponse(body) },
      true
    )
    expect(JSON.parse(json.out.content()).credentials).toHaveLength(1)
  })

  it('rm refuses without --yes, refuses an unknown runtime, and DELETEs with --yes', async () => {
    const refused = await run(ctx => runAgentAccountsRemove(ctx, 'claude_code'), {})
    expect(exitCodeFor(refused.error)).toBe(EXIT_ERROR)
    expect(refused.calls).toHaveLength(0)
    const unknown = await run(ctx => runAgentAccountsRemove(ctx, 'gemini', { yes: true }), {})
    expect(unknown.error.message).toContain('Unknown runtime')
    expect(unknown.calls).toHaveLength(0)
    const r = await run(ctx => runAgentAccountsRemove(ctx, 'codex', { yes: true }), {
      '/api/me/agent-credentials/codex': () => new Response(null, { status: 204 }),
    })
    expect(r.error).toBeNull()
    expect(r.calls[0]?.init.method).toBe('DELETE')
    const none = await run(ctx => runAgentAccountsRemove(ctx, 'codex', { yes: true }), {})
    expect(exitCodeFor(none.error)).toBe(EXIT_ERROR)
  })

  it('cancel finds the sign-in under way and cancels it', async () => {
    const r = await run(ctx => runAgentAccountsCancel(ctx, 'claude_code'), {
      '/api/me/agent-credentials': () =>
        jsonResponse(accounts({ logins: [login('awaiting_user')] })),
      [`${loginBase}/cancel`]: () => jsonResponse({ login: login('cancelled') }),
    })
    expect(r.error).toBeNull()
    expect(r.calls.at(-1)?.url.pathname).toBe(`${loginBase}/cancel`)
  })
})

describe('agent-accounts login', () => {
  it('checks Claude’s code shape', () => {
    expect(claudeCodeProblem(CODE)).toBeNull()
    expect(claudeCodeProblem('half-a-code')).toContain('# in the middle')
  })

  it('starts, prints the page, reads the code from stdin, sends it once and polls to done', async () => {
    const states = ['awaiting_user', 'finishing', 'succeeded']
    let i = 0
    const r = await run(
      ctx =>
        runAgentAccountsLogin(ctx, 'claude_code', {
          sleep: noSleep,
          isTTY: false,
          readStdin: async () => `${CODE}\n`,
        }),
      {
        '/api/me/agent-credentials': () => jsonResponse(accounts()),
        '/api/me/agent-logins': () => jsonResponse({ login: login('starting') }, 202),
        [loginBase]: () => jsonResponse({ login: login(states[Math.min(i++, 2)] as string) }),
        [`${loginBase}/code`]: () => jsonResponse({ login: login('submitting') }, 202),
      },
      true
    )
    expect(r.error).toBeNull()
    const start = r.calls.find(c => c.url.pathname === '/api/me/agent-logins')
    expect(bodyOf(start?.init)).toEqual({ runtime: 'claude_code' })
    const sent = r.calls.filter(c => c.url.pathname === `${loginBase}/code`)
    expect(sent).toHaveLength(1)
    expect(bodyOf(sent[0]?.init)).toEqual({ code: CODE })
    expect(r.log.lines.join('\n')).toContain('https://claude.ai/oauth/authorize')
    expect(JSON.parse(r.out.content()).login.status).toBe('succeeded')
    // The code went to the server and nowhere else.
    expect(`${r.out.content()}${r.log.lines.join('\n')}`).not.toContain('sentinel')
  })

  it('resumes the sign-in in flight; Codex shows its device code and needs no paste', async () => {
    const codex = (status: string) =>
      login(status, { runtime: 'codex', needsCode: false, userCode: 'ABCD-1234' })
    let i = 0
    const r = await run(ctx => runAgentAccountsLogin(ctx, 'codex', { sleep: noSleep }), {
      '/api/me/agent-credentials': () =>
        jsonResponse(accounts({ logins: [codex('awaiting_user')] })),
      [loginBase]: () => jsonResponse({ login: codex(i++ === 0 ? 'awaiting_user' : 'succeeded') }),
    })
    expect(r.error).toBeNull()
    expect(r.calls.some(c => c.url.pathname === '/api/me/agent-logins')).toBe(false)
    expect(r.log.lines.join('\n')).toContain('ABCD-1234')
    expect(r.out.content()).toContain('Account connected')
  })

  it('a malformed code cancels the sign-in and exits 1 without sending it', async () => {
    const r = await run(
      ctx =>
        runAgentAccountsLogin(ctx, 'claude_code', {
          sleep: noSleep,
          isTTY: true,
          promptHidden: async () => 'no-hash-here',
        }),
      {
        '/api/me/agent-credentials': () => jsonResponse(accounts()),
        '/api/me/agent-logins': () => jsonResponse({ login: login('awaiting_user') }, 202),
        [`${loginBase}/cancel`]: () => jsonResponse({ login: login('cancelled') }),
      }
    )
    expect(exitCodeFor(r.error)).toBe(EXIT_ERROR)
    expect(r.calls.some(c => c.url.pathname === `${loginBase}/code`)).toBe(false)
    expect(r.calls.some(c => c.url.pathname === `${loginBase}/cancel`)).toBe(true)
  })

  it('a failed sign-in exits 1 with its error; logins off here is a 409 (exit 1)', async () => {
    const failed = await run(ctx => runAgentAccountsLogin(ctx, 'codex', { sleep: noSleep }), {
      '/api/me/agent-credentials': () => jsonResponse(accounts()),
      '/api/me/agent-logins': () =>
        jsonResponse(
          { login: login('failed', { runtime: 'codex', needsCode: false, error: 'Denied' }) },
          202
        ),
    })
    expect(exitCodeFor(failed.error)).toBe(EXIT_ERROR)
    expect(failed.error.message).toBe('Denied')
    const off = await run(ctx => runAgentAccountsLogin(ctx, 'codex', { sleep: noSleep }), {
      '/api/me/agent-credentials': () => jsonResponse(accounts()),
      '/api/me/agent-logins': () => conflict('Personal accounts are off', 'agent_logins_disabled'),
    })
    expect(exitCodeFor(off.error)).toBe(EXIT_ERROR)
    const denied = await run(ctx => runAgentAccountsLogin(ctx, 'codex', { sleep: noSleep }), {
      '/api/me/agent-credentials': forbidden,
    })
    expect(exitCodeFor(denied.error)).toBe(EXIT_FORBIDDEN)
  })
})
