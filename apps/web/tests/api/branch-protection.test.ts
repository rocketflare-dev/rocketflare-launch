// @vitest-isolate
// Installs a FakeCloud as the global fetch and mocks the platform credential store.
/**
 * Issue #5 (`docs/plans/i5-ship-to-staging.md` §1.13): Launch's `launch` ruleset and the
 * branch-protection diagnosis.
 *
 * - `GET /api/apps/:id/branch-protection` (members) → `ok | none | blocks | unavailable | unknown`
 *   from the rulesets that apply to the default branch (with `current_user_can_bypass`, GitHub's
 *   answer for the App's own token) plus classic protection.
 * - `POST` (admins, `manage App`) creates — or, by name, rewrites — the ruleset: `pull_request`
 *   (0 reviews), `required_status_checks` (`Gate`), `non_fast_forward`, `deletion`, the App an
 *   `Integration` bypass actor `always`. Audited `app.branch_protection.applied`. Classic
 *   protection is never written: it stays `blocks`. A plan without rulesets is 409.
 * - Under the ruleset the App's own direct push (the release bump) still lands.
 * - Issue #10: the same GET reports the repo's `LAUNCH_GATE_APP_ID` variable (`missing | wrong |
 *   ok`) and Apply sets it to the App id — only when it differs, and even on a plan without
 *   rulesets.
 */
import {
  appBranchProtectionSchema,
  KIT_REQUIRED_CHECK,
  LAUNCH_GATE_APP_ID_VARIABLE,
} from '@launch/shared/launch-apps'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { commitFiles } from '@/api/services/launch/github-app'
import { auditEvents } from '@/db/schema'
import {
  createTestSession,
  createTestTenantWithUser,
  createTestUser,
  linkUserToTenant,
  sessionCookieHeader,
} from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import {
  type DeployableApp,
  fillDeployCredentials,
  seedDeployableApp,
} from '../helpers/deploy-gateway'
import { createFakeCloud } from '../helpers/fake-cloud'
import { forgetApps } from '../helpers/launch-apps'
import { json, request } from '../helpers/request'
import { createTestEnv, type TestEnv } from '../mocks/bindings'

const store = vi.hoisted(() => ({
  credentials: new Map<string, unknown>(),
  settings: new Map<string, unknown>(),
}))
vi.mock('@/api/services/launch/credentials', async importOriginal =>
  (await import('../helpers/credential-store')).mockCredentialsModule(await importOriginal(), store)
)

const db = setupTestDatabase()
const cloud = createFakeCloud()
let restore: () => void
let env: TestEnv
const tenantIds: string[] = []

beforeAll(() => {
  restore = cloud.install()
})
afterAll(async () => {
  restore()
  await forgetApps(db, tenantIds)
})
beforeEach(() => {
  env = createTestEnv()
  fillDeployCredentials(store, cloud)
})

type Headers = Record<string, string>

async function fixture() {
  const { user, tenant } = await createTestTenantWithUser(db, 'owner')
  tenantIds.push(tenant.id)
  const admin = sessionCookieHeader(await createTestSession(db, user.id, tenant.id))
  const memberUser = await createTestUser(db)
  await linkUserToTenant(db, memberUser.id, tenant.id, 'member')
  const member = sessionCookieHeader(await createTestSession(db, memberUser.id, tenant.id))
  const seeded = await seedDeployableApp(db, cloud, tenant.id)
  const owner = seeded.app.repoOwner as string
  const repo = seeded.app.repoName as string
  return { tenantId: tenant.id, adminId: user.id, admin, member, seeded, owner, repo }
}

function read(seeded: DeployableApp, headers: Headers) {
  return request(`/api/apps/${seeded.app.id}/branch-protection`, { headers }, { env })
}

function apply(seeded: DeployableApp, headers: Headers) {
  return request(
    `/api/apps/${seeded.app.id}/branch-protection`,
    { method: 'POST', headers },
    { env }
  )
}

async function state(seeded: DeployableApp, headers: Headers) {
  const res = await read(seeded, headers)
  expect(res.status, await res.clone().text()).toBe(200)
  return appBranchProtectionSchema.parse(await res.json())
}

