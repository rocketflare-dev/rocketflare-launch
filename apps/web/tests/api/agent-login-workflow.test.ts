/**
 * `AgentLoginWorkflow` (§18.22) driven end to end with `createFakeWorkflowStep`, a `FakeSandbox`
 * (through `createFakeSessionPorts`) and a FAKE driver that behaves the way a relayed CLI does: it
 * prints the provider's URL, blocks until a code is written to its input file
 * (`onProcess(…, { waitForFile, thenLines })`), then prints the credential and exits.
 *
 * Covers the happy path for a runtime that takes a code back (Claude-shaped) and one that does not
 * (Codex-shaped), the TTL, a cancel, a capture that fails — and in EVERY case that the sandbox is
 * destroyed, the step names are distinct, and the credential appears in no row, step result or
 * response but the sealed one.
 */
import type { AgentRuntimeId } from '@launch/shared/launch-agents'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { SYSTEM_ACTOR } from '@/api/services/launch/audit'
import { getForUser, openSecret } from '@/api/services/sessions/credentials/store'
import { CODEX_OUTBOUND_HANDLERS } from '@/api/services/sessions/egress/registry'
import { loginForSandbox } from '@/api/services/sessions/egress/sandbox-lookup'
import { cancelLogin, startLogin, submitLoginCode } from '@/api/services/sessions/logins/service'
import { loginSandboxName } from '@/api/services/sessions/logins/steps'
import { runAgentLoginsSweep } from '@/api/services/sessions/logins/sweep'
import type { LoginDriver } from '@/api/services/sessions/runtimes/types'
import { AgentLoginWorkflow } from '@/api/workflows/agent-login'
import { loadConfig } from '@/config'
import { type AgentLoginRow, agentLogins, auditEvents } from '@/db/schema'
import { createTestTenantWithUser } from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import type { FakeSandbox } from '../helpers/fake-sandbox'
import { createFakeSessionPorts } from '../helpers/sessions'
import { createTestEnv, RecordingWorkflow } from '../mocks/bindings'
import { createFakeWorkflowStep } from '../mocks/cloudflare-workers'

const db = setupTestDatabase()

const TOKEN = 'sk-ant-oat01-SENTINEL-captured-token-never-echoed'
const URL_LINE = 'Open https://claude.ai/oauth/authorize?code=true&state=abc to sign in'
const IN_FILE = '/tmp/login/in'

/**
 * A driver over the FakeSandbox, shaped like a relay: `start` starts the CLI and reads its stream
 * in the background into `out`; `submitCode` writes the input file the CLI blocks on.
 */
function fakeDriver(opts: { needsCode: boolean; captureFails?: string; userCode?: string }) {
  const state = new Map<string, { out: string; exited: boolean }>()
  const driver: LoginDriver = {
    hosts: ['claude.ai', 'console.anthropic.com'],
    needsCode: opts.needsCode,
    async start({ sandbox, loginId }) {
      const run = { out: '', exited: false }
      state.set(loginId, run)
      const proc = await sandbox.startProcess('fake-cli login')
      void (async () => {
        for await (const event of sandbox.streamLogs(proc.id)) {
          if (event.type === 'stdout') run.out += event.data
          if (event.type === 'exit') run.exited = true
        }
      })()
    },
    async readPrompt({ loginId }) {
      const out = state.get(loginId)?.out ?? ''
      const url = /https:\/\/\S+/.exec(out)?.[0]
      return url ? { verificationUrl: url, userCode: opts.userCode ?? null } : null
    },
    async submitCode({ sandbox }, code) {
      await sandbox.writeFile(IN_FILE, `${code}\r`)
    },
    async poll({ loginId }) {
      return state.get(loginId)?.exited ? { state: 'exited', exitCode: 0 } : { state: 'running' }
    },
    async capture({ loginId }) {
      if (opts.captureFails) throw new Error(opts.captureFails)
      const token = /sk-ant-oat01-\S+/.exec(state.get(loginId)?.out ?? '')?.[0]
      if (!token) throw new Error('no token printed')
      return {
        kind: 'claude_oauth_token',
        secret: token,
        expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60_000),
        metadata: { source: 'setup-token' },
      }
    },
  }
  if (!opts.needsCode) delete driver.submitCode
  return driver
}

