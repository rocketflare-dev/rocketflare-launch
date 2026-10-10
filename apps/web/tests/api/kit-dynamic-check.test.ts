// @vitest-isolate
// Installs the FakeCloud as the global fetch and mocks the platform credential and kit stores.
/**
 * A kit's DYNAMIC conformance check (D36 K3, `kits/dynamic-check.ts`) end to end, with the
 * FakeCloud as GitHub and the platform-wide tables in memory (`credential-store.ts`,
 * `kit-store.ts`). The kit is the meta-kit's manifest (`tests/fixtures/launch-kit-0.1/`), PRIVATE in
 * the apps org. The test plays the scaffold job: it calls `/ci/kit-check/token` with an Actions
 * OIDC token for the throwaway repo, pushes a copy, and calls `/ci/kit-check/done`; the queue's
 * `kit.check` phases are run by hand from the recording queue.
 *
 * What it proves: `?dynamic=1` enqueues (the route runs nothing long) and answers `checking`; the
 * `start` phase creates `launch-kit-check-<slug>-<id>`, commits the job generated for THIS kit
 * pointed at `/ci/kit-check`, and dispatches it; the token is issued once, to that repo's
 * `launch-scaffold.yml` on `main` only, with a kit read token narrowed to the kit repo; a good
 * copy makes the kit `verified` and the repo is deleted; a bad copy fails it with its problems; a
 * repo the App may not delete is archived; a failed run ends the check; a re-pin supersedes it and
 * its repo is still removed.
 */
import { generateKeyPairSync } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { JobEnvelope, KitCheckPayload } from '@launch/shared/jobs'
import { type KitDetail, kitDetailSchema } from '@launch/shared/kits'
import { scaffoldTokenResponseSchema } from '@launch/shared/launch-pipeline'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { KIT_CHECK_REPO_PREFIX, runKitCheckJob } from '@/api/services/launch/kits/dynamic-check'
import { loadConfig } from '@/config'
import { auditEvents, type KitRow } from '@/db/schema'
import {
  createTestGlobalAdmin,
  createTestSession,
  createTestTenant,
  linkUserToTenant,
  sessionCookieHeader,
} from '../helpers/auth'
import { storeCredential } from '../helpers/credential-store'
import { setupTestDatabase } from '../helpers/db'
import { createFakeCloud } from '../helpers/fake-cloud'
import { actionsClaims, mintActionsToken } from '../helpers/github-oidc'
import { json, request } from '../helpers/request'
import { createTestEnv, type RecordingQueue, type TestEnv } from '../mocks/bindings'

const store = vi.hoisted(() => ({
  credentials: new Map<string, unknown>(),
  settings: new Map<string, unknown>(),
}))
vi.mock('@/api/services/launch/credentials', async importOriginal =>
  (await import('../helpers/credential-store')).mockCredentialsModule(await importOriginal(), store)
)
const kitStore = vi.hoisted(() => ({
  kits: new Map<string, KitRow>(),
  appCounts: new Map<string, number>(),
}))
vi.mock('@/api/services/launch/kits/store', async importOriginal =>
  (await import('../helpers/kit-store')).mockKitStoreModule(await importOriginal(), kitStore)
)

const db = setupTestDatabase()
const cloud = createFakeCloud()
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
})
const APPS_DOMAIN = 'clewro.com'
const KIT_NAME = 'company-kit'

const fixture = (path: string) =>
  readFileSync(new URL(`../fixtures/launch-kit-0.1/${path}`, import.meta.url), 'utf8')

/** The meta-kit 0.1.0's files Launch's static check reads. */
function kitFiles(): Record<string, string> {
  return {
    'launch.kit.json': fixture('launch.kit.json'),
    'package.json': '{ "name": "launch-kit", "version": "0.1.0" }\n',
    'scripts/init.mjs': '// init\n',
    'CLAUDE.md': '# Launch Kit\n',
    '.github/workflows/ci.yml': fixture('.github/workflows/ci.yml'),
    '.github/workflows/deploy.yml': fixture('.github/workflows/deploy.yml'),
    'apps/web/wrangler.toml': fixture('apps/web/wrangler.toml'),
    'apps/web/wrangler.staging.toml': fixture('apps/web/wrangler.staging.toml'),
  }
}

