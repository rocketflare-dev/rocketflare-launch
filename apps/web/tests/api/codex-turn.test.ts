/**
 * A Codex turn end to end through `runTurn` (§18.22-B) over the `FakeSandbox`:
 *
 * - Launch's account: `$CODEX_HOME` written before the process, the placeholder `CODEX_API_KEY`,
 *   the thread id stored as the resume id, the next turn `resume`s it, and each turn's usage is the
 *   DELTA of Codex's running total (kept in `runtime_state`);
 * - a person's ChatGPT plan, through the REAL lease (`createSessionCredentialPort`): `auth.json`
 *   written for the turn and removed after it, resealed only when Codex rotated it and only when it
 *   is not older than what is stored, a second concurrent turn refused, and the claim released
 *   whatever happened — success, failure, a rollout, a container that no longer answers.
 * - metering, in the `proxied` mode the fakes run: a plan's model calls go to `chatgpt.com`
 *   DIRECTLY (ChatGPT blocks the Workers runtime), so its turn is metered from Codex's own
 *   `turn.completed` delta — one `subscription` row, no cost, no budget; a turn on Launch's key is
 *   metered by the `api.openai.com` proxy alone (`codex-egress.test.ts`), never by the turn too.
 */
import { DEFAULT_SESSION_POLICY, usdToMicrocents } from '@launch/shared/launch-sessions'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { createSessionCredentialPort } from '@/api/services/sessions/credentials/lease'
import {
  claim,
  getById,
  openSecret,
  resealIfVersion,
} from '@/api/services/sessions/credentials/store'
import { listSessionEvents } from '@/api/services/sessions/event-log'
import { MODEL_KEY_PLACEHOLDER } from '@/api/services/sessions/model-key'
import { parseCodexAuthJson } from '@/api/services/sessions/runtimes/codex/auth-json'
import {
  CODEX_AGENTS_PATH,
  CODEX_AUTH_PATH,
  CODEX_CONFIG_PATH,
  CODEX_RULES_PATH,
} from '@/api/services/sessions/runtimes/codex/config'
import { type RunTurnOptions, runTurn } from '@/api/services/sessions/turn'
import { loadConfig } from '@/config'
import { agentCredentials, aiUsage, type SessionRow, sessions } from '@/db/schema'
import { setupTestDatabase } from '../helpers/db'
import { createFakeCloud } from '../helpers/fake-cloud'
import { codexAuthJsonText, codexExecJson } from '../helpers/fake-openai'
import type { FakeSandbox } from '../helpers/fake-sandbox'
import {
  createFakeSessionPorts,
  insertSession,
  seedAgentCredential,
  seedSessionApp,
} from '../helpers/sessions'
import { createTestEnv } from '../mocks/bindings'

const db = setupTestDatabase()
const cfg = loadConfig(createTestEnv())
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 1))
const FAST: RunTurnOptions = { sleep: tick, cancelPollMs: 5, flushMs: 5 }
const THREAD = '0199a213-81c0-7800-8aa1-bbab2a035a53'
const CODEX_POLICY = { ...DEFAULT_SESSION_POLICY, model: 'gpt-6.1-sol' }

async function reload(row: SessionRow): Promise<SessionRow> {
  const [latest] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.tenantId, row.tenantId), eq(sessions.id, row.id)))
  if (!latest) throw new Error('gone')
  return latest
}

async function send(row: SessionRow, message: string) {
  await db
    .update(sessions)
    .set({ status: 'ready', pendingMessage: message })
    .where(and(eq(sessions.tenantId, row.tenantId), eq(sessions.id, row.id)))
}

const turnEnds = async (row: SessionRow) =>
  (await listSessionEvents(db, row.tenantId, row.id)).filter(e => e.type === 'turn.end')

const usageRows = (row: SessionRow) =>
  db
    .select()
    .from(aiUsage)
    .where(and(eq(aiUsage.tenantId, row.tenantId), eq(aiUsage.sessionId, row.id)))

