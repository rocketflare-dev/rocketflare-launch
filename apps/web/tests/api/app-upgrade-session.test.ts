// @vitest-isolate
// Mocks `sessionsPaused` (a GLOBAL launch setting another file may be flipping), so this file needs
// its own module registry.
/**
 * A kit upgrade's coding session (P6 6c) driven through the real `SessionWorkflow`: the real
 * `runTurn` over a `FakeSandbox` whose `claude` prints the fake Anthropic stream-json, the real
 * ship steps (Launch's gate in the sandbox, the test step on a Neon gate branch over the FakeCloud,
 * the PR through the real GitHub repo host), and an "upgrade script" — the turn hook rewrites the
 * checkout's `.rocketflare.json` to the target, as `pnpm kit:upgrade --apply` does on a clean apply.
 *
 * What it proves — the riskiest part of 6c, whether the first turn "ended cleanly":
 * - a turn that ends `LAUNCH-UPGRADE: DONE` with the checkout at the target ships on its own, and
 *   the upgrade moves `running → pr_open` with the PR;
 * - a turn that ends with a QUESTION (no marker), says `STOPPED`, called `AskUserQuestion`, ended
 *   out of turns, or left `.rocketflare.json` behind is NOT shipped: the upgrade `needs_attention`,
 *   the chat says why, and ending the session cancels the upgrade;
 * - a red gate on the auto-ship hands the upgrade to its owner (`needs_attention`);
 * - the decision is made once: `auto_ship` is cleared either way, and an ordinary session never
 *   ships by itself whatever its agent says.
 */
import { generateKeyPairSync } from 'node:crypto'
import { SESSION_WAKE_EVENT, sessionBranchName } from '@launch/shared/launch-sessions'
import { UPGRADE_SESSION_REASONS } from '@launch/shared/launch-upgrades'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { upgradePrompt } from '@/api/services/launch/rocketflare/upgrade-prompt'
import { WORKSPACE_CHANGED_SCRIPT } from '@/api/services/sessions/checkpoint'
import { NeonSessionDb } from '@/api/services/sessions/db/neon-session-db'
import { listSessionEvents } from '@/api/services/sessions/event-log'
import type { SessionStepHooks } from '@/api/services/sessions/hooks'
import { GitHubRepoHost } from '@/api/services/sessions/repo/github-repo-host'
import { runTurn } from '@/api/services/sessions/turn'
import { SessionWorkflow } from '@/api/workflows/session'
import { loadConfig } from '@/config'
import { apps, appUpgrades, auditEvents, type SessionRow, sessions } from '@/db/schema'
import { setupTestDatabase } from '../helpers/db'
import { claudeStreamJson, type FakeClaudeTurn } from '../helpers/fake-anthropic'
import { createFakeCloud, type FakeCloud } from '../helpers/fake-cloud'
import type { FakeSandbox } from '../helpers/fake-sandbox'
import {
  createFakeSessionPorts,
  insertSession,
  type SessionAppFixture,
  scriptKitGate,
  seedSessionApp,
  UNEXPECTED_LAND_HOOKS,
} from '../helpers/sessions'
import { createExecutionContext, createTestEnv } from '../mocks/bindings'
import { createFakeWorkflowStep } from '../mocks/cloudflare-workers'

vi.mock('@/api/services/sessions/lifecycle', async importOriginal => {
  const actual = await importOriginal<typeof import('@/api/services/sessions/lifecycle')>()
  return { ...actual, sessionsPaused: vi.fn(async () => false) }
})

const db = setupTestDatabase()
const NEON_KEY = 'neon-test-key-abcdefghijklmnop'
const BASE_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
const WAKE = { type: SESSION_WAKE_EVENT, payload: {} }
const LIMITS = { endPollMs: 5, commandPollMs: 1, heartbeatMs: 60_000 }
const FROM = '0.16.0'
const TO = '0.16.1'
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 1))
const { privateKey: APP_PEM } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
})

const DONE_TEXT = `Applied kit ${TO}: 41 files, no rejects, left in the working tree for Launch to ship.\n\nLAUNCH-UPGRADE: DONE`