function gateVarOf(owner: string, repo: string) {
  return cloud.github.repo(owner, repo)?.variables.get(LAUNCH_GATE_APP_ID_VARIABLE)
}

const gateVariableOk = () => ({
  state: 'ok',
  value: String(cloud.opts.appId),
  expected: String(cloud.opts.appId),
  detail: null,
})

function rulesetsOf(owner: string, repo: string) {
  return cloud.github.rulesets.get(`${owner}/${repo}`.toLowerCase()) ?? []
}

function variableWrites(owner: string, repo: string) {
  return cloud.calls.filter(
    c =>
      c.vendor === 'github' &&
      c.method !== 'GET' &&
      c.path.toLowerCase().startsWith(`/repos/${owner}/${repo}/actions/variables`.toLowerCase())
  )
}

async function applied(tenantId: string, appId: string) {
  return db
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.tenantId, tenantId),
        eq(auditEvents.appId, appId),
        eq(auditEvents.action, 'app.branch_protection.applied')
      )
    )
}

describe('GET /api/apps/:id/branch-protection', () => {
  it('none: nothing requires Gate on a fresh repository', async () => {
    const { seeded, member } = await fixture()
    const body = await state(seeded, member)
    expect(body).toMatchObject({
      state: 'none',
      requiredChecks: [],
      appCanBypass: true,
      rulesetId: null,
    })
    expect(body.detail).toContain(KIT_REQUIRED_CHECK)
  })

  it('ok: a ruleset the App may bypass requires Gate (not necessarily Launch’s own)', async () => {
    const { seeded, member, owner, repo } = await fixture()
    cloud.github.protect(owner, repo, {
      requiredChecks: [KIT_REQUIRED_CHECK, 'lint'],
      bypassAppId: cloud.opts.appId,
    })
    expect(await state(seeded, member)).toMatchObject({
      state: 'ok',
      requiredChecks: [KIT_REQUIRED_CHECK, 'lint'],
      appCanBypass: true,
      rulesetId: null,
      detail: null,
    })
  })

  it('blocks: a ruleset the App may not bypass, naming it', async () => {
    const { seeded, member, owner, repo } = await fixture()
    cloud.github.protect(owner, repo, { requiredChecks: ['ci'], name: 'org-policy' })
    const body = await state(seeded, member)
    expect(body).toMatchObject({ state: 'blocks', appCanBypass: false, requiredChecks: ['ci'] })
    expect(body.detail).toContain('org-policy')
  })

  it('blocks: classic protection, which no App bypasses', async () => {
    const { seeded, member, owner, repo } = await fixture()
    cloud.github.protect(owner, repo, { requiredChecks: [KIT_REQUIRED_CHECK], classic: true })
    const body = await state(seeded, member)
    expect(body).toMatchObject({
      state: 'blocks',
      appCanBypass: false,
      requiredChecks: [KIT_REQUIRED_CHECK],
    })
    expect(body.detail).toMatch(/classic branch protection/)
  })

  it('ignores a ruleset that is not active', async () => {
    const { seeded, member, owner, repo } = await fixture()
    const ruleset = cloud.github.protect(owner, repo, { requiredChecks: ['ci'] })
    if (ruleset) ruleset.enforcement = 'evaluate'
    expect((await state(seeded, member)).state).toBe('none')
  })

  it('unavailable: the plan has no rulesets on this repo', async () => {
    const { seeded, member, owner, repo } = await fixture()
    cloud.github.disableRulesets(owner, repo)
    const body = await state(seeded, member)
    expect(body).toMatchObject({ state: 'unavailable', rulesetId: null })
    expect(body.detail).toMatch(/GitHub Team/)
  })

  it('unknown: GitHub cannot be asked (no App in Setup)', async () => {
    const { seeded, member } = await fixture()
    store.credentials.clear()
    const body = await state(seeded, member)
    expect(body).toMatchObject({ state: 'unknown', appCanBypass: false, gateVariable: null })
    expect(body.detail).toMatch(/GitHub App/)
  })

  it('gateVariable: missing on a fresh repo, wrong when another id, ok when the App’s', async () => {
    const { seeded, member, owner, repo } = await fixture()
    const missing = (await state(seeded, member)).gateVariable
    expect(missing).toMatchObject({
      state: 'missing',
      value: null,
      expected: String(cloud.opts.appId),
    })
    expect(missing?.detail).toContain(LAUNCH_GATE_APP_ID_VARIABLE)

    const variables = cloud.github.repo(owner, repo)?.variables
    variables?.set(LAUNCH_GATE_APP_ID_VARIABLE, '999')
    const wrong = (await state(seeded, member)).gateVariable
    expect(wrong).toMatchObject({ state: 'wrong', value: '999' })
    expect(wrong?.detail).toContain(String(cloud.opts.appId))

    variables?.set(LAUNCH_GATE_APP_ID_VARIABLE, String(cloud.opts.appId))
    expect((await state(seeded, member)).gateVariable).toEqual(gateVariableOk())
  })

  it('gateVariable is reported on a plan without rulesets too', async () => {
    const { seeded, member, owner, repo } = await fixture()
    cloud.github.disableRulesets(owner, repo)
    expect((await state(seeded, member)).gateVariable?.state).toBe('missing')
  })

  it('401 without a session; another organisation’s app is 404', async () => {
    const { seeded } = await fixture()
    expect((await read(seeded, {})).status).toBe(401)
    const other = await fixture()
    const res = await read(seeded, other.admin)
    expect(res.status).toBe(404)
    expect(await json(res)).toMatchObject({ statusCode: 404, code: 'app_not_found' })
  })
})

