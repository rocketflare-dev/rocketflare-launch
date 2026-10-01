/**
 * Launch P3's vendor additions against the stateful FakeCloud: the Neon branch lifecycle a session
 * rides on (`init_source: schema-only`, endpoints, delete) and GitHub's pull requests plus the two
 * CI reads a ship waits on (check runs and the combined status). Each is asserted on the request
 * it made and the state it left, as `launch-vendors.test.ts` does for P2's. Issue #5 adds the
 * `RepoHostPort` methods a landing calls (`getPullRequest`, `mergePullRequest`,
 * `failedCheckLog`) on both adapters, and the FakeCloud's rulesets and classic protection.
 */
import { generateKeyPairSync } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  commitFiles,
  createOrgRepo,
  createPullRequest,
  createRuleset,
  findOpenPullRequest,
  GitHubApiError,
  getBranchProtection,
  getCombinedStatus,
  getPullRequest,
  getRuleset,
  installationToken,
  listCheckRuns,
  listRulesets,
  updateRuleset,
} from '@/api/services/launch/github-app'
import { isNeonNotFound, NeonApiError, NeonClient } from '@/api/services/launch/neon'
import {
  FAILED_CHECK_LOG_LINES,
  GitHubRepoHost,
  logTail,
} from '@/api/services/sessions/repo/github-repo-host'
import { LocalRepoHost } from '@/api/services/sessions/repo/local-repo-host'
import { loadConfig } from '@/config'
import type { Database } from '@/db/client'
import { createFakeCloud, type FakeCloud } from '../helpers/fake-cloud'
import { createTestEnv } from '../mocks/bindings'

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
})

let cloud: FakeCloud
beforeEach(() => {
  cloud = createFakeCloud()
})

const neon = () =>
  new NeonClient('neon-key-abcdefghijklmnopqrstu', { fetch: cloud.fetch, sleep: async () => {} })

describe('Neon: session branches', () => {
  it('dev is schema-only from main; a session branch of dev inherits its roles; delete is idempotent-by-404', async () => {
    const client = neon()
    const created = await client.createProject({ name: 'shop', regionId: 'aws-us-east-2' })
    const projectId = created.project.id

    const dev = await client.createBranch(projectId, {
      name: 'dev',
      parentId: created.branch.id,
      initSource: 'schema-only',
    })
    expect(cloud.callsTo('neon').at(-1)?.body).toMatchObject({
      branch: { name: 'dev', parent_id: created.branch.id, init_source: 'schema-only' },
      endpoints: [{ type: 'read_write' }],
    })
    expect(dev.branch.init_source).toBe('schema-only')
    expect(cloud.neon.branchNamed(projectId, 'dev')?.init_source).toBe('schema-only')
    await client.createRole(projectId, dev.branch.id, 'session_owner')
    await client.createDatabase(projectId, dev.branch.id, {
      name: 'session_app',
      ownerName: 'session_owner',
    })

    // A session's branch: parent-data from dev, with its own compute.
    const session = await client.createBranch(projectId, {
      name: 'session-abcdefghijkl',
      parentId: dev.branch.id,
    })
    const endpoints = await client.listBranchEndpoints(projectId, session.branch.id)
    expect(endpoints).toEqual([expect.objectContaining({ branch_id: session.branch.id })])
    expect(endpoints[0]?.host).toMatch(/^ep-/)
    expect(
      cloud.neon.branchNamed(projectId, 'session-abcdefghijkl')?.roles.has('session_owner')
    ).toBe(true)

    // dev has a child, so Neon refuses to delete it; the session branch goes, then 404s.
    await expect(client.deleteBranch(projectId, dev.branch.id)).rejects.toThrow(NeonApiError)
    const deleted = await client.deleteBranch(projectId, session.branch.id)
    await client.waitForOperations(projectId, deleted.operations)
    expect(cloud.neon.branchNamed(projectId, 'session-abcdefghijkl')).toBeUndefined()
    expect(
      isNeonNotFound(await client.deleteBranch(projectId, session.branch.id).catch(e => e))
    ).toBe(true)
  })

  it('a branch created with `endpoints: []` has no compute', async () => {
    const client = neon()
    const created = await client.createProject({ name: 'nocompute', regionId: 'aws-us-east-2' })
    const bare = await client.createBranch(created.project.id, { name: 'bare', endpoints: [] })
    expect(bare.endpoints).toEqual([])
    expect(await client.listBranchEndpoints(created.project.id, bare.branch.id)).toEqual([])
  })
})