interface HarnessOptions {
  /** The upgrade turn's Claude Code output. */
  turn?: FakeClaudeTurn
  /** What the "upgrade script" leaves `.rocketflare.json` at after the turn (default: the target). */
  manifestAfter?: string
  /** The gate's exit code for every step (default green). */
  gateExit?: number
  /** An ordinary session instead of an upgrade's. */
  ordinary?: boolean
}

interface Harness {
  f: SessionAppFixture
  cloud: FakeCloud
  row: SessionRow
  upgradeId: string | null
  hooks: SessionStepHooks
  ports: ReturnType<typeof createFakeSessionPorts>
  env: ReturnType<typeof createTestEnv>
  sandbox: () => FakeSandbox
}

async function harness(opts: HarnessOptions = {}): Promise<Harness> {
  const env = createTestEnv()
  const cfg = loadConfig(env)
  const cloud = createFakeCloud()
  const f = await seedSessionApp(db, cloud, { prepared: true })
  // `pr` mode: the ship ends at the open PR (the landing is session-land.test.ts's).
  await db
    .update(apps)
    .set({
      templateVersion: FROM,
      shipSettings: { sessionShip: 'pr', review: { mode: 'none', groupIds: [] } },
    })
    .where(eq(apps.id, f.app.id))
  let upgradeId: string | null = null
  if (!opts.ordinary) {
    const [upgrade] = await db
      .insert(appUpgrades)
      .values({
        tenantId: f.tenant.id,
        appId: f.app.id,
        fromVersion: FROM,
        toVersion: TO,
        status: 'running',
        requestedByUserId: f.user.id,
      })
      .returning()
    upgradeId = upgrade?.id ?? null
  }
  const row = await insertSession(db, f, {
    status: 'requested',
    kind: opts.ordinary ? 'session' : 'upgrade',
    upgradeId,
    autoShip: !opts.ordinary,
    title: `Upgrade kit ${FROM} → ${TO}`,
    pendingMessage: upgradePrompt({ from: FROM, to: TO }),
    pendingMessageUserId: f.user.id,
  })
  if (upgradeId) {
    await db.update(appUpgrades).set({ sessionId: row.id }).where(eq(appUpgrades.id, upgradeId))
  }

  // The checkout as the turn leaves it: unchanged until the turn ran, then changed and at the
  // target (or wherever `manifestAfter` says); a checkpoint makes it clean again.
  const checkout = { changed: false, manifest: FROM }
  const branch = sessionBranchName(row.shortId)
  const ports = createFakeSessionPorts({
    sessionDb: d =>
      new NeonSessionDb(d, cfg, { fetch: cloud.fetch, sleep: async () => {}, apiKey: NEON_KEY }),
    repoHost: d =>
      new GitHubRepoHost(d, cfg, {
        fetch: cloud.fetch,
        github: {
          auth: { appId: String(cloud.opts.appId), privateKey: APP_PEM },
          installationId: cloud.opts.installationId,
          org: cloud.opts.org,
        },
      }),
  }).script(sandbox =>
    scriptKitGate(sandbox)
      .onExec(/git init/, { stdout: `base=${BASE_SHA}\nhead=${BASE_SHA}\n` })
      .onExec(/sha256sum/, { stdout: `migrations=${'a'.repeat(64)}\n` })
      .onExec(WORKSPACE_CHANGED_SCRIPT, () => ({
        stdout: `${BASE_SHA}\n${checkout.changed ? 'dirty' : 'clean'}\n`,
      }))
      .onExec(/cat \/workspace\/app\/\.rocketflare\.json/, () => ({
        stdout: JSON.stringify({ kit: { name: 'rocketflare', version: checkout.manifest } }),
      }))
      .onExec(/git -C \/workspace\/app diff --stat/, {
        stdout: ' .rocketflare.json | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n',
      })
      .onProcess(/exec pnpm dev /, { lines: ['ready'], ports: [5173, 8787], hang: true })
      .onProcess(/claude -p/, claudeStreamJson(opts.turn ?? { text: DONE_TEXT }))
      .onBackground(/pnpm (gate )?(lint|typecheck|test)/, {
        exitCode: opts.gateExit ?? 0,
        log: opts.gateExit ? 'error: something broke\n' : 'ok\n',
      })
  )
  const hooks: SessionStepHooks = {
    runTurn: async ctx => {
      const outcome = await runTurn(ctx.db, ctx.ports, ctx.session, {
        realtime: ctx.realtime,
        logger: ctx.logger,
        sleep: tick,
        cancelPollMs: 5,
        flushMs: 5,
        ...(ctx.bootId ? { bootId: ctx.bootId } : {}),
      })
      // The upgrade script: the apply changed the checkout and (last) stamped `.rocketflare.json`.
      checkout.changed = true
      checkout.manifest = opts.manifestAfter ?? TO
      return outcome
    },
    checkpoint: async () => {
      checkout.changed = false
      cloud.github.pushCommit(
        f.repo.owner,
        f.repo.repo,
        { '.rocketflare.json': JSON.stringify({ kit: { version: checkout.manifest } }) },
        `Launch session ${row.shortId}`,
        branch
      )
    },
    shipFix: async ctx => ({
      outcome: 'completed',
      turn: ctx.session.turnCount + 1,
      text: 'Tried.',
    }),
    shipSummary: async () => ({
      title: `Upgrade kit to ${TO}`,
      body: 'Ports the kit release.',
      source: 'fallback',
      diffStat: '',
    }),
    ...UNEXPECTED_LAND_HOOKS,
  }
  return {
    f,
    cloud,
    row,
    upgradeId,
    hooks,
    ports,
    env,
    sandbox: () => ports.sandbox(row.id) as FakeSandbox,
  }
}

