// @vitest-isolate
// Mocks `sessionsPaused` (a GLOBAL launch setting another file may be flipping), so this file needs
// its own module registry.
/**
 * D36 K4: a coding session for an app on a kit that is NOT Rocketflare — the meta-kit
 * `rocketflare-dev/launch-kit` (`tests/fixtures/launch-kit-0.1/launch.kit.json`, the app's own
 * `apps.kit_manifest` snapshot) — driven end to end like `session-workflow.test.ts`: the boot runs
 * the kit's `session.install` and `session.bootstrap` (no Rocketflare preload, the database URL only
 * in the environment, the kit's skip and root variables), writes Launch's ports into the
 * `.dev.vars` the kit names, starts `session.devStart`, and the session's `dev` database carries no
 * RLS role and no extension (the kit declares none).
 *
 * And the git proxy of a kit upgrade session: it may fetch its APP's kit repo, not the default
 * kit's — a private kit's fetch authenticated by Launch with a read-only kit token, never the
 * container — locally and through the remote sandbox host's grant.
 */
import { generateKeyPairSync } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { type KitManifest, parseKitManifest } from '@launch/shared/kit-manifest'
import { SESSION_WAKE_EVENT } from '@launch/shared/launch-sessions'
import { and, eq } from 'drizzle-orm'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { deleteKit, insertKit } from '@/api/services/launch/kits/store'
import { WORKSPACE_CHANGED_SCRIPT } from '@/api/services/sessions/checkpoint'
import { NeonSessionDb } from '@/api/services/sessions/db/neon-session-db'
import { handleGitHub } from '@/api/services/sessions/egress/github'
import { HostEgress } from '@/api/services/sessions/egress/host'
import type { SessionStepHooks } from '@/api/services/sessions/hooks'
import {
  DEV_LOG_FILE,
  DEV_PID_FILE,
  NOT_ROOT_PRELOAD,
  SESSION_WORKSPACE,
} from '@/api/services/sessions/kit-dev'
import { GitHubRepoHost } from '@/api/services/sessions/repo/github-repo-host'
import type { EgressGrantUpdate } from '@/api/services/sessions/sandbox-host/protocol'
import { SessionWorkflow } from '@/api/workflows/session'
import { loadConfig } from '@/config'
import { apps, type SessionRow, sessions as sessionsTable } from '@/db/schema'
import { hostedGitHub } from '@/sandbox-host/egress'
import { setupTestDatabase } from '../helpers/db'
import { createFakeCloud, type FakeCloud } from '../helpers/fake-cloud'
import { FakeSandbox } from '../helpers/fake-sandbox'
import { uniqueSlug } from '../helpers/launch-apps'
import {
  createFakeSessionPorts,
  insertSession,
  type SessionAppFixture,
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
const kitIds: string[] = []

afterAll(async () => {
  for (const id of kitIds) await deleteKit(db, id)
})

const launchKit: KitManifest = parseKitManifest(
  readFileSync(new URL('../fixtures/launch-kit-0.1/launch.kit.json', import.meta.url), 'utf8')
)

/** Put the fixture's app on the meta-kit: its own manifest snapshot (and, given, a kit row). */
async function onLaunchKit(f: SessionAppFixture, kitId: string | null = null) {
  await db
    .update(apps)
    .set({ kitManifest: launchKit, kitId })
    .where(and(eq(apps.tenantId, f.tenant.id), eq(apps.id, f.app.id)))
}

async function reload(row: Pick<SessionRow, 'id' | 'tenantId'>) {
  const [latest] = await db
    .select()
    .from(sessionsTable)
    .where(and(eq(sessionsTable.tenantId, row.tenantId), eq(sessionsTable.id, row.id)))
  if (!latest) throw new Error('session vanished')
  return latest
}

describe('SessionWorkflow: a session on the meta-kit boots through its manifest', () => {
  it('runs the kit’s install, bootstrap and dev start, and writes its .dev.vars', async () => {
    const env = createTestEnv()
    const cfg = loadConfig(env)
    const cloud = createFakeCloud()
    const f = await seedSessionApp(db, cloud, { prepared: true })
    await onLaunchKit(f)
    const row = await insertSession(db, f, { status: 'requested', instanceId: undefined })
    const ports = createFakeSessionPorts({
      sessionDb: d =>
        new NeonSessionDb(d, cfg, { fetch: cloud.fetch, sleep: async () => {}, apiKey: NEON_KEY }),
    }).script(sandbox =>
      sandbox
        .onExec(/git init/, { stdout: `base=${BASE_SHA}\nhead=${BASE_SHA}\n` })
        .onExec(/sha256sum/, { stdout: `migrations=${'a'.repeat(64)}\n` })
        .onExec(WORKSPACE_CHANGED_SCRIPT, { stdout: `${BASE_SHA}\nclean\n` })
        .onProcess(/node scripts\/dev\.mjs start/, {
          lines: ['ready'],
          ports: [5173, 8787],
          hang: true,
        })
    )
    const hooks: SessionStepHooks = {
      runTurn: async () => {
        throw new Error('no turn in this test')
      },
      checkpoint: async () => {},
      shipFix: async () => {
        throw new Error('no ship')
      },
      shipSummary: async () => {
        throw new Error('no ship')
      },
      ...UNEXPECTED_LAND_HOOKS,
    }
    const fake = createFakeWorkflowStep({
      onWait: async () => {
        await db
          .update(sessionsTable)
          .set({ requestedAction: 'end' })
          .where(and(eq(sessionsTable.tenantId, row.tenantId), eq(sessionsTable.id, row.id)))
        return { type: SESSION_WAKE_EVENT, payload: {} }
      },
    })
    const workflow = new SessionWorkflow(createExecutionContext(), env)
    workflow.overrides = { ports, hooks }
    const outcome = await workflow.run(
      {
        payload: { sessionId: row.id, tenantId: row.tenantId },
        timestamp: new Date(),
        instanceId: row.id,
        workflowName: 'launch-session',
      },
      fake.step as unknown as Parameters<SessionWorkflow['run']>[1]
    )
    expect(outcome).toEqual({ sessionId: row.id, status: 'ended' })
    expect(fake.names).toContain('bootstrap')
    expect(fake.names).toContain('dev')

    const sandbox = ports.sandbox(row.id) as FakeSandbox
    const install = sandbox.backgroundRuns.find(r => r.name === 'install')
    const bootstrap = sandbox.backgroundRuns.find(r => r.name === 'bootstrap')
    expect(install?.command).toContain('pnpm install --frozen-lockfile --prefer-offline')
    expect(bootstrap?.command).toContain(
      'node scripts/bootstrap.mjs --db-url "$LAUNCH_DB_URL" --driver neon --no-install --no-dev --yes'
    )
    // No Rocketflare preload, flags or stand-ins; the URL only in the environment.
    expect(bootstrap?.command).not.toContain(NOT_ROOT_PRELOAD)
    expect(bootstrap?.command).not.toContain('--offline')
    expect(bootstrap?.command).not.toMatch(/postgres(ql)?:\/\//)
    expect(bootstrap?.opts?.env?.LAUNCH_DB_URL).toMatch(/^postgres(ql)?:\/\//)
    expect(bootstrap?.opts?.env).toMatchObject({
      KIT_ALLOW_ROOT: '1',
      // Branched from a prepared `dev`: no database check either (and never a seed or a migrate
      // skip — Launch's vocabulary has no seed, and a generic kit migrates on every bootstrap).
      KIT_BOOTSTRAP_SKIP: 'install,database',
      DEV_UI_PORT: '5173',
      DEV_API_PORT: '8787',
      DATABASE_DRIVER: 'neon',
    })
    expect(bootstrap?.opts?.env).not.toHaveProperty('LAUNCH_BOOTSTRAP_KEEP')
    // The dev-server keys, in the kit's `.dev.vars`; Rocketflare's proxy switch is not among them.
    const devVars = sandbox.execs.find(e => /dev-vars\.mjs/.test(e.command))
    expect(devVars?.command).toContain(`${SESSION_WORKSPACE}/apps/web/.dev.vars`)
    const written = JSON.parse(devVars?.opts?.env?.LAUNCH_DEV_VARS ?? '{}')
    expect(written).toMatchObject({ DEV_UI_PORT: '5173', DEV_API_PORT: '8787' })
    expect(written).not.toHaveProperty('NEON_LOCAL_PROXY')
    // The kit's own dev start, under Launch's pid and log files; no session wrangler config.
    expect(sandbox.processes[0]?.command).toBe(
      `mkdir -p /workspace/.launch && echo $$ > ${DEV_PID_FILE} && exec sh -c 'node scripts/dev.mjs start' > ${DEV_LOG_FILE} 2>&1`
    )
    expect([...sandbox.files.keys()].some(p => p.includes('session-wrangler'))).toBe(false)

    // `dev` carries no RLS role and no extension: the meta-kit declares neither.
    const dev = cloud.neon.branchNamed(f.neonProjectId, 'dev')
    expect([...(dev?.roles.values() ?? [])].some(r => r.noLogin)).toBe(false)
    expect(cloud.neon.sql.some(s => /CREATE EXTENSION/i.test(s.query))).toBe(false)
    const [app] = await db.select().from(apps).where(eq(apps.id, f.app.id))
    expect(app?.sessionDb?.appRole).toBeUndefined()
    expect((await reload(row)).status).toBe('ended')
  })
})

// ---- the upgrade session's git proxy ------------------------------------------------------------

const KIT_REPO = 'rocketflare-dev/launch-kit'
const kitUrl = (repo: string, path: string) => `https://github.com/${repo}.git/${path}`
const advertise = (repo = KIT_REPO) =>
  new Request(kitUrl(repo, 'info/refs?service=git-upload-pack'), {
    headers: { Authorization: 'Basic c2FuZGJveDpzZWNyZXQ=' },
  })

/** GitHub as git sees it: a private repo answers 401 until it is sent a token. */
function upstream(opts: { private?: boolean } = {}) {
  const seen: { url: string; authorization: string | null }[] = []
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init)
    const authorization = req.headers.get('Authorization')
    seen.push({ url: req.url, authorization })
    if (opts.private && !authorization) return new Response('denied', { status: 401 })
    return new Response('001e# service=git-upload-pack\n0000', { status: 200 })
  }) as typeof globalThis.fetch
  return { seen, fetch }
}

