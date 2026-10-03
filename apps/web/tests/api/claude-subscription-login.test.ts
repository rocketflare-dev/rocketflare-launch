/**
 * Claude's relayed sign-in end to end (§18.22-A): `AgentLoginWorkflow` driven with
 * `createFakeWorkflowStep`, the REAL `claudeLoginDriver`, and a `FakeSandbox` that behaves like the
 * relay (`emulateClaudeRelay`: what the scripted `claude setup-token` prints lands in `out`, its exit
 * code in `exit`) — the CLI prints the spike S-A1 screen, blocks until the code reaches `in`, then
 * prints the (synthetic) success screen and exits 0.
 *
 * Asserts the code reached `in` exactly, the token is sealed, the login directory is deleted, and
 * the token appears in no step result, login row, audit row or response — and that a rejected code
 * fails the login with a sentence. Also the login sandbox's egress: only the token exchange and the
 * profile pass through, untouched.
 */
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { SYSTEM_ACTOR } from '@/api/services/launch/audit'
import { getForUser, openSecret } from '@/api/services/sessions/credentials/store'
import {
  CLAUDE_LOGIN_PASSTHROUGH,
  handleAnthropic,
  handleClaudeLoginHost,
} from '@/api/services/sessions/egress/anthropic'
import { SESSION_OUTBOUND_HANDLERS } from '@/api/services/sessions/egress/registry'
import { startLogin, submitLoginCode } from '@/api/services/sessions/logins/service'
import { loginSandboxName } from '@/api/services/sessions/logins/steps'
import {
  CLAUDE_LOGIN_HOSTS,
  claudeLoginDir,
  claudeLoginDriver,
} from '@/api/services/sessions/runtimes/claude-code/login'
import type { LoginDriver } from '@/api/services/sessions/runtimes/types'
import { AgentLoginWorkflow } from '@/api/workflows/agent-login'
import { loadConfig } from '@/config'
import { type AgentLoginRow, agentLogins, auditEvents } from '@/db/schema'
import { createTestTenantWithUser } from '../helpers/auth'
import {
  claudeLoginFixture,
  emulateClaudeRelay,
  setupTokenSuccessScreen,
  spikeSegments,
  FAKE_CLAUDE_TOKEN as TOKEN,
} from '../helpers/claude-login'
import { setupTestDatabase } from '../helpers/db'
import type { FakeSandbox } from '../helpers/fake-sandbox'
import { createFakeSessionPorts } from '../helpers/sessions'
import { createTestEnv, RecordingWorkflow } from '../mocks/bindings'
import { createFakeWorkflowStep } from '../mocks/cloudflare-workers'

const db = setupTestDatabase()

const [PROMPT_SCREEN, REJECTED_SCREEN] = spikeSegments(
  claudeLoginFixture('setup-token-1000cols.ansi')
)
const CODE = 'aBcD-123_xyz#nZTe5z8Qy0lBHHG2GSp0hcYFL_cmHK-MyeC_fMJNtpw'

function fakeClock() {
  let t = Date.now()
  return {
    now: () => new Date(t),
    sleep: async (ms: number) => {
      t += ms
      await new Promise(resolve => setTimeout(resolve, 0))
    },
  }
}

async function setup() {
  const f = await createTestTenantWithUser(db, 'member')
  const workflowBinding = new RecordingWorkflow()
  const login = await startLogin(db, workflowBinding as unknown as Workflow, {
    tenantId: f.tenant.id,
    userId: f.user.id,
    runtime: 'claude_code',
    actor: { ...SYSTEM_ACTOR },
  })
  const env = createTestEnv()
  const ports = createFakeSessionPorts()
  const sandbox = emulateClaudeRelay(ports.sandbox(loginSandboxName(login.id)) as FakeSandbox)
  const dir = claudeLoginDir(login.id)
  return { f, login, env, ports, sandbox, dir, workflowBinding, cfg: loadConfig(env) }
}

async function reload(login: AgentLoginRow) {
  const [row] = await db
    .select()
    .from(agentLogins)
    .where(and(eq(agentLogins.tenantId, login.tenantId), eq(agentLogins.id, login.id)))
  if (!row) throw new Error('gone')
  return row
}

/** Run the Workflow with the real driver, recording every step's RESULT. */
async function drive(
  s: Awaited<ReturnType<typeof setup>>,
  onWait: () => Promise<unknown>,
  driver: LoginDriver = claudeLoginDriver
) {
  const clock = fakeClock()
  const fake = createFakeWorkflowStep({ onWait })
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
  return { outcome, names: fake.names, results }
}