/** A clock that only moves when the code sleeps — polling loops run instantly. */
function fakeClock() {
  let t = Date.now()
  return {
    now: () => new Date(t),
    sleep: async (ms: number) => {
      t += ms
      await new Promise(resolve => setTimeout(resolve, 0))
    },
    jump: (ms: number) => {
      t += ms
    },
  }
}

async function setup(runtime: AgentRuntimeId = 'claude_code') {
  const f = await createTestTenantWithUser(db, 'member')
  const workflowBinding = new RecordingWorkflow()
  const login = await startLogin(db, workflowBinding as unknown as Workflow, {
    tenantId: f.tenant.id,
    userId: f.user.id,
    runtime,
    actor: { ...SYSTEM_ACTOR },
  })
  const env = createTestEnv()
  const ports = createFakeSessionPorts()
  return { f, login, env, ports, workflowBinding, cfg: loadConfig(env) }
}

function sandboxOf(ports: ReturnType<typeof createFakeSessionPorts>, login: AgentLoginRow) {
  return ports.sandbox(loginSandboxName(login.id)) as FakeSandbox
}

async function reload(login: AgentLoginRow) {
  const [row] = await db
    .select()
    .from(agentLogins)
    .where(and(eq(agentLogins.tenantId, login.tenantId), eq(agentLogins.id, login.id)))
  if (!row) throw new Error('gone')
  return row
}

/** Run the Workflow, capturing every step's RESULT (none may carry the credential). */
async function drive(
  s: Awaited<ReturnType<typeof setup>>,
  driver: LoginDriver,
  clock: ReturnType<typeof fakeClock>,
  onWait?: () => Promise<unknown>
) {
  const fake = createFakeWorkflowStep(onWait ? { onWait } : {})
  const results: unknown[] = []
  const recording = {
    ...fake.step,
    async do(name: string, config: unknown, fn?: () => Promise<unknown>) {
      const result = await (
        fake.step.do as (n: string, c: unknown, f?: unknown) => Promise<unknown>
      )(name, config, fn)
      results.push(result)
      return result
    },
  }
  const wf = new AgentLoginWorkflow({} as never, s.env as never)
  wf.overrides = {
    ports: s.ports,
    driverFor: () => driver,
    now: clock.now,
    sleep: clock.sleep,
  }
  const outcome = await wf.run(
    {
      payload: { loginId: s.login.id, tenantId: s.f.tenant.id },
      timestamp: new Date(),
      instanceId: s.login.id,
      workflowName: 'launch-agent-login',
    },
    recording as never
  )
  return { outcome, names: fake.names, calls: fake.calls, results }
}

describe('a runtime that takes a code back (Claude-shaped)', () => {
  it('relays the URL out and the code in, seals the token, and destroys the sandbox', async () => {
    const s = await setup()
    const clock = fakeClock()
    const sandbox = sandboxOf(s.ports, s.login)
    sandbox.onProcess('fake-cli login', {
      lines: ['Welcome', URL_LINE],
      waitForFile: IN_FILE,
      thenLines: [`Your token: ${TOKEN}`],
    })
    const base = fakeDriver({ needsCode: true })
    let inputAtCapture: string | undefined
    const driver: LoginDriver = {
      ...base,
      capture: async ctx => {
        inputAtCapture = sandbox.files.get(IN_FILE)
        return base.capture(ctx)
      },
    }

    const { outcome, names, results } = await drive(s, driver, clock, async () => {
      // The person pastes the code: what the route does, then the Workflow is woken.
      const row = await reload(s.login)
      expect(row.status).toBe('awaiting_user')
      expect(row.verificationUrl).toContain('https://claude.ai/oauth/authorize')
      await submitLoginCode(db, s.cfg, s.workflowBinding as unknown as Workflow, row, 'the-code-42')
      return {}
    })

    expect(outcome).toEqual({ loginId: s.login.id, status: 'succeeded' })
    expect(new Set(names).size).toBe(names.length)
    expect(names).toEqual([
      'start',
      'prompt#0',
      'runtime',
      'code#0',
      'submit#0',
      'finish#0',
      'capture',
      'cleanup',
    ])
    // The code reached the CLI's input, exactly as typed plus the Enter (the CLI printed the
    // token only once it had), and the input went with the sandbox.
    expect(inputAtCapture).toBe('the-code-42\r')
    expect(sandbox.files.get(IN_FILE)).toBeUndefined()
    // The sandbox was started with the driver's hosts, recorded on the row first, and destroyed.
    expect(sandbox.allowedHosts).toEqual(
      expect.arrayContaining(['claude.ai', 'console.anthropic.com'])
    )
    expect(sandbox.destroyed).toBe(true)

    const row = await reload(s.login)
    expect(row).toMatchObject({
      status: 'succeeded',
      sandboxId: sandbox.id,
      verificationUrl: null,
      userCode: null,
      codeSealed: null,
    })
    const credential = await getForUser(db, s.f.tenant.id, s.f.user.id, 'claude_code')
    expect(credential).toMatchObject({ kind: 'claude_oauth_token', status: 'active' })
    expect(await openSecret(s.cfg, credential as NonNullable<typeof credential>)).toBe(TOKEN)

    // Nowhere else: not in a step result, the login row, or the audit row.
    expect(JSON.stringify(results)).not.toContain(TOKEN)
    expect(JSON.stringify(results)).not.toContain('the-code-42')
    expect(JSON.stringify(row)).not.toContain(TOKEN)
    const audit = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.tenantId, s.f.tenant.id),
          eq(auditEvents.action, 'agent_credential.connected')
        )
      )
    expect(audit).toHaveLength(1)
    expect(JSON.stringify(audit)).not.toContain(TOKEN)
  })
})

