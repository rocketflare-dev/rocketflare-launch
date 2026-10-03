/**
 * Codex's relayed sign-in (§18.22-B) through the login Workflow's step bodies with the REAL driver
 * (`runtimes/codex/login.ts`) over the `FakeSandbox`: the scratch `CODEX_HOME` and runner written,
 * `codex login --device-auth` started, the device URL and code read out of its coloured prompt onto
 * the row, the exit noticed, `auth.json` captured, sealed (plan + account fingerprint as metadata,
 * nothing secret on the row or in a step result) and deleted; and the failures — device code not
 * enabled, a non-zero exit, no `auth.json` — ending in a sentence.
 *
 * The prompt fixture is HAND-WRITTEN from Codex 0.160's `device_code_auth.rs`, not captured.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { SYSTEM_ACTOR } from '@/api/services/launch/audit'
import { getForUser, openSecret } from '@/api/services/sessions/credentials/store'
import { startLogin } from '@/api/services/sessions/logins/service'
import {
  type LoginStepScope,
  loginCaptureStep,
  loginFinishStep,
  loginPromptStep,
  loginSandboxName,
  loginStartStep,
} from '@/api/services/sessions/logins/steps'
import { codexLoginDir } from '@/api/services/sessions/runtimes/codex/login'
import { loadConfig } from '@/config'
import { type AgentLoginRow, agentLogins } from '@/db/schema'
import { createTestTenantWithUser } from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { codexAuthJsonText } from '../helpers/fake-openai'
import type { FakeSandbox } from '../helpers/fake-sandbox'
import { createFakeSessionPorts } from '../helpers/sessions'
import { createTestEnv, RecordingWorkflow } from '../mocks/bindings'

const db = setupTestDatabase()
const cfg = loadConfig(createTestEnv())
const PROMPT = readFileSync(
  path.resolve(__dirname, '../fixtures/codex/login-device-prompt.ansi'),
  'utf8'
)

async function setup() {
  const f = await createTestTenantWithUser(db, 'member')
  const login = await startLogin(db, new RecordingWorkflow() as unknown as Workflow, {
    tenantId: f.tenant.id,
    userId: f.user.id,
    runtime: 'codex',
    actor: { ...SYSTEM_ACTOR },
  })
  const ports = createFakeSessionPorts()
  let t = Date.now()
  const scope: LoginStepScope = {
    db,
    cfg,
    params: { loginId: login.id, tenantId: f.tenant.id },
    sandbox: name => ports.sandbox(name),
    now: () => new Date(t),
    sleep: async ms => {
      t += ms
      await new Promise(resolve => setTimeout(resolve, 0))
    },
  }
  const sandbox = ports.sandbox(loginSandboxName(login.id)) as FakeSandbox
  const dir = codexLoginDir(login.id)
  return { f, login, scope, sandbox, dir }
}

async function reload(login: AgentLoginRow) {
  const [row] = await db
    .select()
    .from(agentLogins)
    .where(and(eq(agentLogins.tenantId, login.tenantId), eq(agentLogins.id, login.id)))
  if (!row) throw new Error('gone')
  return row
}

describe('Codex’s device-code sign-in', () => {
  it('start → prompt (URL + code on the row) → finish → capture (sealed, metadata only, deleted)', async () => {
    const { f, login, scope, sandbox, dir } = await setup()

    expect(await loginStartStep(scope)).toEqual({ go: true })
    expect(sandbox.allowedHosts).toContain('auth.openai.com')
    expect(sandbox.files.get(`${dir}/home/config.toml`)).toContain(
      'cli_auth_credentials_store = "file"'
    )
    expect(sandbox.files.get(`${dir}/run.sh`)).toContain('codex login --device-auth')
    expect(sandbox.processes[0]?.command).toBe(`bash ${dir}/run.sh`)

    // Nothing printed yet: a polling step hands back `waiting` (the Workflow runs another).
    expect(await loginPromptStep(scope)).toEqual({ state: 'waiting' })

    sandbox.files.set(`${dir}/out`, PROMPT)
    expect(await loginPromptStep(scope)).toEqual({ state: 'ready' })
    expect(await reload(login)).toMatchObject({
      status: 'awaiting_user',
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'K7QX-M2PD',
      codeSealed: null,
    })

    // The person types the code at OpenAI; Codex writes auth.json and exits 0.
    const auth = codexAuthJsonText({ plan: 'pro', refreshToken: 'rt_from_device_login' })
    sandbox.files.set(`${dir}/home/auth.json`, auth)
    sandbox.files.set(`${dir}/err`, 'Successfully logged in\n')
    sandbox.files.set(`${dir}/exit`, '0\n')
    expect(await loginFinishStep(scope)).toEqual({ state: 'exited', exitCode: 0 })

    const result = await loginCaptureStep(scope)
    expect(result).toEqual({ ok: true })
    expect(JSON.stringify(result)).not.toContain('rt_from_device_login')
    expect(sandbox.commands).toContain(`rm -rf ${dir}`)

    const stored = await getForUser(db, f.tenant.id, f.user.id, 'codex')
    expect(stored).toMatchObject({ kind: 'codex_chatgpt_auth', status: 'active', expiresAt: null })
    expect(stored?.metadata).toMatchObject({
      plan: 'pro',
      account: expect.stringMatching(/^[0-9a-f]{12}$/),
    })
    expect(JSON.stringify(stored?.metadata)).not.toContain('rt_from_device_login')
    expect(JSON.stringify(stored?.metadata)).not.toContain('acct-fake-0001')
    const secret = await openSecret(cfg, stored as NonNullable<typeof stored>)
    expect(JSON.parse(secret).tokens.refresh_token).toBe('rt_from_device_login')
    expect(JSON.stringify(await reload(login))).not.toContain('rt_from_device_login')
  })

  it('device-code sign-in not enabled: the prompt step fails with where to turn it on', async () => {
    const { scope, sandbox, dir } = await setup()
    await loginStartStep(scope)
    sandbox.files.set(
      `${dir}/err`,
      'Error logging in with device code: device code login is not enabled for this Codex server. Use the browser login or verify the server URL.\n'
    )
    sandbox.files.set(`${dir}/exit`, '1\n')
    await expect(loginPromptStep(scope)).rejects.toThrow(
      /security settings, or ask your workspace admin/
    )
  })

  it('a non-zero exit after the prompt, or no auth.json, fails capture with a sentence — and still deletes the directory', async () => {
    const { scope, sandbox, dir } = await setup()
    await loginStartStep(scope)
    sandbox.files.set(`${dir}/out`, PROMPT)
    await loginPromptStep(scope)
    sandbox.files.set(
      `${dir}/err`,
      'Error logging in with device code: device auth timed out after 15 minutes\n'
    )
    sandbox.files.set(`${dir}/exit`, '1\n')
    expect(await loginFinishStep(scope)).toEqual({ state: 'exited', exitCode: 1 })
    await expect(loginCaptureStep(scope)).rejects.toThrow(/took too long/)
    expect(sandbox.commands).toContain(`rm -rf ${dir}`)

    const again = await setup()
    await loginStartStep(again.scope)
    again.sandbox.files.set(`${again.dir}/exit`, '0\n')
    await expect(loginCaptureStep(again.scope)).rejects.toThrow(/no ChatGPT sign-in/)
  })
})