describe('a Codex turn on Launch’s account', () => {
  it('writes $CODEX_HOME, runs exec with the placeholder key, stores the thread, and resumes it next turn', async () => {
    const f = await seedSessionApp(db, createFakeCloud())
    const row = await insertSession(db, f, {
      status: 'ready',
      runtime: 'codex',
      policy: CODEX_POLICY,
      pendingMessage: 'Change the heading',
    })
    const ports = createFakeSessionPorts().script(sb =>
      sb
        .onProcess(
          / resume /,
          codexExecJson({ threadId: THREAD, usage: { input: 2500, cached: 1400, output: 80 } })
        )
        .onProcess(
          /codex exec/,
          codexExecJson({
            threadId: THREAD,
            commands: [{ command: 'ls', output: 'README.md\n' }],
            usage: { input: 1000, cached: 400, output: 50 },
          })
        )
    )
    expect((await runTurn(db, ports, row, FAST)).status).toBe('completed')
    const sandbox = ports.sandbox(row.id) as FakeSandbox

    // The files Codex reads, written before the process started.
    expect(sandbox.files.get(CODEX_CONFIG_PATH)).toContain('model = "gpt-6.1-sol"')
    expect(sandbox.files.get(CODEX_AGENTS_PATH)?.trim().length).toBeGreaterThan(0)
    expect(sandbox.files.has(CODEX_RULES_PATH)).toBe(true)
    expect(sandbox.files.has(CODEX_AUTH_PATH)).toBe(false)

    const first = sandbox.processes[0]
    expect(first?.command).toContain(
      'codex exec --json -s danger-full-access --skip-git-repo-check -m gpt-6.1-sol'
    )
    expect(first?.command).not.toContain('resume')
    expect(first?.opts?.env).toMatchObject({
      CODEX_API_KEY: MODEL_KEY_PLACEHOLDER,
      CODEX_HOME: '/root/.codex',
    })
    expect(first?.opts?.env).not.toHaveProperty('ANTHROPIC_API_KEY')

    const after1 = await reload(row)
    expect(after1.claudeSessionId).toBe(THREAD)
    expect(after1.runtimeState).toMatchObject({
      usage: { threadId: THREAD, inputTokens: 1000, cachedInputTokens: 400, outputTokens: 50 },
    })
    const events = await listSessionEvents(db, row.tenantId, row.id)
    expect(events.map(e => e.type)).toEqual(
      expect.arrayContaining(['tool.start', 'tool.end', 'text', 'turn.end'])
    )
    expect((await turnEnds(row))[0]?.data).toMatchObject({
      usage: { tokensIn: 600, cacheRead: 400, tokensOut: 50 },
    })

    // Turn 2 resumes the thread, and its usage is the difference from turn 1's running total.
    await send(row, 'And the footer')
    expect((await runTurn(db, ports, await reload(row), FAST)).status).toBe('completed')
    const second = sandbox.processes[1]
    expect(second?.command).toContain(`-m gpt-6.1-sol resume ${THREAD} 'And the footer'`)
    expect((await turnEnds(row))[1]?.data).toMatchObject({
      usage: { tokensIn: 1500 - 1000, cacheRead: 1000, tokensOut: 30 },
    })
    expect((await reload(row)).runtimeState).toMatchObject({ usage: { inputTokens: 2500 } })
  })

  it('proxied: the turn records no usage of its own — the api.openai.com proxy meters each call', async () => {
    const f = await seedSessionApp(db, createFakeCloud())
    const row = await insertSession(db, f, {
      status: 'ready',
      runtime: 'codex',
      policy: CODEX_POLICY,
      pendingMessage: 'go',
    })
    const ports = createFakeSessionPorts().script(sb =>
      sb.onProcess(
        /codex exec/,
        codexExecJson({ threadId: THREAD, usage: { input: 1000, cached: 400, output: 50 } })
      )
    )
    expect((await runTurn(db, ports, row, FAST)).status).toBe('completed')
    // The fake container made no model call, so the proxy recorded nothing; nor did the turn.
    expect(await usageRows(row)).toEqual([])
    expect(Number((await reload(row)).costMicrocents)).toBe(0)
  })

  it('a rollout that is gone forgets the thread instead of resuming it', async () => {
    const f = await seedSessionApp(db, createFakeCloud())
    const row = await insertSession(db, f, {
      status: 'ready',
      runtime: 'codex',
      policy: CODEX_POLICY,
      claudeSessionId: THREAD,
      pendingMessage: 'go on',
    })
    const ports = createFakeSessionPorts().script(sb =>
      sb
        .onExec(/find \/root\/.codex\/sessions/, { exitCode: 1 })
        .onProcess(
          /codex exec/,
          codexExecJson({ threadId: '0199a213-0000-7000-8000-000000000001' })
        )
    )
    expect((await runTurn(db, ports, row, FAST)).status).toBe('completed')
    const sandbox = ports.sandbox(row.id) as FakeSandbox
    expect(sandbox.processes[0]?.command).not.toContain('resume')
    expect((await reload(row)).claudeSessionId).toBe('0199a213-0000-7000-8000-000000000001')
  })

  it('a failed turn says why (Codex’s own message) and fails', async () => {
    const f = await seedSessionApp(db, createFakeCloud())
    const row = await insertSession(db, f, {
      status: 'ready',
      runtime: 'codex',
      policy: CODEX_POLICY,
      pendingMessage: 'go',
    })
    const ports = createFakeSessionPorts().script(sb =>
      sb.onProcess(/codex exec/, {
        lines: [
          JSON.stringify({ type: 'thread.started', thread_id: THREAD }),
          JSON.stringify({ type: 'turn.failed', error: { message: 'unexpected status 401' } }),
        ],
        exitCode: 1,
      })
    )
    expect((await runTurn(db, ports, row, FAST)).status).toBe('failed')
    const events = await listSessionEvents(db, row.tenantId, row.id)
    expect(events.find(e => e.type === 'error')?.data).toMatchObject({
      message: 'unexpected status 401',
    })
    expect(events.find(e => e.type === 'turn.failed')?.data).toMatchObject({
      message: expect.stringMatching(/Codex exited with code 1/),
    })
  })
})

