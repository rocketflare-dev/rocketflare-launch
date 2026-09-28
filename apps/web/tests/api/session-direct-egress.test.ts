/**
 * The `direct` egress mode (`services/sessions/egress/direct.ts`, `SESSION_SANDBOX_HOST=remote`,
 * development only): with no proxy between a remote container and Anthropic or GitHub, Launch hands
 * the TURN PROCESS the real key, writes a repo-scoped token as the container's git credential (the
 * sealed token the git proxy uses), and the turn meters itself from Claude Code's stream — same
 * ledger as the model proxy — and is killed when its running cost reaches the budget.
 *
 * Neither the key nor the token may reach an event, a command line or the row in clear.
 */
import { usdToMicrocents } from '@launch/shared/launch-sessions'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import {
  DirectEgress,
  GIT_CREDENTIALS_PATH,
  gitCredentialLine,
  ModelKeyMissingError,
} from '@/api/services/sessions/egress/direct'
import { listSessionEvents } from '@/api/services/sessions/event-log'
import type { RepoHostPort, RepoRef } from '@/api/services/sessions/ports'
import { type RunTurnOptions, runTurn } from '@/api/services/sessions/turn'
import { loadConfig } from '@/config'
import { aiUsage, type SessionRow, sessions } from '@/db/schema'
import { setupTestDatabase } from '../helpers/db'
import { claudeStreamJson } from '../helpers/fake-anthropic'
import { createFakeCloud } from '../helpers/fake-cloud'
import { FakeSandbox } from '../helpers/fake-sandbox'
import { createFakeSessionPorts, insertSession, seedSessionApp } from '../helpers/sessions'
import { createTestEnv } from '../mocks/bindings'

const db = setupTestDatabase()

const KEY = 'sk-ant-api03-direct-mode-key-00000000000000'
const TOKEN = `ghs_${'D'.repeat(36)}`
const cfg = loadConfig(createTestEnv({ ANTHROPIC_API_KEY: KEY }))

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 1))
const FAST: RunTurnOptions = { sleep: tick, cancelPollMs: 5, flushMs: 5 }

/** A repo host that mints `TOKEN` and counts how often it was asked. */
function mintingHost() {
  const minted: RepoRef[] = []
  const host: RepoHostPort = {
    gitUpstream: () => 'https://github.com',
    gitAuth: async repo => {
      minted.push(repo)
      return { token: TOKEN, expiresAt: new Date(Date.now() + 60 * 60_000) }
    },
    openPullRequest: () => Promise.reject(new Error('not in this test')),
    getChecks: () => Promise.reject(new Error('not in this test')),
  }
  return { host, minted }
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

describe('DirectEgress', () => {
  it('hands the turn a real key (the credential, else the env secret)', async () => {
    const env = await new DirectEgress(db, cfg, mintingHost().host).turnEnv()
    expect(Object.keys(env)).toEqual(['ANTHROPIC_API_KEY'])
    expect(env.ANTHROPIC_API_KEY).toMatch(/^sk-ant-/)
  })

  it('writes the token as git’s credential, names only the FILE in commands, and seals it on the row', async () => {
    const { row, f } = await readySession()
    const { host, minted } = mintingHost()
    const sandbox = new FakeSandbox({ name: row.id })
    const egress = new DirectEgress(db, cfg, host)

    await egress.prepareGit(sandbox, row)
    expect(sandbox.files.get(GIT_CREDENTIALS_PATH)).toBe(gitCredentialLine(TOKEN))
    expect(gitCredentialLine(TOKEN)).toBe(`https://x-access-token:${TOKEN}@github.com\n`)
    const setup = sandbox.execs.map(e => e.command).join('\n')
    expect(setup).toContain(`chmod 600 '${GIT_CREDENTIALS_PATH}'`)
    expect(setup).toContain('credential.https://github.com.helper')
    expect(setup).not.toContain(TOKEN)
    expect(minted).toEqual([{ owner: f.app.repoOwner, repo: f.app.repoName }])

    // The same sealed token the git proxy uses: not re-minted while it has time left.
    const sealed = await reload(row)
    expect(sealed.githubTokenSealed).toBeTruthy()
    expect(sealed.githubTokenSealed).not.toContain(TOKEN)
    await egress.prepareGit(sandbox, sealed)
    expect(minted).toHaveLength(1)
  })
})

describe('runTurn in the direct mode', () => {
  it('gives the process the key, refreshes git’s credential, and records its own usage', async () => {
    const { row } = await readySession()
    const { host } = mintingHost()
    const ports = createFakeSessionPorts({
      egress: d => new DirectEgress(d, cfg, host),
    }).script(sb =>
      sb.onProcess(
        /claude -p/,
        claudeStreamJson({
          sessionId: 'claude-direct-1',
          text: `Done. (env said ANTHROPIC_API_KEY=${KEY} and ${TOKEN})`,
          usage: { input: 1000, output: 500 },
        })
      )
    )

    const outcome = await runTurn(db, ports, row, FAST)
    expect(outcome.status).toBe('completed')
    const cost = (outcome as { costMicrocents: number }).costMicrocents
    expect(cost).toBeGreaterThan(0)

    const sandbox = ports.sandboxes.get(row.id)
    expect(sandbox?.processes[0]?.opts?.env?.ANTHROPIC_API_KEY).toMatch(/^sk-ant-/)
    expect(sandbox?.files.get(GIT_CREDENTIALS_PATH)).toBe(gitCredentialLine(TOKEN))
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
      egress: d => new DirectEgress(d, cfg, host),
    }).script(sb =>
      sb.onProcess(
        /claude -p/,
        claudeStreamJson({
          sessionId: 'claude-direct-2',
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
        mode: 'direct',
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
