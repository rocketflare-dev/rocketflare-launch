/**
 * The `host` egress mode (`services/sessions/egress/host.ts`, a session on the remote sandbox host,
 * development only): the sandbox host cannot reach Launch's database, so Launch PUSHES its
 * outbound handlers an egress grant — the session's repo, branch, upstream and sealed installation
 * token before git talks to the remote, the key and the policy's model before a turn — and the
 * container gets NOTHING but the placeholder. The turn meters itself from Claude Code's stream
 * (same ledger as the model proxy) and is killed when its running cost reaches the budget.
 *
 * Neither the key nor the token may reach the container, an event, a command line or the row in
 * clear.
 */
import {
  DEFAULT_SESSION_POLICY,
  resolveSessionPolicy,
  usdToMicrocents,
} from '@launch/shared/launch-sessions'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { CredentialNeedsLoginError } from '@/api/services/sessions/credentials/errors'
import { createSessionCredentialPort } from '@/api/services/sessions/credentials/lease'
import { claim } from '@/api/services/sessions/credentials/store'
import { HostEgress } from '@/api/services/sessions/egress/host'
import { listSessionEvents } from '@/api/services/sessions/event-log'
import {
  MODEL_KEY_PLACEHOLDER,
  ModelKeyMissingError,
  resolveOpenAiKey,
} from '@/api/services/sessions/model-key'
import type { RepoHostPort, RepoRef } from '@/api/services/sessions/ports'
import { CODEX_AUTH_PATH } from '@/api/services/sessions/runtimes/codex/config'
import type { EgressGrantUpdate, HostResult } from '@/api/services/sessions/sandbox-host/protocol'
import { type RunTurnOptions, runTurn, TURN_PID_FILE } from '@/api/services/sessions/turn'
import { loadConfig } from '@/config'
import { aiUsage, type SessionRow, sessions } from '@/db/schema'
import { setupTestDatabase } from '../helpers/db'
import { claudeStreamJson } from '../helpers/fake-anthropic'
import { createFakeCloud } from '../helpers/fake-cloud'
import { codexAuthJsonText, codexExecJson } from '../helpers/fake-openai'
import { FakeSandbox } from '../helpers/fake-sandbox'
import {
  createFakeSessionPorts,
  insertSession,
  seedAgentCredential,
  seedSessionApp,
} from '../helpers/sessions'
import { createTestEnv } from '../mocks/bindings'

const db = setupTestDatabase()

const KEY = 'sk-ant-api03-host-mode-key-0000000000000000'
const TOKEN = `ghs_${'H'.repeat(36)}`
const SUB_TOKEN = 'sk-ant-oat01-host-mode-subscription-token-sentinel'
const OPENAI_KEY = 'sk-proj-host-mode-openai-key-000000000000000'
const CODEX_MODEL = 'gpt-6.1-sol'
const CODEX_POLICY = { ...DEFAULT_SESSION_POLICY, model: CODEX_MODEL }
const THREAD = '0199a213-81c0-7800-8aa1-bbab2a035a53'
const cfg = loadConfig(createTestEnv({ ANTHROPIC_API_KEY: KEY }))
const openAiCfg = loadConfig(createTestEnv({ ANTHROPIC_API_KEY: KEY, OPENAI_API_KEY: OPENAI_KEY }))

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 1))
const FAST: RunTurnOptions = { sleep: tick, cancelPollMs: 5, flushMs: 5 }

/** A repo host that mints `TOKEN` (valid an hour from `now`) and counts how often it was asked. */
function mintingHost(now: () => Date = () => new Date()) {
  const minted: RepoRef[] = []
  const host: RepoHostPort = {
    gitUpstream: () => 'https://github.com',
    gitAuth: async repo => {
      minted.push(repo)
      return { token: TOKEN, expiresAt: new Date(now().getTime() + 60 * 60_000) }
    },
    openPullRequest: () => Promise.reject(new Error('not in this test')),
    getChecks: () => Promise.reject(new Error('not in this test')),
    getPullRequest: () => Promise.reject(new Error('not in this test')),
    mergePullRequest: () => Promise.reject(new Error('not in this test')),
    failedCheckLog: () => Promise.reject(new Error('not in this test')),
  }
  return { host, minted }
}