describe('POST /api/apps/:id/branch-protection', () => {
  it('creates Launch’s ruleset, answers ok, audits it — and the App’s bump still lands', async () => {
    const { tenantId, adminId, seeded, admin, member, owner, repo } = await fixture()
    const res = await apply(seeded, admin)
    expect(res.status, await res.clone().text()).toBe(200)
    const body = appBranchProtectionSchema.parse(await res.json())
    const [ruleset] = rulesetsOf(owner, repo)
    expect(body).toEqual({
      state: 'ok',
      requiredChecks: [KIT_REQUIRED_CHECK],
      appCanBypass: true,
      rulesetId: ruleset?.id,
      detail: null,
      gateVariable: gateVariableOk(),
    })
    // Issue #10: the kit's `verified` job trusts launch/gate from this App id only.
    expect(gateVarOf(owner, repo)).toBe(String(cloud.opts.appId))
    expect(ruleset).toMatchObject({
      name: 'launch',
      target: 'branch',
      enforcement: 'active',
      bypass_actors: [
        { actor_id: cloud.opts.appId, actor_type: 'Integration', bypass_mode: 'always' },
      ],
      conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
    })
    expect(ruleset?.rules.map(r => r.type)).toEqual([
      'pull_request',
      'required_status_checks',
      'non_fast_forward',
      'deletion',
    ])
    expect(ruleset?.rules[0]?.parameters).toMatchObject({ required_approving_review_count: 0 })
    expect(ruleset?.rules[1]?.parameters).toMatchObject({
      required_status_checks: [{ context: KIT_REQUIRED_CHECK }],
    })
    expect(await state(seeded, member)).toEqual(body)

    const [audit] = await applied(tenantId, seeded.app.id)
    expect(audit).toMatchObject({
      actorUserId: adminId,
      targetType: 'App',
      targetId: seeded.app.id,
      summary: {
        before: { rulesetId: null },
        after: {
          rulesetId: ruleset?.id,
          requiredChecks: [KIT_REQUIRED_CHECK],
          bypassAppId: cloud.opts.appId,
          state: 'ok',
          gateVariable: 'created',
        },
      },
    })

    // The release bump is the App's own direct push to `main`: the bypass lets it through.
    const token = cloud.github.issueToken().token
    await expect(
      commitFiles(token, owner, repo, 'main', [{ path: 'package.json', content: '{}\n' }], 'bump')
    ).resolves.toBeTruthy()
  })

  it('is idempotent by name, and puts back an edited `launch` ruleset', async () => {
    const { tenantId, seeded, admin, owner, repo } = await fixture()
    expect((await apply(seeded, admin)).status).toBe(200)
    const [first] = rulesetsOf(owner, repo)
    if (!first) throw new Error('no ruleset')
    first.enforcement = 'disabled'
    first.bypass_actors = []
    const again = appBranchProtectionSchema.parse(await (await apply(seeded, admin)).json())
    expect(rulesetsOf(owner, repo)).toHaveLength(1)
    expect(again).toMatchObject({ state: 'ok', rulesetId: first.id })
    expect(rulesetsOf(owner, repo)[0]).toMatchObject({
      enforcement: 'active',
      bypass_actors: [{ actor_id: cloud.opts.appId }],
    })
    const audits = await applied(tenantId, seeded.app.id)
    expect(audits.map(a => (a.summary as { before: unknown }).before)).toContainEqual({
      rulesetId: first.id,
    })
    // The variable already held the App id: the second Apply only read it.
    const after = audits.map(a => (a.summary as { after: { gateVariable: string } }).after)
    expect(after.map(a => a.gateVariable).sort()).toEqual(['created', 'unchanged'])
  })

  it('puts a wrong LAUNCH_GATE_APP_ID back to the App id, and writes nothing when it is right', async () => {
    const { seeded, admin, owner, repo } = await fixture()
    cloud.github.repo(owner, repo)?.variables.set(LAUNCH_GATE_APP_ID_VARIABLE, '42')
    const body = appBranchProtectionSchema.parse(await (await apply(seeded, admin)).json())
    expect(body.gateVariable).toEqual(gateVariableOk())
    expect(gateVarOf(owner, repo)).toBe(String(cloud.opts.appId))

    const writesBefore = variableWrites(owner, repo)
    expect(writesBefore).toHaveLength(1)
    expect((await apply(seeded, admin)).status).toBe(200)
    expect(variableWrites(owner, repo)).toHaveLength(1)
  })

  it('never touches classic protection: the ruleset is added and the answer stays blocks', async () => {
    const { seeded, admin, owner, repo } = await fixture()
    cloud.github.protect(owner, repo, { requiredChecks: ['ci'], classic: true })
    const res = await apply(seeded, admin)
    expect(res.status).toBe(200)
    const body = appBranchProtectionSchema.parse(await res.json())
    expect(body.state).toBe('blocks')
    expect(body.rulesetId).toBe(rulesetsOf(owner, repo)[0]?.id)
    expect(cloud.github.classicProtection.get(`${owner}/${repo}`.toLowerCase())).toEqual({
      branch: 'main',
      requiredChecks: ['ci'],
    })
    const writes = cloud.calls.filter(
      c => c.vendor === 'github' && c.method !== 'GET' && c.path.includes('/protection')
    )
    expect(writes).toEqual([])
  })

  it('409 rulesets_unavailable on a plan without them, and nothing audited', async () => {
    const { tenantId, seeded, admin, owner, repo } = await fixture()
    cloud.github.disableRulesets(owner, repo)
    const res = await apply(seeded, admin)
    expect(res.status).toBe(409)
    expect(await json(res)).toMatchObject({ statusCode: 409, code: 'rulesets_unavailable' })
    expect(await applied(tenantId, seeded.app.id)).toEqual([])
    // The variable is set first, so a plan without rulesets still has it.
    expect(gateVarOf(owner, repo)).toBe(String(cloud.opts.appId))
  })

  it('is the admins’: a member is 403, another organisation 404, no session 401', async () => {
    const { seeded, member, owner, repo } = await fixture()
    const refused = await apply(seeded, member)
    expect(refused.status).toBe(403)
    expect(await json(refused)).toMatchObject({ statusCode: 403 })
    expect((await apply(seeded, {})).status).toBe(401)
    const other = await fixture()
    expect((await apply(seeded, other.admin)).status).toBe(404)
    expect(rulesetsOf(owner, repo)).toEqual([])
    expect(gateVarOf(owner, repo)).toBeUndefined()
  })
})