/** What the scaffold job would push: the kit initialised as `kit-check`, the manifest stamped. */
function copyFiles(commit: string, slug = 'kit-check'): Record<string, string | null> {
  const rename = (t: string) =>
    t.replaceAll('launch-kit.dev', APPS_DOMAIN).replaceAll('launch-kit', slug)
  return {
    '.launch-app.json': JSON.stringify({
      app: { slug: 'kit-check', display: 'Kit check', domain: APPS_DOMAIN },
      kit: { id: 'launch-kit', version: '0.1.0', commit },
    }),
    'apps/web/wrangler.toml': rename(fixture('apps/web/wrangler.toml')),
    'apps/web/wrangler.staging.toml': rename(fixture('apps/web/wrangler.staging.toml')),
    '.github/workflows/launch-scaffold.yml': null,
    '.launch/scaffold.mjs': null,
  }
}

let restoreFetch: () => void
let admin: { cookie: Record<string, string>; tenantId: string }
let release: string

beforeAll(async () => {
  restoreFetch = cloud.install()
  cloud.github.seedRepo(cloud.opts.org, KIT_NAME, kitFiles())
  release = cloud.github.tag(cloud.opts.org, KIT_NAME, '0.1.0')
  store.settings.set('apps_domain', APPS_DOMAIN)
  store.settings.set('github_org', cloud.opts.org)
  storeCredential(
    store,
    'github_app',
    { appId: String(cloud.opts.appId), privateKey },
    { installationId: cloud.opts.installationId }
  )
  const user = await createTestGlobalAdmin(db)
  const tenant = await createTestTenant(db)
  await linkUserToTenant(db, user.id, tenant.id, 'owner')
  admin = {
    cookie: sessionCookieHeader(await createTestSession(db, user.id, tenant.id)),
    tenantId: tenant.id,
  }
})
afterAll(() => restoreFetch())

let env: TestEnv
beforeEach(() => {
  kitStore.kits.clear()
  env = createTestEnv()
})

const queue = () => env.JOBS_QUEUE as unknown as RecordingQueue<JobEnvelope>

/** The `kit.check` messages enqueued since the last take, and their delays. */
function take(): { payload: KitCheckPayload; delaySeconds?: number }[] {
  const out = queue()
    .messages.filter(m => m.body.type === 'kit.check')
    .map(m => ({
      payload: (m.body as Extract<JobEnvelope, { type: 'kit.check' }>).payload,
      delaySeconds: (m.options as { delaySeconds?: number } | undefined)?.delaySeconds,
    }))
  queue().clear()
  return out
}

async function runPhase(payload: KitCheckPayload) {
  await runKitCheckJob({ db, cfg: loadConfig(env), queue: env.JOBS_QUEUE }, payload)
}

function kitsCall(path: string, method: string, body?: unknown) {
  return request(
    `/api/platform/kits${path}`,
    { method, headers: admin.cookie },
    { env, ...(body === undefined ? {} : { json: body }) }
  )
}

async function addDynamic(): Promise<KitDetail> {
  const res = await kitsCall('?dynamic=1', 'POST', {
    repo: `${cloud.opts.org}/${KIT_NAME}`,
    pin: { kind: 'tag', tag: '0.1.0' },
  })
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(201)
  return kitDetailSchema.parse(await json(res))
}

async function show(slug: string): Promise<KitDetail> {
  return kitDetailSchema.parse(await json(await kitsCall(`/${slug}`, 'GET')))
}

/** Start a check and run its `start` phase: the throwaway repo, dispatched. */
async function started() {
  const kit = await addDynamic()
  const [start] = take()
  if (!start) throw new Error('nothing was enqueued')
  await runPhase(start.payload)
  const repoName = `${KIT_CHECK_REPO_PREFIX}${kit.slug}-${start.payload.checkId.slice(0, 8)}`
  const repo = cloud.github.repo(cloud.opts.org, repoName)
  if (!repo) throw new Error(`no repo ${repoName}`)
  return { kit, checkId: start.payload.checkId, repoName, repo, next: take() }
}

function jobToken(repoName: string, repoId: number, over: Record<string, string> = {}) {
  return mintActionsToken(
    actionsClaims({
      repository: `${cloud.opts.org}/${repoName}`,
      repositoryId: String(repoId),
      workflowFile: 'launch-scaffold.yml',
      runId: '7770001',
      ...over,
    })
  )
}