describe('GitHub: pull requests and CI', () => {
  const org = () => cloud.opts.org
  const opts = () => ({ fetch: cloud.fetch })
  const token = async (
    scope: { repositories?: string[]; permissions?: Record<string, string> } = {}
  ) =>
    (
      await installationToken(
        { appId: String(cloud.opts.appId), privateKey },
        cloud.opts.installationId,
        scope,
        opts()
      )
    ).token

  async function repoWithBranch(name: string) {
    const t = await token()
    await createOrgRepo(t, org(), { name }, opts())
    cloud.github.pushCommit(org(), name, { 'README.md': '# shop\n' })
    const head = cloud.github.pushCommit(
      org(),
      name,
      { 'README.md': '# shop, edited\n' },
      'Edit',
      'session/abcdefghijkl'
    )
    return { t, head }
  }

  it('opens a PR from the session branch, finds it again, and a second one is a 422', async () => {
    const { head } = await repoWithBranch('shop')
    // A token scoped the way a session's is: one repo, contents + pull_requests write.
    const t = await token({
      repositories: ['shop'],
      permissions: { contents: 'write', pull_requests: 'write' },
    })
    const pr = await createPullRequest(
      t,
      org(),
      'shop',
      {
        title: 'Change the heading',
        head: 'session/abcdefghijkl',
        base: 'main',
        body: 'From a session',
      },
      opts()
    )
    expect(pr).toMatchObject({
      number: 1,
      state: 'open',
      head: { ref: 'session/abcdefghijkl', sha: head },
      base: { ref: 'main' },
    })
    expect(pr.html_url).toBe(`https://github.com/${org()}/shop/pull/1`)
    expect(cloud.github.pulls).toEqual([
      expect.objectContaining({ title: 'Change the heading', body: 'From a session' }),
    ])

    expect((await getPullRequest(t, org(), 'shop', 1, opts()))?.number).toBe(1)
    expect(await getPullRequest(t, org(), 'shop', 99, opts())).toBeNull()
    expect(
      (await findOpenPullRequest(t, org(), 'shop', 'session/abcdefghijkl', opts()))?.number
    ).toBe(1)
    expect(await findOpenPullRequest(t, org(), 'shop', 'session/zzzzzzzzzzzz', opts())).toBeNull()

    const again = await createPullRequest(
      t,
      org(),
      'shop',
      { title: 'x', head: 'session/abcdefghijkl', base: 'main' },
      opts()
    ).catch(e => e)
    expect(again).toBeInstanceOf(GitHubApiError)
    expect(again.status).toBe(422)
  })

  it('a token without pull_requests: write cannot open one', async () => {
    await repoWithBranch('shop')
    const t = await token({ permissions: { contents: 'write' } })
    const err = await createPullRequest(
      t,
      org(),
      'shop',
      { title: 'x', head: 'session/abcdefghijkl', base: 'main' },
      opts()
    ).catch(e => e)
    expect(err.status).toBe(403)
  })

  it('reads check runs and the combined status of the head commit', async () => {
    const { t, head } = await repoWithBranch('shop')
    // Nothing reported yet: no check runs, and GitHub's combined status is `pending` with 0.
    expect(await listCheckRuns(t, org(), 'shop', head, opts())).toEqual([])
    expect(await getCombinedStatus(t, org(), 'shop', head, opts())).toMatchObject({
      state: 'pending',
      total_count: 0,
      sha: head,
    })

    cloud.github.setCheckRuns(org(), 'shop', 'session/abcdefghijkl', [
      { name: 'ci / gate', status: 'completed', conclusion: 'success' },
      { name: 'ci / e2e', status: 'in_progress' },
    ])
    cloud.github.setStatuses(org(), 'shop', head, [{ context: 'deploy/preview', state: 'success' }])
    const runs = await listCheckRuns(t, org(), 'shop', head, opts())
    expect(runs.map(r => [r.name, r.status, r.conclusion])).toEqual([
      ['ci / gate', 'completed', 'success'],
      ['ci / e2e', 'in_progress', null],
    ])
    const combined = await getCombinedStatus(t, org(), 'shop', head, opts())
    expect(combined).toMatchObject({ state: 'success', total_count: 1 })
    expect(combined.statuses[0]).toMatchObject({ context: 'deploy/preview', state: 'success' })

    cloud.github.setStatuses(org(), 'shop', head, [
      { context: 'deploy/preview', state: 'success' },
      { context: 'security', state: 'failure' },
    ])
    expect((await getCombinedStatus(t, org(), 'shop', head, opts())).state).toBe('failure')
  })

  it('commits land on the session branch the PR is opened from', async () => {
    const { t } = await repoWithBranch('shop')
    const { sha } = await commitFiles(
      t,
      org(),
      'shop',
      'session/abcdefghijkl',
      [{ path: 'a.txt', content: 'a' }],
      'Session turn 1',
      opts()
    )
    const pr = await createPullRequest(
      t,
      org(),
      'shop',
      { title: 'x', head: 'session/abcdefghijkl', base: 'main' },
      opts()
    )
    expect(pr.head.sha).toBe(sha)
  })
})