/** Run the Workflow; every wait ends the session (what an owner reading "needs attention" might do). */
async function drive(h: Harness) {
  const waits: string[] = []
  const fake = createFakeWorkflowStep({
    onWait: async wait => {
      waits.push(wait.name)
      await db.update(sessions).set({ requestedAction: 'end' }).where(eq(sessions.id, h.row.id))
      return WAKE
    },
  })
  const workflow = new SessionWorkflow(createExecutionContext(), h.env)
  workflow.overrides = { ports: h.ports, hooks: h.hooks, limits: LIMITS }
  const outcome = await workflow.run(
    {
      payload: { sessionId: h.row.id, tenantId: h.row.tenantId },
      timestamp: new Date(),
      instanceId: h.row.id,
      workflowName: 'launch-session',
    },
    fake.step as unknown as Parameters<SessionWorkflow['run']>[1]
  )
  return { outcome, names: fake.names, waits }
}

async function upgradeOf(h: Harness) {
  const [row] = await db
    .select()
    .from(appUpgrades)
    .where(and(eq(appUpgrades.tenantId, h.f.tenant.id), eq(appUpgrades.id, h.upgradeId ?? '')))
  if (!row) throw new Error('upgrade vanished')
  return row
}

async function sessionOf(h: Harness) {
  const [row] = await db.select().from(sessions).where(eq(sessions.id, h.row.id))
  if (!row) throw new Error('session vanished')
  return row
}

/** The `status` events auto-ship wrote, as `[reason, message]`. */
async function decisions(h: Harness) {
  return (await listSessionEvents(db, h.row.tenantId, h.row.id, 0, 5000))
    .filter(e => e.type === 'status')
    .map(e => e.data as { reason?: string; message?: string })
    .filter(d => d.reason?.startsWith('upgrade.'))
    .map(d => [d.reason, d.message] as const)
}

async function upgradeAudit(h: Harness) {
  const rows = await db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.tenantId, h.f.tenant.id), eq(auditEvents.appId, h.f.app.id)))
  return rows
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .map(a => a.action)
    .filter(a => a.startsWith('app.upgrade.'))
}

