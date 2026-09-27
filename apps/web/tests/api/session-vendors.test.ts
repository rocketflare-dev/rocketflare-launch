/**
 * Launch P3's vendor additions against the stateful FakeCloud: the Neon branch lifecycle a session
 * rides on (`init_source: schema-only`, endpoints, delete) and GitHub's pull requests plus the two
 * CI reads a ship waits on (check runs and the combined status). Each is asserted on the request
 * it made and the state it left, as `launch-vendors.test.ts` does for P2's.
 */
import { generateKeyPairSync } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  commitFiles,
  createOrgRepo,
  createPullRequest,
  findOpenPullRequest,
  GitHubApiError,
  getCombinedStatus,
  getPullRequest,
  installationToken,
  listCheckRuns,
} from '@/api/services/launch/github-app'
import { isNeonNotFound, NeonApiError, NeonClient } from '@/api/services/launch/neon'
import { createFakeCloud, type FakeCloud } from '../helpers/fake-cloud'

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