// ---- a person's ChatGPT plan --------------------------------------------------------------------

async function planSession(opts: { authJson?: string } = {}) {
  const f = await seedSessionApp(db, createFakeCloud())
  const secret = opts.authJson ?? codexAuthJsonText()
  const { row: credential } = await seedAgentCredential(db, f, { runtime: 'codex', secret })
  const row = await insertSession(db, f, {
    status: 'ready',
    runtime: 'codex',
    policy: CODEX_POLICY,
    credentialSource: 'user',
    agentCredentialId: credential.id,
    pendingMessage: 'go',
  })
  const ports = createFakeSessionPorts({ credentials: d => createSessionCredentialPort(d, cfg) })
  return { f, row, credential, secret, ports }
}

/** Run something inside the turn, the moment Codex starts (Codex rotating its tokens, say). */
function duringTurn(sandbox: FakeSandbox, fn: () => Promise<void> | void) {
  const start = sandbox.startProcess.bind(sandbox)
  sandbox.startProcess = async (command, opts) => {
    const proc = await start(command, opts)
    if (command.includes('codex exec')) await fn()
    return proc
  }
}

const credentialRow = async (tenantId: string, id: string) => {
  const row = await getById(db, tenantId, id)
  if (!row) throw new Error('credential gone')
  return row
}