describe('an upgrade session: a first turn that ended cleanly ships by itself', () => {
  it('ships the turn that ends LAUNCH-UPGRADE: DONE with the checkout at the target; the upgrade is pr_open', async () => {
    const h = await harness()
    const run = await drive(h)

    expect(run.outcome.status).toBe('shipped')
    // No wait between the turn and the ship: nobody clicked anything.
    expect(run.waits).toEqual([])
    const turn = run.names.indexOf('turn#0')
    expect(turn).toBeGreaterThan(0)
    expect(run.names.slice(turn + 1, turn + 3)).toEqual(['inspect#1', 'ship.claim#1'])

    const session = await sessionOf(h)
    expect(session).toMatchObject({ status: 'shipped', autoShip: false, kind: 'upgrade' })
    expect(session.prNumber).toBeGreaterThan(0)
    const upgrade = await upgradeOf(h)
    expect(upgrade).toMatchObject({
      status: 'pr_open',
      prNumber: session.prNumber,
      prUrl: session.prUrl,
      error: null,
    })
    expect(await decisions(h)).toEqual([[UPGRADE_SESSION_REASONS.autoShip, expect.any(String)]])
    expect(await upgradeAudit(h)).toEqual(['app.upgrade.pr_opened'])
    // The checkout was read for the version — the agent's word alone is not enough.
    expect(h.sandbox().commands.some(c => c.includes('cat /workspace/app/.rocketflare.json'))).toBe(
      true
    )
  })
})

describe('an upgrade session: anything else needs its owner', () => {
  const cases: [string, HarnessOptions, RegExp][] = [
    [
      'a turn that ends asking a question',
      {
        turn: {
          text: 'pnpm kit:upgrade exited 6: the analytics plugin does not support 0.16.1. Should I stay on 0.16.0, remove the plugin, or force it?',
        },
      },
      /stopped to ask or explain/,
    ],
    [
      'a turn that says it stopped',
      { turn: { text: 'Two rejects need a person.\n\nLAUNCH-UPGRADE: STOPPED' } },
      /stopped to ask or explain/,
    ],
    [
      'a turn that called AskUserQuestion, whatever it said after',
      {
        turn: {
          tools: [{ name: 'AskUserQuestion', input: { question: 'Go on?' }, isError: true }],
          text: DONE_TEXT,
        },
      },
      /stopped to ask or explain/,
    ],
    [
      'a turn that ran out of turns',
      { turn: { text: DONE_TEXT, subtype: 'error_max_turns' } },
      /error_max_turns/,
    ],
    [
      'a turn whose checkout is still on the old kit',
      { manifestAfter: FROM },
      /\.rocketflare\.json says kit 0\.16\.0, not 0\.16\.1/,
    ],
  ]
  for (const [name, opts, reason] of cases) {
    it(`${name}: needs_attention, no ship, and the chat says why`, async () => {
      const h = await harness(opts)
      const run = await drive(h)

      // Nothing shipped: the loop waited for the owner (who, here, ended it).
      expect(run.names.some(n => n.startsWith('ship.'))).toBe(false)
      expect(run.waits.length).toBeGreaterThan(0)
      const [decision] = await decisions(h)
      expect(decision?.[0]).toBe(UPGRADE_SESSION_REASONS.needsAttention)
      expect(decision?.[1]).toMatch(reason)
      expect((await sessionOf(h)).autoShip).toBe(false)
      // `needs_attention` while it lived; ending it without a PR cancels the upgrade.
      expect(await upgradeAudit(h)).toEqual([
        'app.upgrade.needs_attention',
        'app.upgrade.cancelled',
      ])
      expect(await upgradeOf(h)).toMatchObject({ status: 'cancelled', prNumber: null })
    })
  }

  it('a red gate on the auto-ship opens no PR and hands the upgrade to its owner', async () => {
    const h = await harness({ gateExit: 1 })
    const run = await drive(h)

    expect(run.names).toContain('ship.claim#1')
    expect(run.names.some(n => n.startsWith('ship.settle#'))).toBe(true)
    expect(run.names.some(n => n.startsWith('ship.pr#'))).toBe(false)
    const audit = await upgradeAudit(h)
    expect(audit[0]).toBe('app.upgrade.needs_attention')
    expect(audit.at(-1)).toBe('app.upgrade.cancelled')
    const [needs] = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.tenantId, h.f.tenant.id),
          eq(auditEvents.action, 'app.upgrade.needs_attention'),
          eq(auditEvents.targetId, h.upgradeId ?? '')
        )
      )
    expect(JSON.stringify(needs?.summary)).toMatch(/gate still fails/)
  })

  it('an ordinary session never ships by itself, whatever its agent says', async () => {
    const h = await harness({ ordinary: true })
    const run = await drive(h)
    expect(run.names.some(n => n.startsWith('ship.'))).toBe(false)
    expect(await decisions(h)).toEqual([])
    expect((await sessionOf(h)).status).toBe('ended')
  })
})
