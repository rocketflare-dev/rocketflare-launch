/**
 * Launch P3 slice 3a's wiring, end to end where it is real: `worker.ts` sends a preview host to the
 * gateway BEFORE the Hono app (a JSON 404 for a session that does not exist or a wrong token, 410
 * for an ended one, and no `X-Frame-Options`), the egress handlers find a session only from the
 * platform's container id, the access rule (creator, app owners, admins; everyone else the SAME
 * 404), the mounts answer as the auth surface says, `defaultSessionPorts` binds by backend and
 * fails BY NAME where a later slice has not wired an adapter, and the fakes behave as their headers
 * promise.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { previewLabel, previewUrl } from '@launch/shared/launch-sessions'
import { describe, expect, it } from 'vitest'
import { getVisibleSession, maySeeSession, sessionViewerOf } from '@/api/services/sessions/access'
import { handleAnthropic } from '@/api/services/sessions/egress/anthropic'
import { handleGitHub } from '@/api/services/sessions/egress/github'
import {
  defaultSessionPorts,
  SandboxInterruptedError,
  SESSION_BASE_ALLOWED_HOSTS,
} from '@/api/services/sessions/ports'
import { loadConfig } from '@/config'
import { buildAbility } from '@/permissions'
import worker from '@/worker'
import { createTestTenantWithUser, createTestUser, linkUserToTenant } from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import {
  anthropicSseText,
  claudeStreamJson,
  claudeStreamJsonLines,
  createFakeAnthropic,
} from '../helpers/fake-anthropic'
import { createFakeCloud } from '../helpers/fake-cloud'
import { FakeSandbox } from '../helpers/fake-sandbox'
import { json, request } from '../helpers/request'
import { insertSession, seedSessionApp } from '../helpers/sessions'
import {
  createExecutionContext,
  createTestEnv,
  stubs,
  type TestEnv,
  waitOnExecutionContext,
} from '../mocks/bindings'

const db = setupTestDatabase()
const PREVIEW_TEMPLATE = 'http://{label}.localhost:3001'
const createAbility = (role: 'member' | 'admin') =>
  buildAbility({ role, isGlobalAdmin: false, features: [] })

function previewEnv(): TestEnv {
  return createTestEnv({ SESSION_PREVIEW_URL: PREVIEW_TEMPLATE })
}

async function workerFetch(url: string, env: TestEnv): Promise<Response> {
  const ctx = createExecutionContext()
  const res = await worker.fetch(
    new Request(url) as Request<unknown, IncomingRequestCfProperties>,
    env,
    ctx
  )
  await waitOnExecutionContext(ctx)
  return res
}

describe('worker.ts: preview hosts go to the gateway, before the Hono app', () => {
  it('an unknown session, or a known one with the wrong token, is a JSON 404 without the app’s headers', async () => {
    const env = previewEnv()
    const unknown = previewUrl(PREVIEW_TEMPLATE, previewLabel(5173, 'abcdefghijkl', '0123456789'))
    const res = await workerFetch(`${unknown}/`, env)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({
      error: 'No such preview',
      statusCode: 404,
      code: 'preview_not_found',
    })
    // None of the Hono middleware ran: no request id, no X-Frame-Options.
    expect(res.headers.get('X-Frame-Options')).toBeNull()
    expect(res.headers.get('X-Request-Id')).toBeNull()

    const cloud = createFakeCloud()
    const f = await seedSessionApp(db, cloud)
    const row = await insertSession(db, f, { status: 'ready' })
    const wrongToken = previewUrl(PREVIEW_TEMPLATE, previewLabel(5173, row.shortId, 'zzzzzzzzzz'))
    expect((await workerFetch(`${wrongToken}/`, env)).status).toBe(404)

    const right = previewUrl(PREVIEW_TEMPLATE, previewLabel(5173, row.shortId, row.previewToken))
    const live = await workerFetch(`${right}/`, env)
    // Slice 3d: a real session with no preview cookie (preview-gateway.test.ts has the rest).
    expect(live.status).toBe(401)
    expect(await live.json()).toMatchObject({ code: 'preview_unauthorized' })
  })

  it('an ended session is a 410', async () => {
    const f = await seedSessionApp(db, createFakeCloud())
    const row = await insertSession(db, f, { status: 'ended', endedAt: new Date() })
    const url = previewUrl(PREVIEW_TEMPLATE, previewLabel(5173, row.shortId, row.previewToken))
    const res = await workerFetch(`${url}/`, previewEnv())
    expect(res.status).toBe(410)
    expect(await res.json()).toMatchObject({ code: 'session_ended' })
  })

  it('any other host is the Hono app as before — and with no preview URL configured, so is a preview-shaped one', async () => {
    const env = previewEnv()
    const health = await workerFetch('http://localhost:3001/api/health', env)
    expect(health.status).toBe(200)
    expect(health.headers.get('X-Request-Id')).toBeTruthy()

    const shaped = previewUrl(PREVIEW_TEMPLATE, previewLabel(5173, 'abcdefghijkl', '0123456789'))
    const noPreviews = await workerFetch(`${shaped}/api/health`, createTestEnv())
    expect(noPreviews.status).toBe(200)
  })

  it('exports the session classes the tomls name', async () => {
    const mod = await import('@/worker')
    for (const name of ['SessionSandbox', 'SessionWorkflow', 'ContainerProxy']) {
      expect(typeof (mod as Record<string, unknown>)[name], name).toBe('function')
    }
    const { SessionSandbox } = mod
    const probe = new SessionSandbox({} as never, createTestEnv() as never)
    // S7 finding 1: off by default on the stable packages — it must be set explicitly.
    expect(probe.interceptHttps).toBe(true)
    expect(probe.enableInternet).toBe(false)
    expect(probe.allowedHosts).toEqual([...SESSION_BASE_ALLOWED_HOSTS])
    // The two credential hosts only: a database key would intercept Neon even with internet on.
    expect(Object.keys(SessionSandbox.outboundByHost ?? {}).sort()).toEqual([
      'api.anthropic.com',
      'github.com',
    ])
    // SESSION_EGRESS=open (the tomls): internet on, no allow-list, HTTPS still intercepted.
    const deleted: string[] = []
    const ctx = { storage: { kv: { delete: (key: string) => void deleted.push(key) } } }
    const open = new SessionSandbox(
      ctx as never,
      createTestEnv({ SESSION_EGRESS: 'open' }) as never
    )
    expect(open.interceptHttps).toBe(true)
    expect(open.enableInternet).toBe(true)
    expect(open.allowedHosts).toBeUndefined()
    expect(deleted).toEqual(['OUTBOUND_CONFIGURATION'])
  })
})

describe('egress handlers find the session from the container id alone', () => {
  it('an unknown container is refused; a live session’s gets past the lookup to the proxy’s own checks', async () => {
    const env = createTestEnv()
    const req = new Request('https://api.anthropic.com/v1/messages', { method: 'POST' })
    const unknown = await handleAnthropic(req, env, { containerId: 'nobody' })
    expect(unknown.status).toBe(403)
    expect(await unknown.json()).toMatchObject({
      type: 'error',
      error: { type: 'permission_error' },
    })

    const f = await seedSessionApp(db, createFakeCloud())
    const sandboxId = `fake-sandbox-${crypto.randomUUID()}`
    await insertSession(db, f, { status: 'working', sandboxId })
    // Past the lookup: the empty body names no model, so the proxy's allow-list refuses it
    // (slice 3c; `session-model-proxy.test.ts` covers the rest).
    const known = await handleAnthropic(req, env, { containerId: sandboxId })
    expect(known.status).toBe(403)
    expect(await known.json()).toMatchObject({
      error: { message: expect.stringContaining('model') },
    })

    const git = new Request('https://github.com/acme/x.git/info/refs?service=git-upload-pack')
    expect((await handleGitHub(git, env, { containerId: 'nobody' })).status).toBe(403)
    // Slice 3d: `acme/x` is not the session's repo (session-github-egress.test.ts has the rest).
    expect((await handleGitHub(git, env, { containerId: sandboxId })).status).toBe(403)

    // An ENDED session's container is nobody.
    const endedId = `fake-sandbox-${crypto.randomUUID()}`
    await insertSession(db, f, { status: 'ended', sandboxId: endedId })
    expect((await handleAnthropic(req, env, { containerId: endedId })).status).toBe(403)
  })
})

describe('who may see a session', () => {
  it('its creator, the app’s owners and admins; another member gets the same 404 as a missing one', async () => {
    const f = await seedSessionApp(db, createFakeCloud(), { role: 'member' })
    const row = await insertSession(db, f)
    const creator = sessionViewerOf({ user: f.user, groups: [], ability: createAbility('member') })
    expect(await maySeeSession(db, f.tenant.id, row, creator)).toBe(true)

    const other = await createTestUser(db)
    await linkUserToTenant(db, other.id, f.tenant.id, 'member')
    const stranger = sessionViewerOf({ user: other, groups: [], ability: createAbility('member') })
    expect(await maySeeSession(db, f.tenant.id, row, stranger)).toBe(false)
    const hidden = await getVisibleSession(db, f.tenant.id, row.id, stranger).catch(e => e)
    const missing = await getVisibleSession(db, f.tenant.id, crypto.randomUUID(), stranger).catch(
      e => e
    )
    expect([hidden.statusCode, hidden.code]).toEqual([404, 'session_not_found'])
    expect([missing.statusCode, missing.code]).toEqual([hidden.statusCode, hidden.code])

    const admin = sessionViewerOf({ user: other, groups: [], ability: createAbility('admin') })
    expect(await maySeeSession(db, f.tenant.id, row, admin)).toBe(true)

    // Another tenant's session does not exist, whoever asks.
    const elsewhere = await createTestTenantWithUser(db, 'owner')
    const foreign = await getVisibleSession(db, elsewhere.tenant.id, row.id, admin).catch(e => e)
    expect(foreign.statusCode).toBe(404)
  })
})

describe('the mounts', () => {
  it('/api/sessions/* and /api/apps/:id/sessions need a session; unknown routes are JSON 404s', async () => {
    const id = crypto.randomUUID()
    for (const p of [
      `/api/sessions/${id}`,
      `/api/sessions/${id}/turns`,
      `/api/apps/${id}/sessions`,
    ]) {
      const res = await request(p)
      expect(res.status, p).toBe(401)
      expect(await json(res)).toMatchObject({ statusCode: 401 })
    }
    const f = await seedSessionApp(db, createFakeCloud())
    const res = await request(`/api/sessions/${id}`, { headers: f.cookie })
    expect(res.status).toBe(404)
    expect(await json(res)).toMatchObject({ statusCode: 404 })
  })

  it('/api/admin/sessions is behind the global-admin gate', async () => {
    const f = await seedSessionApp(db, createFakeCloud())
    const res = await request('/api/admin/sessions', { headers: f.cookie })
    expect(res.status).toBe(403)
  })
})

describe('defaultSessionPorts', () => {
  it('binds by SESSION_BACKEND, and each adapter fails by name when it cannot act', async () => {
    const env = createTestEnv()
    const cloudPorts = defaultSessionPorts(env, loadConfig(env))
    const sandbox = cloudPorts.sandbox('0b0e4c1e-5d7b-4c5a-9d52-1f0f3c4b2a10')
    // The container id the egress handlers will see is the Durable Object id of that name.
    expect(sandbox.id).toBe(
      env.SESSION_SANDBOX.idFromName('0b0e4c1e-5d7b-4c5a-9d52-1f0f3c4b2a10').toString()
    )
    // 3b: the SDK adapter drives the Durable Object stub — every command in its own `bash -c`.
    await sandbox.setAllowedHosts(['registry.npmjs.org'])
    expect(stubs(env).sandboxes?.calls.at(-1)).toMatchObject({
      method: 'setAllowedHosts',
      args: [['registry.npmjs.org']],
    })
    await expect(
      cloudPorts.sessionDb(db).createBranch({ slug: 'x', neonProjectId: null } as never, {
        id: 'x',
        shortId: 'y',
      })
    ).rejects.toThrow(/no Neon project/)
    expect(cloudPorts.repoHost(db).gitUpstream({ owner: 'o', repo: 'r' })).toBe(
      'https://github.com'
    )

    const localEnv = createTestEnv({
      SESSION_BACKEND: 'local',
      SESSION_LOCAL_GIT_URL: 'http://localhost:9420/',
    })
    const local = defaultSessionPorts(localEnv, loadConfig(localEnv))
    expect(local.repoHost(db).gitUpstream({ owner: 'o', repo: 'r' })).toBe('http://localhost:9420')
    expect(await local.repoHost(db).gitAuth({ owner: 'o', repo: 'r' })).toBeNull()
    // The database is a real Neon branch under `local` too: no Neon project, no database.
    await expect(
      local.sessionDb(db).createBranch({ slug: 'x', neonProjectId: null } as never, {
        id: 'x',
        shortId: 'y',
      })
    ).rejects.toThrow(/no Neon project/)
    expect(stubs(env).sessionWorkflow?.created).toEqual([])
  })
})

describe('the fakes', () => {
  it('FakeSandbox scripts exec and processes, keeps files and ports, records kills and destroys', async () => {
    const sandbox = new FakeSandbox({ name: 's1' })
      .onExec(/git clone/, { stdout: 'cloned' })
      .onExec('exit 3', () => ({ exitCode: 3, stderr: 'nope' }))
      .onProcess(/pnpm dev/, { lines: ['ready'], ports: [5173], hang: true })
      .onPort(5173, () => new Response('<h1>app</h1>'))
    await sandbox.start({ extraAllowedHosts: ['ep-x.us-east-2.aws.neon.tech'] })
    expect(sandbox.allowedHosts).toContain('ep-x.us-east-2.aws.neon.tech')
    expect((await sandbox.exec('git clone x')).stdout).toBe('cloned')
    expect((await sandbox.exec('bash -c "exit 3"')).exitCode).toBe(3)
    expect((await sandbox.exec('ls')).exitCode).toBe(0)

    const dev = await sandbox.startProcess('pnpm dev')
    await sandbox.waitForPort(5173)
    await expect(sandbox.waitForPort(8787)).rejects.toThrow(/never opened/)
    expect(await (await sandbox.fetch(5173, new Request('http://x/'))).text()).toBe('<h1>app</h1>')
    expect((await sandbox.fetch(8787, new Request('http://x/'))).status).toBe(502)

    const events: unknown[] = []
    const reading = (async () => {
      for await (const e of sandbox.streamLogs(dev.id)) events.push(e)
    })()
    await new Promise(r => setTimeout(r, 5))
    await sandbox.kill(dev.id)
    await reading
    expect(events).toEqual([
      { type: 'stdout', data: 'ready\n' },
      { type: 'exit', exitCode: 137 },
    ])
    expect(sandbox.killed).toEqual([dev.id])

    await sandbox.writeFile('/workspace/.claude/settings.local.json', '{}')
    expect(await sandbox.readFile('/workspace/.claude/settings.local.json')).toBe('{}')
    expect(await sandbox.readFile('/nope')).toBeNull()
    await sandbox.destroy()
    expect([sandbox.destroyed, sandbox.destroyCount, sandbox.files.size]).toEqual([true, 1, 0])
  })

  it('FakeSandbox.interruptNext is a rollout: the stream breaks after its first line and the container is gone', async () => {
    const sandbox = new FakeSandbox().onProcess(/claude/, claudeStreamJson({ text: 'hi' }))
    await sandbox.writeFile('/a', 'a')
    const proc = await sandbox.startProcess('claude -p hi')
    sandbox.interruptNext()
    const seen: unknown[] = []
    const err = await (async () => {
      for await (const e of sandbox.streamLogs(proc.id)) seen.push(e)
    })().catch(e => e)
    expect(err).toBeInstanceOf(SandboxInterruptedError)
    expect(seen).toHaveLength(1)
    expect(sandbox.interruptions).toBe(1)
    expect(sandbox.files.size).toBe(0)
    sandbox.interruptNext()
    await expect(sandbox.exec('ls')).rejects.toThrow(SandboxInterruptedError)
  })

  it('claudeStreamJson is Claude Code’s stream-json turn (S7): init → tool_use → tool_result → text → result', () => {
    const lines = claudeStreamJsonLines({
      sessionId: 'c1',
      text: 'Changed it.',
      tools: [{ name: 'Edit', input: { file_path: 'a.tsx' }, result: 'ok' }],
      usage: { input: 6, output: 115, cacheRead: 40131, cacheWrite: 4865 },
    }).map(l => JSON.parse(l))
    expect(lines.map(l => `${l.type}${l.subtype ? `:${l.subtype}` : ''}`)).toEqual([
      'system:init',
      'assistant',
      'user',
      'assistant',
      'result:success',
    ])
    expect(lines.every(l => l.session_id === 'c1')).toBe(true)
    expect(lines[1].message.content[0]).toMatchObject({ type: 'tool_use', name: 'Edit' })
    expect(lines[2].message.content[0].tool_use_id).toBe(lines[1].message.content[0].id)
    expect(lines[4]).toMatchObject({
      result: 'Changed it.',
      usage: { cache_read_input_tokens: 40131 },
    })
  })

  it('fake Anthropic records what upstream saw and meters like the real SSE', async () => {
    const anthropic = createFakeAnthropic({
      text: 'hello there',
      usage: { input: 12, output: 40, cacheRead: 900 },
    })
    const res = await anthropic.upstream.fetch(
      new Request('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': 'sk-ant-real', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-sonnet-4-5', stream: true }),
      })
    )
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    const text = await res.text()
    // Chunked on the wire, identical to the whole body once reassembled (ids aside).
    const shape = (t: string) => t.replace(/msg_fake_\w+/g, 'msg')
    expect(shape(text)).toBe(
      shape(
        anthropicSseText({ text: 'hello there', usage: { input: 12, output: 40, cacheRead: 900 } })
      )
    )
    expect(anthropic.requests[0]).toMatchObject({ path: '/v1/messages', apiKey: 'sk-ant-real' })
    const data = text
      .split('\n')
      .filter(l => l.startsWith('data: '))
      .map(l => JSON.parse(l.slice(6)))
    expect(data[0].message.usage).toMatchObject({ input_tokens: 12, cache_read_input_tokens: 900 })
    expect(data.find(d => d.type === 'message_delta').usage.output_tokens).toBe(40)
  })
})

describe('the session image', () => {
  it('stays on the Worker’s stable Sandbox line', () => {
    const dockerfile = readFileSync(
      path.resolve(__dirname, '../../containers/session/Dockerfile'),
      'utf8'
    )
    const pkg = JSON.parse(readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'))
    const version = pkg.dependencies['@cloudflare/sandbox']
    expect(version).toBe('0.12.10')
    expect(dockerfile).toContain(`FROM docker.io/cloudflare/sandbox:${version}`)
  })
})