// ---- issue #5: what a landing and the branch-protection diagnosis call ----------------------------

describe('GitHub (issue #5): the RepoHostPort additions over the FakeCloud', () => {
  const org = () => cloud.opts.org
  const cfg = loadConfig(createTestEnv())
  const host = () =>
    new GitHubRepoHost({} as Database, cfg, {
      fetch: cloud.fetch,
      github: {
        auth: { appId: String(cloud.opts.appId), privateKey },
        installationId: cloud.opts.installationId,
        org: cloud.opts.org,
      },
    })
  const repo = () => ({ owner: org(), repo: 'shop' })

  /** A repo with `main`, a session branch one commit ahead and an open PR from it. */
  async function openPr() {
    const t = (
      await installationToken(
        { appId: String(cloud.opts.appId), privateKey },
        cloud.opts.installationId,
        {},
        { fetch: cloud.fetch }
      )
    ).token
    await createOrgRepo(t, org(), { name: 'shop' }, { fetch: cloud.fetch })
    cloud.github.pushCommit(org(), 'shop', { 'README.md': '# shop\n' })
    const gateSha = cloud.github.pushCommit(
      org(),
      'shop',
      { 'README.md': '# shop, edited\n' },
      'Edit',
      'session/abcdefghijkl'
    )
    const pr = await host().openPullRequest(repo(), {
      head: 'session/abcdefghijkl',
      base: 'main',
      title: 'Change the heading',
      body: 'From a session',
    })
    return { gateSha, pr }
  }

  const squash = (prNumber: number, sha: string) => ({
    prNumber,
    sha,
    commitTitle: 'Change the heading (#1)',
    commitMessage: 'The heading says hello.\n\nMerged by Launch from session abcdefgh',
  })

  it('getPullRequest reads the PR fresh — its head follows the branch, null when there is none', async () => {
    const { gateSha, pr } = await openPr()
    expect(await host().getPullRequest(repo(), pr.number)).toEqual({
      number: pr.number,
      url: pr.url,
      title: 'Change the heading',
      state: 'open',
      merged: false,
      headSha: gateSha,
      mergeSha: null,
      mergedAt: null,
    })
    const minted = [...cloud.github.tokens.values()].at(-1)
    expect(minted).toMatchObject({ repositories: ['shop'], permissions: { pull_requests: 'read' } })
    const moved = cloud.github.pushCommit(
      org(),
      'shop',
      { 'b.txt': 'b' },
      'More',
      'session/abcdefghijkl'
    )
    expect((await host().getPullRequest(repo(), pr.number))?.headSha).toBe(moved)
    expect(await host().getPullRequest(repo(), 99)).toBeNull()
  })

  it('squash-merges on the gate SHA once; a second merge of the closed PR is refused', async () => {
    const { gateSha, pr } = await openPr()
    const merged = await host().mergePullRequest(repo(), squash(pr.number, gateSha))
    expect(merged).toEqual({ merged: true, sha: expect.any(String) })
    expect(cloud.github.mergeCount(org(), 'shop', pr.number)).toBe(1)
    const [record] = cloud.github.merges
    expect(record).toMatchObject({
      method: 'squash',
      headSha: gateSha,
      title: 'Change the heading (#1)',
      message: expect.stringContaining('Merged by Launch from session abcdefgh'),
    })
    // One commit on main carrying the head's files; the PR closed and merged.
    expect(cloud.github.repo(org(), 'shop')?.refs.get('heads/main')).toBe(record?.sha)
    expect(cloud.github.commits.get(record?.sha ?? '')?.parents).toHaveLength(1)
    expect(cloud.github.readFile(org(), 'shop', 'README.md')).toBe('# shop, edited\n')
    expect(await host().getPullRequest(repo(), pr.number)).toMatchObject({
      state: 'closed',
      merged: true,
      mergeSha: record?.sha,
      mergedAt: expect.any(String),
    })
    // Again: GitHub's 405 on a closed PR is a refusal, never a second merge.
    const again = await host().mergePullRequest(repo(), squash(pr.number, gateSha))
    expect(again).toMatchObject({ merged: false, code: 'refused' })
    expect(cloud.github.mergeCount(org(), 'shop')).toBe(1)
  })

  it('a head that moved after the gate is head_moved (GitHub’s 409), and nothing merges', async () => {
    const { gateSha, pr } = await openPr()
    cloud.github.pushCommit(org(), 'shop', { 'c.txt': 'c' }, 'By hand', 'session/abcdefghijkl')
    const result = await host().mergePullRequest(repo(), squash(pr.number, gateSha))
    expect(result).toEqual({
      merged: false,
      code: 'head_moved',
      message: expect.stringContaining('Head branch was modified'),
    })
    expect(cloud.github.mergeCount(org(), 'shop')).toBe(0)
  })

  it('a required check that is not green refuses the merge (405) with GitHub’s message', async () => {
    const { gateSha, pr } = await openPr()
    cloud.github.protect(org(), 'shop', { requiredChecks: ['Gate'], bypassAppId: cloud.opts.appId })
    cloud.github.setCheckRuns(org(), 'shop', gateSha, [{ name: 'Gate', status: 'in_progress' }])
    expect(await host().mergePullRequest(repo(), squash(pr.number, gateSha))).toEqual({
      merged: false,
      code: 'refused',
      message: 'Required status check "Gate" is expected.',
    })
    cloud.github.setCheckRuns(org(), 'shop', gateSha, [
      { name: 'Gate', status: 'completed', conclusion: 'success' },
    ])
    expect(await host().mergePullRequest(repo(), squash(pr.number, gateSha))).toMatchObject({
      merged: true,
    })
  })

  it('failedCheckLog: the Gate job’s log tail, else annotations, else a failing status; null when green', async () => {
    const { gateSha } = await openPr()
    expect(await host().failedCheckLog(repo(), { headSha: gateSha })).toBeNull()

    const log = Array.from(
      { length: 120 },
      (_, i) => `2026-10-01T10:00:${String(i % 60).padStart(2, '0')}.1234567Z line ${i + 1}`
    ).join('\n')
    const [lint, gate] = cloud.github.setCheckRuns(org(), 'shop', gateSha, [
      { name: 'lint', status: 'completed', conclusion: 'failure' },
      { name: 'Gate', status: 'completed', conclusion: 'failure' },
    ])
    expect(lint?.id).not.toBe(gate?.id)
    cloud.github.setJobLog(org(), 'shop', gate?.id ?? 0, `${log}\n\n`)
    const fromLog = await host().failedCheckLog(repo(), { headSha: gateSha })
    expect(fromLog).toMatchObject({ name: 'Gate', url: expect.stringContaining('/runs/') })
    const lines = fromLog?.logTail?.split('\n') ?? []
    expect(lines).toHaveLength(FAILED_CHECK_LOG_LINES)
    expect(lines[0]).toBe('line 41')
    expect(lines.at(-1)).toBe('line 120')

    // A check from another App has no job log: its annotations stand in.
    cloud.github.setCheckRuns(org(), 'shop', gateSha, [
      {
        name: 'Gate',
        status: 'completed',
        conclusion: 'failure',
        app: 'circleci-checks',
        annotations: [
          {
            path: 'src/a.ts',
            start_line: 3,
            annotation_level: 'failure',
            title: 'TS2322',
            message: 'Type mismatch',
          },
        ],
      },
    ])
    expect(await host().failedCheckLog(repo(), { headSha: gateSha })).toMatchObject({
      name: 'Gate',
      logTail: 'src/a.ts:3 [failure] TS2322: Type mismatch',
    })

    // Only a commit status failed: its name and link, and no log.
    cloud.github.setCheckRuns(org(), 'shop', gateSha, [])
    cloud.github.setStatuses(org(), 'shop', gateSha, [
      { context: 'ci/legacy', state: 'failure', target_url: 'https://ci.example/1' },
    ])
    expect(await host().failedCheckLog(repo(), { headSha: gateSha })).toEqual({
      name: 'ci/legacy',
      url: 'https://ci.example/1',
      logTail: null,
    })
  })

  it('LocalRepoHost: nothing to read, nothing to merge, no failing check', async () => {
    const local = new LocalRepoHost(cfg)
    expect(await local.getPullRequest(repo(), 1)).toBeNull()
    expect(await local.mergePullRequest(repo(), squash(1, 'abc'))).toMatchObject({
      merged: false,
      code: 'refused',
    })
    expect(await local.failedCheckLog(repo(), { headSha: 'abc' })).toBeNull()
  })

  it('logTail drops Actions timestamps and trailing blank lines, and caps the characters', () => {
    expect(logTail('2026-10-01T10:00:00.1234567Z a\r\nb\n\n')).toBe('a\nb')
    expect(logTail('x'.repeat(20_000))).toHaveLength(16_000)
  })
})