describe('a runtime that only shows a code (Codex-shaped)', () => {
  it('codex: prompt → finish → capture, with the device code on the row while it waits', async () => {
    const f = await createTestTenantWithUser(db, 'member')
    const binding = new RecordingWorkflow()
    // Codex logins need the runtime on in the flags only at the ROUTE; the service takes any.
    const login = await startLogin(db, binding as unknown as Workflow, {
      tenantId: f.tenant.id,
      userId: f.user.id,
      runtime: 'codex',
      actor: { ...SYSTEM_ACTOR },
    })
    const env = createTestEnv()
    const ports = createFakeSessionPorts()
    const s = { f, login, env, ports, workflowBinding: binding, cfg: loadConfig(env) }
    const clock = fakeClock()
    const sandbox = sandboxOf(ports, login)
    sandbox.onProcess('fake-cli login', { lines: [URL_LINE, `done ${TOKEN}`] })
    let codeWhileWaiting: string | null = null
    const base = fakeDriver({ needsCode: false, userCode: 'ABCD-1234' })
    const driver: LoginDriver = {
      ...base,
      capture: async ctx => {
        codeWhileWaiting = (await reload(login)).userCode
        return { ...(await base.capture(ctx)), kind: 'codex_chatgpt_auth' }
      },
    }
    const { outcome, names } = await drive(s, driver, clock)
    expect(outcome.status).toBe('succeeded')
    expect(names).toEqual(['start', 'prompt#0', 'runtime', 'finish#0', 'capture', 'cleanup'])
    expect(codeWhileWaiting).toBe('ABCD-1234')
    expect((await reload(login)).userCode).toBeNull()
    expect(await getForUser(db, f.tenant.id, f.user.id, 'codex')).toMatchObject({
      kind: 'codex_chatgpt_auth',
    })
    expect(sandbox.destroyed).toBe(true)
  })
})