/** The host's `setEgressGrant`, recording each grant by sandbox name. */
function grantSink(answer: HostResult<null> = { ok: true, value: null }) {
  const grants: { name: string; grant: EgressGrantUpdate }[] = []
  return {
    grants,
    sink: {
      setEgressGrant: async (name: string, grant: EgressGrantUpdate) => {
        grants.push({ name, grant })
        return answer
      },
    },
  }
}

async function readySession(overrides: Parameters<typeof insertSession>[2] = {}) {
  const f = await seedSessionApp(db, createFakeCloud())
  const row = await insertSession(db, f, {
    status: 'ready',
    pendingMessage: 'Change the Home heading',
    ...overrides,
  })
  return { f, row }
}

/** A Claude Code session on its creator's subscription (`credentialSource: 'user'`). */
async function subscriptionSession(
  opts: {
    credential?: Parameters<typeof seedAgentCredential>[2]
    session?: Parameters<typeof insertSession>[2]
  } = {}
) {
  const f = await seedSessionApp(db, createFakeCloud())
  const { row: credential } = await seedAgentCredential(db, f, {
    secret: SUB_TOKEN,
    ...opts.credential,
  })
  const row = await insertSession(db, f, {
    status: 'ready',
    pendingMessage: 'go',
    credentialSource: 'user',
    agentCredentialId: credential.id,
    ...opts.session,
  })
  return { f, row, credential }
}

/** A Codex session on its creator's ChatGPT plan. */
async function planSession() {
  const f = await seedSessionApp(db, createFakeCloud())
  const { row: credential } = await seedAgentCredential(db, f, {
    runtime: 'codex',
    secret: codexAuthJsonText(),
  })
  const row = await insertSession(db, f, {
    status: 'ready',
    runtime: 'codex',
    policy: CODEX_POLICY,
    credentialSource: 'user',
    agentCredentialId: credential.id,
    pendingMessage: 'go',
  })
  return { f, row, credential }
}

async function reload(row: SessionRow): Promise<SessionRow> {
  const [latest] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.tenantId, row.tenantId), eq(sessions.id, row.id)))
  if (!latest) throw new Error('gone')
  return latest
}

describe('HostEgress.prepareGit', () => {
  it('grants the host the repo, branch, upstream and token — and puts nothing in the container', async () => {
    const { row, f } = await readySession()
    const { host, minted } = mintingHost()
    const { sink, grants } = grantSink()
    const sandbox = new FakeSandbox({ name: row.id })

    await new HostEgress(db, cfg, host, sink).prepareGit(sandbox, row)

    expect(grants).toHaveLength(1)
    expect(grants[0]?.name).toBe(row.id)
    const git = grants[0]?.grant.git
    expect(git).toMatchObject({
      owner: f.app.repoOwner,
      repo: f.app.repoName,
      branch: row.branch,
      upstream: 'https://github.com',
      token: TOKEN,
    })
    expect(git?.expiresAt).toBeGreaterThan(Date.now() + 50 * 60_000)
    expect(grants[0]?.grant.anthropic).toBeUndefined()
    expect(minted).toEqual([{ owner: f.app.repoOwner, repo: f.app.repoName }])

    // Nothing credential-shaped was written into or run in the container.
    expect(sandbox.files.size).toBe(0)
    expect(sandbox.execs).toHaveLength(0)

    // The same sealed token the git proxy uses, sealed on the row.
    const sealed = await reload(row)
    expect(sealed.githubTokenSealed).toBeTruthy()
    expect(sealed.githubTokenSealed).not.toContain(TOKEN)
  })

  it('reuses the sealed token while it has 10 minutes left, and re-mints it after', async () => {
    const { row } = await readySession()
    let clock = new Date()
    const now = () => clock
    const { host, minted } = mintingHost(now)
    const { sink, grants } = grantSink()
    const egress = new HostEgress(db, cfg, host, sink, now)
    const sandbox = new FakeSandbox({ name: row.id })

    await egress.prepareGit(sandbox, row)
    await egress.prepareGit(sandbox, await reload(row))
    expect(minted).toHaveLength(1)

    // 55 minutes on: 5 left, under the 10-minute margin.
    clock = new Date(clock.getTime() + 55 * 60_000)
    await egress.prepareGit(sandbox, await reload(row))
    expect(minted).toHaveLength(2)
    expect(grants).toHaveLength(3)
    expect(grants[2]?.grant.git?.expiresAt).toBe(clock.getTime() + 60 * 60_000)
  })

  it('a host that refuses the grant fails the call by its error', async () => {
    const { row } = await readySession()
    const { sink } = grantSink({ ok: false, error: { name: 'Error', message: 'Not a sandbox' } })
    await expect(
      new HostEgress(db, cfg, mintingHost().host, sink).prepareGit(
        new FakeSandbox({ name: row.id }),
        row
      )
    ).rejects.toThrow('Not a sandbox')
  })
})