describe('GitHub (issue #5): rulesets and protection in the FakeCloud', () => {
  const org = () => cloud.opts.org
  const opts = () => ({ fetch: cloud.fetch })
  const token = async (permissions?: Record<string, string>) =>
    (
      await installationToken(
        { appId: String(cloud.opts.appId), privateKey },
        cloud.opts.installationId,
        permissions ? { permissions } : {},
        opts()
      )
    ).token
  const bump = (t: string) =>
    commitFiles(
      t,
      org(),
      'shop',
      'main',
      [{ path: 'package.json', content: '{"version":"0.1.1"}' }],
      'Release 0.1.1',
      opts()
    )

  async function shop() {
    const t = await token()
    await createOrgRepo(t, org(), { name: 'shop' }, opts())
    cloud.github.pushCommit(org(), 'shop', { 'README.md': '# shop\n' })
    return t
  }

  it('a ruleset the App may not bypass refuses the release bump (422); one it may bypass lets it land', async () => {
    const t = await shop()
    const blocking = cloud.github.protect(org(), 'shop', { requiredChecks: ['Gate'] })
    const refused = await bump(t).catch(e => e)
    expect(refused).toBeInstanceOf(GitHubApiError)
    expect(refused.status).toBe(422)

    const list = await listRulesets(t, org(), 'shop', opts())
    expect(list).toEqual([
      expect.objectContaining({ id: blocking?.id, current_user_can_bypass: 'never' }),
    ])
    expect(list[0]?.rules).toBeUndefined()
    const full = await getRuleset(t, org(), 'shop', blocking?.id ?? 0, opts())
    expect(full?.rules?.map(r => r.type)).toEqual([
      'pull_request',
      'required_status_checks',
      'non_fast_forward',
      'deletion',
    ])
    expect(await getRuleset(t, org(), 'shop', 999_999, opts())).toBeNull()

    // Launch's own ruleset through the API, the App a bypass actor; a second of that name is a
    // 422; then the blocking one updated to let the App bypass as well — and the bump lands.
    const input = {
      name: 'launch',
      target: 'branch' as const,
      enforcement: 'active' as const,
      bypass_actors: [
        { actor_id: cloud.opts.appId, actor_type: 'Integration', bypass_mode: 'always' },
      ],
      conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
      rules: [
        {
          type: 'required_status_checks',
          parameters: { required_status_checks: [{ context: 'Gate' }] },
        },
      ],
    }
    const launch = await createRuleset(t, org(), 'shop', input, opts())
    expect(launch).toMatchObject({ name: 'launch', current_user_can_bypass: 'always' })
    expect((await createRuleset(t, org(), 'shop', input, opts()).catch(e => e)).status).toBe(422)
    const updated = await updateRuleset(
      t,
      org(),
      'shop',
      blocking?.id ?? 0,
      { ...input, name: 'branch-protection' },
      opts()
    )
    expect(updated.current_user_can_bypass).toBe('always')
    expect((await bump(t)).sha).toEqual(expect.any(String))
  })

  it('classic protection reads back and blocks every push; an unprotected branch is null', async () => {
    const t = await shop()
    expect(await getBranchProtection(t, org(), 'shop', 'main', opts())).toBeNull()
    cloud.github.protect(org(), 'shop', { requiredChecks: ['Gate'], classic: true })
    expect(await getBranchProtection(t, org(), 'shop', 'main', opts())).toMatchObject({
      required_status_checks: { contexts: ['Gate'] },
    })
    expect((await bump(t).catch(e => e)).status).toBe(422)
  })

  it('a plan without rulesets answers 403, and looking needs administration: read', async () => {
    const t = await shop()
    const narrow = await token({ contents: 'read' })
    expect((await listRulesets(narrow, org(), 'shop', opts()).catch(e => e)).status).toBe(403)
    cloud.github.disableRulesets(org(), 'shop')
    expect((await listRulesets(t, org(), 'shop', opts()).catch(e => e)).status).toBe(403)
    expect((await getBranchProtection(t, org(), 'shop', 'main', opts()).catch(e => e)).status).toBe(
      403
    )
  })
})