async function upgradeOnKit(cloud: FakeCloud) {
  const f = await seedSessionApp(db, cloud)
  const kit = await insertKit(db, {
    slug: uniqueSlug('kit'),
    name: 'Launch Kit',
    repo: KIT_REPO,
    pin: { tag: '0.2.0', commit: 'b'.repeat(40) },
    manifest: launchKit,
    manifestSource: 'repo',
    contractVersion: '1',
    status: 'verified',
    isDefault: false,
  })
  kitIds.push(kit.id)
  await onLaunchKit(f, kit.id)
  cloud.github.tokens.clear()
  const sandboxId = `fake-sandbox-${crypto.randomUUID()}`
  const row = await insertSession(db, f, { status: 'working', sandboxId, kind: 'upgrade' })
  return { f, row, sandboxId }
}

describe('an upgrade session fetches its app’s kit', () => {
  const env = createTestEnv()
  const cfg = loadConfig(env)
  const { privateKey: APP_PEM } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  })
  const repoHost = (cloud: FakeCloud) => () =>
    new GitHubRepoHost(db, cfg, {
      fetch: cloud.fetch,
      github: {
        auth: { appId: String(cloud.opts.appId), privateKey: APP_PEM },
        installationId: cloud.opts.installationId,
        org: cloud.opts.org,
      },
    })
  const KIT_TOKEN = `ghs_${'K'.repeat(36)}`

  it('the app’s kit repo, not the default kit’s; a public kit with no token minted', async () => {
    const cloud = createFakeCloud()
    const { sandboxId } = await upgradeOnKit(cloud)
    const up = upstream()
    const minted: string[] = []
    const deps = {
      repoHost: repoHost(cloud),
      fetch: up.fetch,
      kitToken: async (_d: unknown, _c: unknown, repo: string) => {
        minted.push(repo)
        return { token: KIT_TOKEN }
      },
    }
    const ok = await handleGitHub(advertise(), env, { containerId: sandboxId }, deps)
    expect(ok.status).toBe(200)
    expect(up.seen.map(s => s.authorization)).toEqual([null])
    expect(minted).toEqual([])
    // The default kit (Rocketflare) is no repo of this session's.
    const other = await handleGitHub(
      advertise('rocketflare-dev/rocketflare'),
      env,
      { containerId: sandboxId },
      deps
    )
    expect(other.status).toBe(403)
  })

  it('a private kit: GitHub’s 401, then the same fetch with Launch’s read-only kit token', async () => {
    const cloud = createFakeCloud()
    const { sandboxId } = await upgradeOnKit(cloud)
    const up = upstream({ private: true })
    const minted: string[] = []
    const res = await handleGitHub(
      advertise(),
      env,
      { containerId: sandboxId },
      {
        repoHost: repoHost(cloud),
        fetch: up.fetch,
        sleep: async () => {},
        kitToken: async (_d, _c, repo) => {
          minted.push(repo)
          return { token: KIT_TOKEN }
        },
      }
    )
    expect(res.status).toBe(200)
    expect(minted).toEqual([KIT_REPO])
    expect(up.seen.map(s => s.authorization)).toEqual([
      null,
      `Basic ${btoa(`x-access-token:${KIT_TOKEN}`)}`,
    ])
    // The sandbox's own Authorization was never forwarded, and the session's token never minted.
    expect(up.seen.some(s => s.authorization === 'Basic c2FuZGJveDpzZWNyZXQ=')).toBe(false)
    expect(cloud.github.tokens.size).toBe(0)
  })

  it('the remote sandbox host: the grant carries the kit and its read-only token', async () => {
    const cloud = createFakeCloud()
    const { row } = await upgradeOnKit(cloud)
    const grants: EgressGrantUpdate[] = []
    const sink = {
      setEgressGrant: async (_name: string, grant: EgressGrantUpdate) => {
        grants.push(grant)
        return { ok: true as const, value: null }
      },
    }
    const host = {
      gitUpstream: () => 'https://github.com',
      gitAuth: async () => ({
        token: `ghs_${'U'.repeat(36)}`,
        expiresAt: new Date(Date.now() + 60 * 60_000),
      }),
    } as unknown as ConstructorParameters<typeof HostEgress>[2]
    const expiresAt = new Date(Date.now() + 60 * 60_000)
    await new HostEgress(db, cfg, host, sink, undefined, async repo => {
      expect(repo).toBe(KIT_REPO)
      return { token: KIT_TOKEN, expiresAt }
    }).prepareGit(new FakeSandbox({ name: row.id }), row)
    const git = grants[0]?.git
    expect(git?.readOnlyRepos).toEqual([
      {
        owner: 'rocketflare-dev',
        repo: 'launch-kit',
        token: KIT_TOKEN,
        expiresAt: expiresAt.getTime(),
      },
    ])
    if (!git) throw new Error('no grant')
    const up = upstream({ private: true })
    const res = await hostedGitHub(
      advertise(),
      async () => ({ git }),
      { containerId: 'do', className: 'HostedSessionSandbox' },
      { fetch: up.fetch, sleep: async () => {} }
    )
    expect(res.status).toBe(200)
    expect(up.seen.map(s => s.authorization)).toEqual([
      null,
      `Basic ${btoa(`x-access-token:${KIT_TOKEN}`)}`,
    ])
  })
})