describe('claude setup-token through the relay', () => {
  it('URL out, code in, token sealed, the login directory deleted, the token nowhere else', async () => {
    const s = await setup()
    s.sandbox.onProcess(/claude setup-token/, {
      lines: [PROMPT_SCREEN ?? ''],
      waitForFile: `${s.dir}/in`,
      thenLines: [setupTokenSuccessScreen()],
    })
    const responses: string[] = []
    let filesAfterCapture: string[] | null = null
    const watched: LoginDriver = {
      ...claudeLoginDriver,
      capture: async ctx => {
        const captured = await claudeLoginDriver.capture(ctx)
        filesAfterCapture = [...s.sandbox.files.keys()].filter(p => p.startsWith(s.dir))
        return captured
      },
    }
    const { outcome, names, results } = await drive(
      s,
      async () => {
        const row = await reload(s.login)
        expect(row.status).toBe('awaiting_user')
        expect(row.verificationUrl).toMatch(
          /^https:\/\/claude\.com\/cai\/oauth\/authorize\?code=true/
        )
        expect(row.userCode).toBeNull()
        const after = await submitLoginCode(
          db,
          s.cfg,
          s.workflowBinding as unknown as Workflow,
          row,
          CODE
        )
        responses.push(JSON.stringify(after))
        return {}
      },
      watched
    )

    expect(outcome).toEqual({ loginId: s.login.id, status: 'succeeded' })
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

    // The relay ran with setup-token's environment, on the login hosts' allow-list.
    const proc = s.sandbox.processes[0]
    expect(proc?.command).toContain('claude setup-token')
    expect(proc?.opts?.env).toMatchObject({ BROWSER: '/bin/true', IS_SANDBOX: '1', HOME: '/root' })
    expect(s.sandbox.allowedHosts).toEqual(expect.arrayContaining([...CLAUDE_LOGIN_HOSTS]))
    // The capture removed the whole login directory (out held the token) before cleanup ran.
    expect(s.sandbox.commands).toContain(`rm -rf ${s.dir}`)
    expect(filesAfterCapture).toEqual([])
    expect(s.sandbox.destroyed).toBe(true)

    const credential = await getForUser(db, s.f.tenant.id, s.f.user.id, 'claude_code')
    expect(credential).toMatchObject({ kind: 'claude_oauth_token', status: 'active' })
    expect(await openSecret(s.cfg, credential as NonNullable<typeof credential>)).toBe(TOKEN)
    const daysLeft = ((credential?.expiresAt?.getTime() ?? 0) - Date.now()) / 86_400_000
    expect(daysLeft).toBeGreaterThan(364)
    expect(daysLeft).toBeLessThanOrEqual(365)
    expect(credential?.secretSealed).not.toContain(TOKEN)

    const row = await reload(s.login)
    expect(row).toMatchObject({
      status: 'succeeded',
      verificationUrl: null,
      userCode: null,
      codeSealed: null,
    })
    const audit = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.tenantId, s.f.tenant.id),
          eq(auditEvents.action, 'agent_credential.connected')
        )
      )
    for (const where of [
      JSON.stringify(results),
      JSON.stringify(row),
      JSON.stringify(audit),
      JSON.stringify(credential?.metadata),
      ...responses,
    ]) {
      expect(where).not.toContain(TOKEN)
      expect(where).not.toContain('sk-ant-oat01')
    }
    expect(JSON.stringify(results)).not.toContain(CODE)
  })

  it('the code reaches the CLI exactly as pasted, then Enter as its own key press', async () => {
    const s = await setup()
    let input: string | undefined
    s.sandbox.onProcess(/claude setup-token/, {
      lines: [PROMPT_SCREEN ?? ''],
      waitForFile: `${s.dir}/in`,
      thenLines: [setupTokenSuccessScreen()],
    })
    const original = s.sandbox.writeFile.bind(s.sandbox)
    s.sandbox.writeFile = async (path, content) => {
      if (path === `${s.dir}/in`) input = content
      return original(path, content)
    }
    const { outcome } = await drive(s, async () => {
      await submitLoginCode(
        db,
        s.cfg,
        s.workflowBinding as unknown as Workflow,
        await reload(s.login),
        `  ${CODE}  `
      )
      return {}
    })
    expect(outcome.status).toBe('succeeded')
    expect(input).toBe(CODE)
    expect(s.sandbox.commands).toContain(`sleep 0.5; printf '\\r' >> ${s.dir}/in`)
  })

  it('a code Anthropic rejects: the CLI waits for Enter, the login fails with a sentence, no credential', async () => {
    const s = await setup()
    s.sandbox.onProcess(/claude setup-token/, {
      lines: [PROMPT_SCREEN ?? ''],
      waitForFile: `${s.dir}/in`,
      thenLines: [REJECTED_SCREEN ?? ''],
      hang: true,
    })
    const { outcome, names } = await drive(s, async () => {
      await submitLoginCode(
        db,
        s.cfg,
        s.workflowBinding as unknown as Workflow,
        await reload(s.login),
        'wrong#code'
      )
      return {}
    })
    expect(outcome.status).toBe('failed')
    expect(names).not.toContain('capture')
    expect(names.slice(-2)).toEqual(['fail', 'cleanup'])
    const row = await reload(s.login)
    expect(row.status).toBe('failed')
    expect(row.error).toMatch(/Anthropic did not accept that code/)
    expect(await getForUser(db, s.f.tenant.id, s.f.user.id, 'claude_code')).toBeNull()
    expect(s.sandbox.destroyed).toBe(true)
  })

  it('a pasted value that is not `code#state` never reaches the CLI: the login fails', async () => {
    const s = await setup()
    s.sandbox.onProcess(/claude setup-token/, {
      lines: [PROMPT_SCREEN ?? ''],
      waitForFile: `${s.dir}/in`,
      thenLines: [setupTokenSuccessScreen()],
    })
    const { outcome } = await drive(s, async () => {
      await submitLoginCode(
        db,
        s.cfg,
        s.workflowBinding as unknown as Workflow,
        await reload(s.login),
        'half-a-code'
      )
      return {}
    })
    expect(outcome.status).toBe('failed')
    expect((await reload(s.login)).error).toMatch(/# in the middle/)
    expect(await getForUser(db, s.f.tenant.id, s.f.user.id, 'claude_code')).toBeNull()
  })
})