describe('a Codex turn on a person’s ChatGPT plan', () => {
  it('proxied: the turn is metered from Codex’s own turn.completed delta — one subscription row per turn, no cost, no budget', async () => {
    const { row, ports } = await planSession()
    // Over the session's money cap: a plan's turn is not stopped for Launch's budget.
    await db
      .update(sessions)
      .set({ costMicrocents: usdToMicrocents(CODEX_POLICY.maxSessionUsd) + 1 })
      .where(and(eq(sessions.tenantId, row.tenantId), eq(sessions.id, row.id)))
    const sandbox = ports.sandbox(row.id) as FakeSandbox
    sandbox
      .onProcess(
        / resume /,
        codexExecJson({ threadId: THREAD, usage: { input: 2500, cached: 1400, output: 80 } })
      )
      .onProcess(
        /codex exec/,
        codexExecJson({ threadId: THREAD, usage: { input: 1000, cached: 400, output: 50 } })
      )
    expect((await runTurn(db, ports, await reload(row), FAST)).status).toBe('completed')

    const first = await usageRows(row)
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({
      provider: 'openai',
      model: 'gpt-6.1-sol',
      feature: 'session',
      billing: 'subscription',
      costMicrocents: null,
      inputTokens: 600,
      cacheReadTokens: 400,
      outputTokens: 50,
    })
    const events = await listSessionEvents(db, row.tenantId, row.id)
    expect(events.some(e => e.type === 'budget.reached')).toBe(false)
    expect(Number((await reload(row)).costMicrocents)).toBe(
      usdToMicrocents(CODEX_POLICY.maxSessionUsd) + 1
    )

    // The next turn records only its own delta from the thread's running total.
    await send(row, 'again')
    expect((await runTurn(db, ports, await reload(row), FAST)).status).toBe('completed')
    const both = await usageRows(row)
    expect(both).toHaveLength(2)
    expect(both.map(u => u.inputTokens).sort((a, b) => Number(a) - Number(b))).toEqual([500, 600])
    expect(both.every(u => u.billing === 'subscription' && u.costMicrocents === null)).toBe(true)
  })

  it('auth.json is in $CODEX_HOME for the turn and removed after it; no key in the env; unchanged → no reseal; claim released', async () => {
    const { row, credential, secret, ports } = await planSession()
    const sandbox = ports.sandbox(row.id) as FakeSandbox
    sandbox.onProcess(/codex exec/, codexExecJson({ threadId: THREAD }))
    let seenDuring: string | undefined
    let claimedDuring: string | null = null
    duringTurn(sandbox, async () => {
      seenDuring = sandbox.files.get(CODEX_AUTH_PATH)
      claimedDuring = (await credentialRow(row.tenantId, credential.id)).claimedBySessionId
    })

    expect((await runTurn(db, ports, row, FAST)).status).toBe('completed')
    expect(seenDuring).toBe(secret)
    expect(claimedDuring).toBe(row.id)
    const env = sandbox.processes[0]?.opts?.env ?? {}
    expect(env).not.toHaveProperty('CODEX_API_KEY')
    expect(env).not.toHaveProperty('OPENAI_API_KEY')
    expect(JSON.stringify(env)).not.toContain('rt_fake_refresh_token_0001')
    expect(sandbox.commands).toContain(`rm -f ${CODEX_AUTH_PATH}`)

    const after = await credentialRow(row.tenantId, credential.id)
    expect(after.version).toBe(credential.version)
    expect(after.claimedBySessionId).toBeNull()
    expect(after.lastUsedAt).not.toBeNull()
    // Nothing secret reached the event log.
    const events = JSON.stringify(await listSessionEvents(db, row.tenantId, row.id))
    expect(events).not.toContain('rt_fake_refresh_token_0001')
  })

  it('Codex rotated the tokens during the turn: the new auth.json is resealed (version bumped)', async () => {
    const { row, credential, ports } = await planSession()
    const sandbox = ports.sandbox(row.id) as FakeSandbox
    sandbox.onProcess(/codex exec/, codexExecJson({ threadId: THREAD }))
    const rotated = codexAuthJsonText({
      refreshToken: 'rt_rotated_by_codex',
      lastRefresh: '2026-10-03T09:00:00Z',
    })
    duringTurn(sandbox, () => {
      sandbox.files.set(CODEX_AUTH_PATH, rotated)
    })
    expect((await runTurn(db, ports, row, FAST)).status).toBe('completed')
    const after = await credentialRow(row.tenantId, credential.id)
    expect(after.version).toBe(credential.version + 1)
    expect(parseCodexAuthJson(await openSecret(cfg, after))?.tokens.refresh_token).toBe(
      'rt_rotated_by_codex'
    )
    expect(after.claimedBySessionId).toBeNull()
  })

  it('never overwrites a NEWER stored auth.json (the egress already captured a later rotation)', async () => {
    const { row, credential, ports } = await planSession()
    const sandbox = ports.sandbox(row.id) as FakeSandbox
    sandbox.onProcess(/codex exec/, codexExecJson({ threadId: THREAD }))
    duringTurn(sandbox, async () => {
      // The egress stored a refresh at 10:00…
      await resealIfVersion(db, cfg, {
        tenantId: row.tenantId,
        id: credential.id,
        expectedVersion: credential.version,
        secret: codexAuthJsonText({
          refreshToken: 'rt_newest',
          lastRefresh: '2026-10-03T10:00:00Z',
        }),
      })
      // …while the container holds an older, different one.
      sandbox.files.set(
        CODEX_AUTH_PATH,
        codexAuthJsonText({ refreshToken: 'rt_older', lastRefresh: '2026-10-03T08:00:00Z' })
      )
    })
    expect((await runTurn(db, ports, row, FAST)).status).toBe('completed')
    const after = await credentialRow(row.tenantId, credential.id)
    expect(parseCodexAuthJson(await openSecret(cfg, after))?.tokens.refresh_token).toBe('rt_newest')
    expect(after.version).toBe(credential.version + 1)
  })

  it('a second session’s turn while the plan is in use is refused (busy) and never starts Codex', async () => {
    const { f, row, credential, ports } = await planSession()
    // The holder is another session MID-TURN; an idle holder's claim would be taken over.
    const holder = await insertSession(db, f, {
      status: 'working',
      runtime: 'codex',
      policy: CODEX_POLICY,
      credentialSource: 'user',
      agentCredentialId: credential.id,
    })
    await claim(db, { tenantId: row.tenantId, id: credential.id, sessionId: holder.id })
    expect((await runTurn(db, ports, row, FAST)).status).toBe('failed')
    const events = await listSessionEvents(db, row.tenantId, row.id)
    expect(events.find(e => e.type === 'turn.failed')?.data).toMatchObject({
      message: expect.stringMatching(/in use by another session/),
    })
    expect((ports.sandbox(row.id) as FakeSandbox).processes).toEqual([])
  })

  it('a plan that needs a reconnect fails with a sentence, and nothing is claimed', async () => {
    const { row, credential, ports } = await planSession()
    await db
      .update(agentCredentials)
      .set({ status: 'needs_login' })
      .where(eq(agentCredentials.id, credential.id))
    expect((await runTurn(db, ports, row, FAST)).status).toBe('failed')
    const events = await listSessionEvents(db, row.tenantId, row.id)
    expect(events.find(e => e.type === 'turn.failed')?.data).toMatchObject({
      message: expect.stringMatching(/Reconnect your ChatGPT plan/),
    })
    expect((await credentialRow(row.tenantId, credential.id)).claimedBySessionId).toBeNull()
  })

  it('an auth.json Codex cannot use marks the plan needs_login and releases the claim', async () => {
    const { row, credential, ports } = await planSession({ authJson: '{"not":"auth"}' })
    expect((await runTurn(db, ports, row, FAST)).status).toBe('failed')
    const after = await credentialRow(row.tenantId, credential.id)
    expect(after.status).toBe('needs_login')
    expect(after.claimedBySessionId).toBeNull()
  })

  it('the claim is released after a failed turn', async () => {
    const { row, credential, ports } = await planSession()
    const sandbox = ports.sandbox(row.id) as FakeSandbox
    sandbox.onProcess(/codex exec/, { lines: [], exitCode: 1 })
    expect((await runTurn(db, ports, row, FAST)).status).toBe('failed')
    expect((await credentialRow(row.tenantId, credential.id)).claimedBySessionId).toBeNull()
    expect(sandbox.commands).toContain(`rm -f ${CODEX_AUTH_PATH}`)
  })

  it('the claim is released after a rollout cut the turn off (the container is gone)', async () => {
    const { row, credential, ports } = await planSession()
    const sandbox = ports.sandbox(row.id) as FakeSandbox
    sandbox.onProcess(/codex exec/, codexExecJson({ threadId: THREAD }))
    sandbox.interruptNext()
    const outcome = await runTurn(db, ports, row, FAST)
    expect(outcome.status).toBe('interrupted')
    const after = await credentialRow(row.tenantId, credential.id)
    expect(after.claimedBySessionId).toBeNull()
    expect(after.version).toBe(credential.version)
  })

  it('the claim is released when the container no longer answers at release', async () => {
    const { row, credential, ports } = await planSession()
    const sandbox = ports.sandbox(row.id) as FakeSandbox
    sandbox.onProcess(/codex exec/, codexExecJson({ threadId: THREAD }))
    duringTurn(sandbox, () => {
      sandbox.failNext('readFile', new Error('container unreachable'))
      sandbox.failNext('exec', new Error('container unreachable'))
    })
    expect((await runTurn(db, ports, row, FAST)).status).toBe('completed')
    expect((await credentialRow(row.tenantId, credential.id)).claimedBySessionId).toBeNull()
  })
})