describe('HostEgress.turnEnv — the grant per runtime × credential source', () => {
  const turnEnvOf = async (row: SessionRow, config = cfg) => {
    const { sink, grants } = grantSink()
    const env = await new HostEgress(db, config, mintingHost().host, sink).turnEnv(
      new FakeSandbox({ name: row.id }),
      row
    )
    return { env, grants }
  }

  it('Claude Code × platform: Launch’s key as `api_key`; NO environment (the runtime’s own carries the placeholder)', async () => {
    const { row } = await readySession()
    const { env, grants } = await turnEnvOf(row)
    expect(env).toEqual({})
    expect(grants).toEqual([
      {
        name: row.id,
        grant: {
          anthropic: {
            auth: { kind: 'api_key', value: KEY },
            model: resolveSessionPolicy(row.policy).model,
          },
        },
      },
    ])
  })

  it('Claude Code × user: the creator’s subscription token as `oauth` — and no ANTHROPIC_API_KEY that would beat it', async () => {
    const { row } = await subscriptionSession()
    const { env, grants } = await turnEnvOf(row)
    expect(env).toEqual({})
    expect('ANTHROPIC_API_KEY' in env).toBe(false)
    expect(grants[0]?.grant.anthropic).toEqual({
      auth: { kind: 'oauth', value: SUB_TOKEN },
      model: resolveSessionPolicy(row.policy).model,
    })
  })

  it('Claude Code × user with a credential it may not spend: CredentialNeedsLoginError, nothing granted', async () => {
    for (const credential of [
      { status: 'needs_login' as const },
      { expiresAt: new Date(Date.now() - 1000) },
    ]) {
      const { row } = await subscriptionSession({ credential })
      const { sink, grants } = grantSink()
      await expect(
        new HostEgress(db, cfg, mintingHost().host, sink).turnEnv(
          new FakeSandbox({ name: row.id }),
          row
        )
      ).rejects.toBeInstanceOf(CredentialNeedsLoginError)
      expect(grants).toHaveLength(0)
    }
  })

  it('Codex × platform: Launch’s OpenAI key and the Codex model; Codex × user: the model only', async () => {
    const platform = await readySession({ runtime: 'codex', policy: CODEX_POLICY })
    const keyed = await turnEnvOf(platform.row, openAiCfg)
    expect(keyed.env).toEqual({})
    // The same key the OpenAI proxy would swap in (a sealed credential, else the secret).
    const launchKey = (await resolveOpenAiKey(db, openAiCfg))?.apiKey
    expect(launchKey).toBeTruthy()
    expect(keyed.grants[0]?.grant).toEqual({ openai: { key: launchKey, model: CODEX_MODEL } })

    const plan = await planSession()
    const user = await turnEnvOf(plan.row, openAiCfg)
    expect(user.env).toEqual({})
    expect(user.grants[0]?.grant).toEqual({ chatgpt: { model: CODEX_MODEL } })
  })

  it('no key configured: ModelKeyMissingError naming the provider, and nothing is granted', async () => {
    const { row } = await readySession()
    const { sink, grants } = grantSink()
    const noKey = loadConfig(createTestEnv({ ANTHROPIC_API_KEY: undefined }))
    await expect(
      new HostEgress(db, noKey, mintingHost().host, sink).turnEnv(
        new FakeSandbox({ name: row.id }),
        row
      )
    ).rejects.toThrow('Launch has no Anthropic key configured')
    const codex = await readySession({ runtime: 'codex', policy: CODEX_POLICY })
    await expect(
      new HostEgress(db, cfg, mintingHost().host, sink).turnEnv(
        new FakeSandbox({ name: codex.row.id }),
        codex.row
      )
    ).rejects.toThrow('Launch has no OpenAI key configured')
    expect(grants).toHaveLength(0)
  })

  it('endTurn revokes a ChatGPT plan’s part and nothing else; prepareLogin grants a sign-in', async () => {
    const plan = await planSession()
    const { sink, grants } = grantSink()
    const egress = new HostEgress(db, cfg, mintingHost().host, sink)
    const sandbox = new FakeSandbox({ name: plan.row.id })
    await egress.endTurn(sandbox, plan.row)
    const { row: claude } = await readySession()
    await egress.endTurn(new FakeSandbox({ name: claude.id }), claude)
    await egress.prepareLogin(new FakeSandbox({ name: 'login-x' }), 'codex')
    expect(grants).toEqual([
      { name: plan.row.id, grant: { chatgpt: null } },
      { name: 'login-x', grant: { login: { runtime: 'codex' } } },
    ])
  })
})