function ci(path: 'token' | 'done', token: string, body: unknown = {}) {
  return request(
    `/ci/kit-check/${path}`,
    { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
    { env, json: body }
  )
}

/** Play the job: the token, a pushed copy, done → the `finish` phase it enqueued, run. */
async function playJob(s: Awaited<ReturnType<typeof started>>, files = copyFiles(release)) {
  const token = await jobToken(s.repoName, s.repo.id)
  const res = await ci('token', token)
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(200)
  const grant = scaffoldTokenResponseSchema.parse(await json(res))
  const sha = cloud.github.pushCommit(cloud.opts.org, s.repoName, files)
  expect((await ci('done', token, { commit: sha })).status).toBe(200)
  const [finish] = take()
  expect(finish?.payload.phase).toBe('finish')
  if (finish) await runPhase(finish.payload)
  return { grant, sha }
}

describe('a dynamic check of a private meta-kit fork', () => {
  it('runs the kit in a throwaway repo, passes, and deletes the repo', async () => {
    const s = await started()
    // The route only enqueued; the kit answers checking.
    expect(s.kit).toMatchObject({ status: 'checking', dynamicCheck: { status: 'queued' } })
    // The start phase: the repo exists, private, with the job generated for THIS kit.
    expect(s.repo.private).toBe(true)
    const script = cloud.github.readFile(cloud.opts.org, s.repoName, '.launch/scaffold.mjs') ?? ''
    expect(script).toContain('const LAUNCH_ENDPOINT = "/ci/kit-check"')
    expect(script).toContain('"id": "launch-kit"')
    expect(cloud.github.runs.map(r => [r.repo, r.workflow])).toContainEqual([
      s.repoName,
      'launch-scaffold.yml',
    ])
    expect(s.next).toEqual([
      { payload: expect.objectContaining({ phase: 'poll' }), delaySeconds: 60 },
    ])
    expect((await show(s.kit.slug)).dynamicCheck).toMatchObject({
      status: 'running',
      repo: `${cloud.opts.org}/${s.repoName}`,
    })

    const { grant } = await playJob(s)
    // The plan: the kit at its pin, as the app `kit-check`; a read token for the kit repo alone.
    expect(grant.plan).toMatchObject({
      slug: 'kit-check',
      repo: `${cloud.opts.org}/${s.repoName}`,
      kitRepo: `${cloud.opts.org}/${KIT_NAME}`,
      tag: '0.1.0',
      commit: release,
      kitId: 'launch-kit',
    })
    expect(cloud.github.tokens.get(grant.token)).toMatchObject({
      repositories: [s.repoName],
      permissions: { contents: 'write', workflows: 'write' },
    })
    expect(cloud.github.tokens.get(grant.kitToken ?? '')).toMatchObject({
      repositories: [KIT_NAME],
      permissions: { contents: 'read' },
    })

    const after = await show(s.kit.slug)
    expect(after).toMatchObject({
      status: 'verified',
      problems: [],
      dynamicCheck: { status: 'passed', cleanup: 'deleted', problems: [] },
    })
    expect(cloud.github.repo(cloud.opts.org, s.repoName)).toBeUndefined()
    const [audit] = (
      await db
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.tenantId, admin.tenantId), eq(auditEvents.targetId, s.kit.id)))
    ).filter(r => r.action === 'kit.checked' && r.summary.after?.dynamic)
    expect(audit?.summary.after).toMatchObject({
      status: 'verified',
      dynamic: { status: 'passed', cleanup: 'deleted' },
    })
    const tokenAudits = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.tenantId, admin.tenantId),
          eq(auditEvents.action, 'kit.check_token_issued')
        )
      )
    expect(JSON.stringify(tokenAudits)).not.toContain(grant.token)
    expect(JSON.stringify(tokenAudits)).not.toContain(grant.kitToken ?? '-')
  })

  it('issues the token once, and only to that repo’s scaffold workflow on main', async () => {
    const s = await started()
    const refused: Record<string, string>[] = [
      { workflowFile: 'ci.yml' },
      { ref: 'refs/heads/feature' },
    ]
    for (const over of refused) {
      const res = await ci('token', await jobToken(s.repoName, s.repo.id, over))
      expect(res.status).toBe(403)
      expect(await json(res)).toMatchObject({ code: 'ci_caller_refused' })
    }
    const other = await mintActionsToken(
      actionsClaims({
        repository: `${cloud.opts.org}/someone-else`,
        repositoryId: '424242',
        workflowFile: 'launch-scaffold.yml',
      })
    )
    expect((await ci('token', other)).status).toBe(403)
    expect((await ci('token', await jobToken(s.repoName, s.repo.id))).status).toBe(200)
    const again = await ci('token', await jobToken(s.repoName, s.repo.id))
    expect(again.status).toBe(409)
    expect(await json(again)).toMatchObject({ code: 'scaffold_token_unavailable' })
  })

  it('a copy that is not the app it was asked for fails the kit, with why', async () => {
    const s = await started()
    await playJob(s, copyFiles('d'.repeat(40), 'wrong-name'))
    const after = await show(s.kit.slug)
    expect(after.status).toBe('failed')
    expect(after.dynamicCheck).toMatchObject({ status: 'failed', cleanup: 'deleted' })
    expect(after.problems.every(p => p.startsWith('Dynamic check: '))).toBe(true)
    expect(after.problems.join('\n')).toContain(`says kit commit ${'d'.repeat(40)}, not ${release}`)
    expect(after.problems.join('\n')).toMatch(/wrong-name/)
  })

  it('archives the repo when the App may not delete it', async () => {
    const s = await started()
    cloud.failNext(
      ({ method, url }) =>
        method === 'DELETE' && url.endsWith(`/repos/${cloud.opts.org}/${s.repoName}`),
      403,
      { message: 'Must have admin rights to Repository.' }
    )
    await playJob(s)
    expect((await show(s.kit.slug)).dynamicCheck).toMatchObject({
      status: 'passed',
      cleanup: 'archived',
    })
    expect(cloud.github.repo(cloud.opts.org, s.repoName)?.archived).toBe(true)
  })

  it('a run that fails ends the check at the next poll', async () => {
    const s = await started()
    const run = cloud.github.runs.find(r => r.repo === s.repoName)
    if (!run) throw new Error('no run')
    run.status = 'completed'
    run.conclusion = 'failure'
    const [poll] = s.next
    if (!poll) throw new Error('no poll')
    await runPhase(poll.payload)
    const after = await show(s.kit.slug)
    expect(after.status).toBe('failed')
    expect(after.dynamicCheck?.problems[0]).toMatch(/the scaffold job failed/)
    expect(cloud.github.repo(cloud.opts.org, s.repoName)).toBeUndefined()
    expect(take()).toEqual([])
  })

  it('a re-pin supersedes the check: nothing recorded, the repo still removed', async () => {
    const s = await started()
    const res = await kitsCall(`/${s.kit.slug}/pin`, 'PUT', { kind: 'tag', tag: '0.1.0' })
    expect(res.status).toBe(200)
    expect(kitDetailSchema.parse(await json(res)).dynamicCheck ?? null).toBeNull()
    const [poll] = s.next
    if (!poll) throw new Error('no poll')
    await runPhase(poll.payload)
    expect(cloud.github.repo(cloud.opts.org, s.repoName)).toBeUndefined()
    expect((await show(s.kit.slug)).dynamicCheck ?? null).toBeNull()
    // And the job, should it still call, is refused: the check is no longer running.
    expect((await ci('token', await jobToken(s.repoName, s.repo.id))).status).toBe(403)
  })

  it('without ?dynamic, a check is static only; a failed dynamic result at the pin still counts', async () => {
    const s = await started()
    const run = cloud.github.runs.find(r => r.repo === s.repoName)
    if (run) {
      run.status = 'completed'
      run.conclusion = 'failure'
    }
    if (s.next[0]) await runPhase(s.next[0].payload)
    const res = await kitsCall(`/${s.kit.slug}/check`, 'POST')
    expect(res.status).toBe(200)
    const after = kitDetailSchema.parse(await json(res))
    expect(after.status).toBe('failed')
    expect(after.problems[0]).toMatch(/^Dynamic check: the scaffold job failed/)
    expect(take()).toEqual([])
  })
})
