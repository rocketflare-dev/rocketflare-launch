/**
 * The `host` egress mode (`services/sessions/egress/host.ts`, `SESSION_SANDBOX_HOST=remote`,
 * development only): the sandbox host cannot reach Launch's database, so Launch PUSHES its
 * outbound handlers an egress grant — the session's repo, branch, upstream and sealed installation
 * token before git talks to the remote, the key and the policy's model before a turn — and the
 * container gets NOTHING but the placeholder. The turn meters itself from Claude Code's stream
 * (same ledger as the model proxy) and is killed when its running cost reaches the budget.
 *
 * Neither the key nor the token may reach the container, an event, a command line or the row in
 * clear.
 */
import { resolveSessionPolicy, usdToMicrocents } from '@launch/shared/launch-sessions'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { HostEgress } from '@/api/services/sessions/egress/host'
import { listSessionEvents } from '@/api/services/sessions/event-log'
import { MODEL_KEY_PLACEHOLDER, ModelKeyMissingError } from '@/api/services/sessions/model-key'
import type { RepoHostPort, RepoRef } from '@/api/services/sessions/ports'
import type { EgressGrant, HostResult } from '@/api/services/sessions/sandbox-host/protocol'
import { type RunTurnOptions, runTurn, TURN_PID_FILE } from '@/api/services/sessions/turn'
import { loadConfig } from '@/config'
import { aiUsage, type SessionRow, sessions } from '@/db/schema'
import { setupTestDatabase } from '../helpers/db'
import { claudeStreamJson } from '../helpers/fake-anthropic'
import { createFakeCloud } from '../helpers/fake-cloud'
import { FakeSandbox } from '../helpers/fake-sandbox'
import { createFakeSessionPorts, insertSession, seedSessionApp } from '../helpers/sessions'
import { createTestEnv } from '../mocks/bindings'

const db = setupTestDatabase()

const KEY = 'sk-ant-api03-host-mode-key-0000000000000000'
const TOKEN = `ghs_${'H'.repeat(36)}`
const cfg = loadConfig(createTestEnv({ ANTHROPIC_API_KEY: KEY }))

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
  const grants: { name: string; grant: EgressGrant }[] = []
  return {
    grants,
    sink: {
      setEgressGrant: async (name: string, grant: EgressGrant) => {
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
    expect(grants[0]?.grant.model).toBeUndefined()
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

describe('HostEgress.turnEnv', () => {
  it('grants the host the key and the policy’s model, and gives the process only the placeholder', async () => {
    const { row } = await readySession()
    const { sink, grants } = grantSink()
    const env = await new HostEgress(db, cfg, mintingHost().host, sink).turnEnv(
      new FakeSandbox({ name: row.id }),
      row
    )
    expect(env).toEqual({ ANTHROPIC_API_KEY: MODEL_KEY_PLACEHOLDER })
    expect(JSON.stringify(env)).not.toContain(KEY)
    expect(grants).toEqual([
      {
        name: row.id,
        grant: { model: { key: KEY, model: resolveSessionPolicy(row.policy).model } },
      },
    ])
  })

  it('no key configured: ModelKeyMissingError, and nothing is granted', async () => {
    const { row } = await readySession()
    const { sink, grants } = grantSink()
    const noKey = loadConfig(createTestEnv({ ANTHROPIC_API_KEY: undefined }))
    await expect(
      new HostEgress(db, noKey, mintingHost().host, sink).turnEnv(
        new FakeSandbox({ name: row.id }),
        row
      )
    ).rejects.toBeInstanceOf(ModelKeyMissingError)
    expect(grants).toHaveLength(0)
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

    // Both halves were granted before the process started…
    expect(grants.map(g => Object.keys(g.grant))).toEqual([['git'], ['model']])
    // …and the process holds only the placeholder.
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