describe('runTurn in the host mode', () => {
  it('grants git and the model, gives the process the placeholder, and records its own usage', async () => {
    const { row } = await readySession()
    const { host } = mintingHost()
    const { sink, grants } = grantSink()
    const ports = createFakeSessionPorts({
      egress: d => new HostEgress(d, cfg, host, sink),
    }).script(sb =>
      sb.onProcess(
        /claude -p/,
        claudeStreamJson({
          sessionId: 'claude-host-1',
          text: `Done. (the repo mentioned ${KEY} and ${TOKEN})`,
          usage: { input: 1000, output: 500 },
        })
      )
    )

    const outcome = await runTurn(db, ports, row, FAST)
    expect(outcome.status).toBe('completed')
    const cost = (outcome as { costMicrocents: number }).costMicrocents
    expect(cost).toBeGreaterThan(0)

    // Both parts were granted before the process started…
    expect(grants.map(g => Object.keys(g.grant))).toEqual([['git'], ['anthropic']])
    // …and the process holds only the placeholder (from Claude Code's own environment).
    const sandbox = ports.sandboxes.get(row.id)
    const env = sandbox?.processes[0]?.opts?.env ?? {}
    expect(env.ANTHROPIC_API_KEY).toBe(MODEL_KEY_PLACEHOLDER)
    expect(JSON.stringify(env)).not.toContain(KEY)
    expect(JSON.stringify(env)).not.toContain(TOKEN)
    expect(sandbox?.processes[0]?.command).not.toContain(TOKEN)

    // One ledger row, and the running total moved by exactly it (the proxy's rule).
    const rows = await db.select().from(aiUsage).where(eq(aiUsage.sessionId, row.id))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      feature: 'session',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      inputTokens: 1000,
      outputTokens: 500,
    })
    expect(rows[0]?.costMicrocents).toBe(cost)
    expect((await reload(row)).costMicrocents).toBe(cost)

    // Neither secret lands in the transcript.
    const events = JSON.stringify(await listSessionEvents(db, row.tenantId, row.id))
    expect(events).not.toContain(KEY)
    expect(events).not.toContain(TOKEN)
    expect(events).toContain('turn.end')
  })

  it('kills a turn whose running cost reaches the budget, says why, and still records what it spent', async () => {
    const cap = usdToMicrocents(10)
    const { row } = await readySession({ costMicrocents: cap - 1 })
    const { host } = mintingHost()
    const ports = createFakeSessionPorts({
      egress: d => new HostEgress(d, cfg, host, grantSink().sink),
    }).script(sb =>
      sb.onProcess(
        /claude -p/,
        claudeStreamJson({
          sessionId: 'claude-host-2',
          tools: [{ name: 'Bash', input: { command: 'pnpm test' }, result: 'ok' }],
          usage: { input: 5000, output: 2000 },
          hang: true,
        })
      )
    )

    const outcome = await runTurn(db, ports, row, FAST)
    expect(outcome.status).toBe('failed')

    const sandbox = ports.sandboxes.get(row.id)
    expect(sandbox?.killed).toHaveLength(1)
    // …and through the pid the turn recorded, because the SDK's kill drops its signal.
    expect(sandbox?.execs.some(e => e.command.includes(TURN_PID_FILE))).toBe(true)
    const events = await listSessionEvents(db, row.tenantId, row.id)
    const types = events.map(e => e.type)
    expect(types).toContain('budget.reached')
    expect(types.at(-1)).toBe('turn.failed')
    expect(events.at(-1)?.data).toMatchObject({ message: expect.stringMatching(/its budget/) })

    const spent = await db.select().from(aiUsage).where(eq(aiUsage.sessionId, row.id))
    expect(spent.length).toBeGreaterThan(0)
    const after = await reload(row)
    expect(after.status).toBe('ready')
    expect(after.costMicrocents).toBeGreaterThanOrEqual(cap)
  })

  it('a missing key fails the turn by name before anything starts', async () => {
    const { row } = await readySession()
    const ports = createFakeSessionPorts({
      egress: {
        mode: 'host',
        prepareGit: async () => {},
        turnEnv: async () => {
          throw new ModelKeyMissingError()
        },
      },
    })
    const outcome = await runTurn(db, ports, row, FAST)
    expect(outcome.status).toBe('failed')
    expect(ports.sandboxes.get(row.id)?.processes ?? []).toHaveLength(0)
    const events = await listSessionEvents(db, row.tenantId, row.id)
    expect(events.at(-1)?.data).toMatchObject({ message: 'Launch has no Anthropic key configured' })
  })
})