describe('a login sandbox’s egress', () => {
  async function liveLoginSandbox() {
    const s = await setup()
    const sandboxId = `fake-sandbox-login-${crypto.randomUUID()}`
    await db
      .update(agentLogins)
      .set({ sandboxId, status: 'finishing' })
      .where(and(eq(agentLogins.tenantId, s.f.tenant.id), eq(agentLogins.id, s.login.id)))
    return { ...s, sandboxId }
  }

  function recordingUpstream(answer: () => Response) {
    const requests: { url: string; method: string; authorization: string | null; body: string }[] =
      []
    return {
      requests,
      upstream: {
        fetch: async (req: Request) => {
          requests.push({
            url: req.url,
            method: req.method,
            authorization: req.headers.get('authorization'),
            body: await req.text(),
          })
          return answer()
        },
      },
    }
  }

  it('platform.claude.com is registered and passes only the token exchange through, untouched', async () => {
    const s = await liveLoginSandbox()
    expect(Object.keys(SESSION_OUTBOUND_HANDLERS)).toContain('platform.claude.com')
    expect(CLAUDE_LOGIN_PASSTHROUGH['platform.claude.com']).toEqual([
      { method: 'POST', path: '/v1/oauth/token' },
    ])
    const up = recordingUpstream(() => Response.json({ access_token: 'from-anthropic' }))
    const exchange = await handleClaudeLoginHost(
      new Request('https://platform.claude.com/v1/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"grant_type":"authorization_code","code":"c","state":"s"}',
      }),
      s.env,
      { containerId: s.sandboxId },
      up
    )
    expect(exchange.status).toBe(200)
    expect(await exchange.json()).toEqual({ access_token: 'from-anthropic' })
    expect(up.requests).toEqual([
      {
        url: 'https://platform.claude.com/v1/oauth/token',
        method: 'POST',
        authorization: null,
        body: '{"grant_type":"authorization_code","code":"c","state":"s"}',
      },
    ])

    const other = await handleClaudeLoginHost(
      new Request('https://platform.claude.com/v1/messages', { method: 'POST', body: '{}' }),
      s.env,
      { containerId: s.sandboxId },
      up
    )
    expect(other.status).toBe(403)
    expect(up.requests).toHaveLength(1)
  })

  it('a session (or an unknown container) may not reach platform.claude.com at all', async () => {
    const up = recordingUpstream(() => Response.json({}))
    const res = await handleClaudeLoginHost(
      new Request('https://platform.claude.com/v1/oauth/token', { method: 'POST', body: '{}' }),
      createTestEnv(),
      { containerId: 'fake-sandbox-not-a-login' },
      up
    )
    expect(res.status).toBe(403)
    expect(up.requests).toHaveLength(0)
  })

  it('api.anthropic.com: a login reaches its profile with its own token, and nothing else', async () => {
    const s = await liveLoginSandbox()
    const up = recordingUpstream(() => Response.json({ account: { email: 'x@example.test' } }))
    const profile = await handleAnthropic(
      new Request('https://api.anthropic.com/api/oauth/profile', {
        headers: { authorization: 'Bearer the-clis-own-access-token' },
      }),
      s.env,
      { containerId: s.sandboxId },
      up
    )
    expect(profile.status).toBe(200)
    expect(up.requests[0]).toMatchObject({
      url: 'https://api.anthropic.com/api/oauth/profile',
      method: 'GET',
      authorization: 'Bearer the-clis-own-access-token',
    })
    const messages = await handleAnthropic(
      new Request('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: JSON.stringify({ model: 'claude-sonnet-4-5' }),
      }),
      s.env,
      { containerId: s.sandboxId },
      up
    )
    expect(messages.status).toBe(403)
    expect(up.requests).toHaveLength(1)
  })

  it('once the login has ended, its sandbox is nobody', async () => {
    const s = await liveLoginSandbox()
    await db
      .update(agentLogins)
      .set({ status: 'succeeded' })
      .where(and(eq(agentLogins.tenantId, s.f.tenant.id), eq(agentLogins.id, s.login.id)))
    const up = recordingUpstream(() => Response.json({}))
    const res = await handleClaudeLoginHost(
      new Request('https://platform.claude.com/v1/oauth/token', { method: 'POST', body: '{}' }),
      s.env,
      { containerId: s.sandboxId },
      up
    )
    expect(res.status).toBe(403)
    expect(up.requests).toHaveLength(0)
  })
})