describe('a login that does not finish', () => {
  it('past its TTL: expired, with a sentence; the sandbox destroyed', async () => {
    const s = await setup()
    const clock = fakeClock()
    sandboxOf(s.ports, s.login).onProcess('fake-cli login', { lines: ['starting…'], hang: true })
    const { outcome, names } = await drive(s, fakeDriver({ needsCode: true }), clock)
    expect(outcome.status).toBe('expired')
    expect(names.at(-2)).toBe('expire')
    expect(names.at(-1)).toBe('cleanup')
    expect(new Set(names).size).toBe(names.length)
    const row = await reload(s.login)
    expect(row.status).toBe('expired')
    expect(row.error).toMatch(/took too long/)
    expect(sandboxOf(s.ports, s.login).destroyed).toBe(true)
  })

  it('cancelled while waiting for the code: stopped, nothing captured, the sandbox destroyed', async () => {
    const s = await setup()
    const clock = fakeClock()
    sandboxOf(s.ports, s.login).onProcess('fake-cli login', {
      lines: [URL_LINE],
      waitForFile: IN_FILE,
      thenLines: [TOKEN],
    })
    const { outcome, names } = await drive(s, fakeDriver({ needsCode: true }), clock, async () => {
      await cancelLogin(db, s.workflowBinding as unknown as Workflow, await reload(s.login))
      return {}
    })
    expect(outcome.status).toBe('stopped')
    expect(names).not.toContain('capture')
    expect(names.at(-1)).toBe('cleanup')
    expect((await reload(s.login)).status).toBe('cancelled')
    expect(await getForUser(db, s.f.tenant.id, s.f.user.id, 'claude_code')).toBeNull()
    expect(sandboxOf(s.ports, s.login).destroyed).toBe(true)
  })

  it('a capture that fails: failed, its message redacted, no credential, the sandbox destroyed', async () => {
    const s = await setup()
    const clock = fakeClock()
    sandboxOf(s.ports, s.login).onProcess('fake-cli login', {
      lines: [URL_LINE],
      waitForFile: IN_FILE,
      thenLines: ['done'],
    })
    const driver = fakeDriver({
      needsCode: true,
      captureFails: `could not parse output near ${TOKEN}`,
    })
    const { outcome, names } = await drive(s, driver, clock, async () => {
      await submitLoginCode(
        db,
        s.cfg,
        s.workflowBinding as unknown as Workflow,
        await reload(s.login),
        'code'
      )
      return {}
    })
    expect(outcome.status).toBe('failed')
    expect(names.slice(-2)).toEqual(['fail', 'cleanup'])
    const row = await reload(s.login)
    expect(row.status).toBe('failed')
    expect(row.error).toContain('[redacted]')
    expect(row.error).not.toContain(TOKEN)
    expect(await getForUser(db, s.f.tenant.id, s.f.user.id, 'claude_code')).toBeNull()
    expect(sandboxOf(s.ports, s.login).destroyed).toBe(true)
  })

  it('a login cancelled before its Workflow ran: start does nothing, cleanup still runs', async () => {
    const s = await setup()
    await cancelLogin(db, undefined, s.login)
    const { outcome, names } = await drive(s, fakeDriver({ needsCode: true }), fakeClock())
    expect(outcome.status).toBe('stopped')
    expect(names).toEqual(['start', 'cleanup'])
    expect(sandboxOf(s.ports, s.login).startCount).toBe(0)
  })
})

describe('the egress side of a login sandbox', () => {
  it('loginForSandbox finds the login in flight by its container id, and nothing once it ended', async () => {
    const s = await setup()
    const sandbox = sandboxOf(s.ports, s.login)
    await db
      .update(agentLogins)
      .set({ sandboxId: sandbox.id })
      .where(and(eq(agentLogins.tenantId, s.f.tenant.id), eq(agentLogins.id, s.login.id)))
    expect((await loginForSandbox(db, sandbox.id))?.id).toBe(s.login.id)
    expect(await loginForSandbox(db, 'fake-sandbox-someone-else')).toBeNull()
    await cancelLogin(db, undefined, await reload(s.login))
    expect(await loginForSandbox(db, sandbox.id)).toBeNull()
  })

  it('Codex’s hosts are staged as OpenAI-shaped refusals', async () => {
    expect(Object.keys(CODEX_OUTBOUND_HANDLERS).sort()).toEqual(
      ['api.openai.com', 'auth.openai.com', 'chatgpt.com'].sort()
    )
    const res = await CODEX_OUTBOUND_HANDLERS['api.openai.com']?.(
      new Request('https://api.openai.com/v1/responses', { method: 'POST' }),
      {},
      { containerId: 'x' }
    )
    expect(res?.status).toBe(403)
    expect(await res?.json()).toMatchObject({ error: { type: 'permission_error' } })
  })
})

describe('the sweep', () => {
  it('expires a login past its TTL that no Workflow will finish, nulling what the person saw, and destroys its sandbox', async () => {
    const s = await setup()
    await db
      .update(agentLogins)
      .set({
        status: 'awaiting_user',
        verificationUrl: 'https://claude.ai/oauth/authorize?x=1',
        expiresAt: new Date(Date.now() - 60_000),
      })
      .where(and(eq(agentLogins.tenantId, s.f.tenant.id), eq(agentLogins.id, s.login.id)))
    const result = await runAgentLoginsSweep(db, {
      tenantIds: [s.f.tenant.id],
      sandbox: name => s.ports.sandbox(name),
    })
    expect(result.expired).toBe(1)
    const row = await reload(s.login)
    expect(row).toMatchObject({ status: 'expired', verificationUrl: null, codeSealed: null })
    expect(sandboxOf(s.ports, s.login).destroyed).toBe(true)
    expect((await runAgentLoginsSweep(db, { tenantIds: [s.f.tenant.id] })).expired).toBe(0)
  })
})