describe('runTurn in the host mode — every runtime on either account', () => {
  it('Codex on Launch’s key: the OpenAI key is granted, the process keeps its placeholder, and the turn’s usage is billed as OpenAI', async () => {
    const { row } = await readySession({ runtime: 'codex', policy: CODEX_POLICY })
    const { sink, grants } = grantSink()
    const ports = createFakeSessionPorts({
      egress: d => new HostEgress(d, openAiCfg, mintingHost().host, sink),
    }).script(sb =>
      sb.onProcess(
        /codex exec/,
        codexExecJson({ threadId: THREAD, usage: { input: 1000, cached: 400, output: 50 } })
      )
    )
    const outcome = await runTurn(db, ports, row, FAST)
    expect(outcome.status).toBe('completed')
    expect(grants.map(g => Object.keys(g.grant))).toEqual([['git'], ['openai']])

    const env = ports.sandboxes.get(row.id)?.processes[0]?.opts?.env ?? {}
    expect(env.CODEX_API_KEY).toBe(MODEL_KEY_PLACEHOLDER)
    expect('ANTHROPIC_API_KEY' in env).toBe(false)
    expect(JSON.stringify(env)).not.toContain(OPENAI_KEY)

    // The host forwards unmetered: the turn's own usage is the ledger — provider openai, priced.
    const rows = await db.select().from(aiUsage).where(eq(aiUsage.sessionId, row.id))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      provider: 'openai',
      model: CODEX_MODEL,
      billing: 'metered',
      inputTokens: 600,
      cacheReadTokens: 400,
      outputTokens: 50,
    })
    expect(rows[0]?.costMicrocents).toBeGreaterThan(0)
    expect((await reload(row)).costMicrocents).toBe(rows[0]?.costMicrocents)
  })

  it('Codex on a ChatGPT plan: auth.json leased for the turn, the plan granted for the turn and revoked after it, usage recorded as a subscription', async () => {
    const plan = await planSession()
    const { sink, grants } = grantSink()
    const ports = createFakeSessionPorts({
      egress: d => new HostEgress(d, cfg, mintingHost().host, sink),
      credentials: d => createSessionCredentialPort(d, cfg),
    }).script(sb => sb.onProcess(/codex exec/, codexExecJson({ threadId: THREAD })))
    expect((await runTurn(db, ports, plan.row, FAST)).status).toBe('completed')

    expect(grants.map(g => g.grant)).toEqual([
      expect.objectContaining({ git: expect.anything() }),
      { chatgpt: { model: CODEX_MODEL } },
      { chatgpt: null },
    ])
    const sandbox = ports.sandboxes.get(plan.row.id)
    expect(sandbox?.commands).toContain(`rm -f ${CODEX_AUTH_PATH}`)
    expect(sandbox?.processes[0]?.opts?.env).not.toHaveProperty('CODEX_API_KEY')

    const rows = await db.select().from(aiUsage).where(eq(aiUsage.sessionId, plan.row.id))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ provider: 'openai', billing: 'subscription' })
    expect(rows[0]?.costMicrocents).toBeNull()
    expect((await reload(plan.row)).costMicrocents).toBe(0)
  })

  it('a ChatGPT plan’s part is revoked even when the lease is refused (another session holds it)', async () => {
    const plan = await planSession()
    await claim(db, {
      tenantId: plan.row.tenantId,
      id: plan.credential.id,
      sessionId: crypto.randomUUID(),
      now: new Date(),
    })
    const { sink, grants } = grantSink()
    const ports = createFakeSessionPorts({
      egress: d => new HostEgress(d, cfg, mintingHost().host, sink),
      credentials: d => createSessionCredentialPort(d, cfg),
    })
    expect((await runTurn(db, ports, plan.row, FAST)).status).toBe('failed')
    expect(grants.at(-1)?.grant).toEqual({ chatgpt: null })
    expect(ports.sandboxes.get(plan.row.id)?.processes ?? []).toHaveLength(0)
  })

  it('Claude Code on a subscription: the token is granted as oauth, the CLI runs on the placeholder OAuth token with NO API key, and no money budget applies', async () => {
    // Over the session's money cap: a subscription turn is not stopped for Launch's budget.
    const { row } = await subscriptionSession({
      session: { costMicrocents: usdToMicrocents(10) + 1 },
    })
    const { sink, grants } = grantSink()
    const ports = createFakeSessionPorts({
      egress: d => new HostEgress(d, cfg, mintingHost().host, sink),
      credentials: d => createSessionCredentialPort(d, cfg),
    }).script(sb =>
      sb.onProcess(
        /claude -p/,
        claudeStreamJson({ sessionId: 'claude-sub-1', usage: { input: 100, output: 20 } })
      )
    )
    expect((await runTurn(db, ports, row, FAST)).status).toBe('completed')
    expect(grants[1]?.grant.anthropic?.auth).toEqual({ kind: 'oauth', value: SUB_TOKEN })

    const env = ports.sandboxes.get(row.id)?.processes[0]?.opts?.env ?? {}
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(MODEL_KEY_PLACEHOLDER)
    expect('ANTHROPIC_API_KEY' in env).toBe(false)
    expect(JSON.stringify(env)).not.toContain(SUB_TOKEN)

    const rows = await db.select().from(aiUsage).where(eq(aiUsage.sessionId, row.id))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ provider: 'anthropic', billing: 'subscription' })
    expect(rows[0]?.costMicrocents).toBeNull()
    const events = await listSessionEvents(db, row.tenantId, row.id)
    expect(events.map(e => e.type)).not.toContain('budget.reached')
    expect(JSON.stringify(events)).not.toContain(SUB_TOKEN)
  })

  it('Claude Code on a subscription that needs reconnecting: the turn fails with the sentence before anything starts', async () => {
    const { row } = await subscriptionSession({ credential: { status: 'needs_login' } })
    const ports = createFakeSessionPorts({
      egress: d => new HostEgress(d, cfg, mintingHost().host, grantSink().sink),
      credentials: d => createSessionCredentialPort(d, cfg),
    })
    expect((await runTurn(db, ports, row, FAST)).status).toBe('failed')
    const events = await listSessionEvents(db, row.tenantId, row.id)
    expect(events.at(-1)?.data).toMatchObject({
      message: 'Reconnect your Claude account on the Home page, then send your message again.',
    })
    expect(ports.sandboxes.get(row.id)?.processes ?? []).toHaveLength(0)
  })
})
