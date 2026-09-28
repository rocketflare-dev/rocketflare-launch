/**
 * Launch P4's GitHub additions (slice 4a) against the stateful FakeCloud: the tag that starts
 * staging (`createRef`), the Release that starts production (`createRelease`, made idempotent by
 * `getReleaseByTag`), and the two reads a release's PR list is built from (`compareCommits`,
 * `listPullRequestsForCommit`) — plus the fake's `openPull` / `merge` / `publish` hooks the later
 * slices' tests drive. Asserted on the request made and the state left, like
 * `session-vendors.test.ts`.
 */
import { generateKeyPairSync } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  commitFiles,
  compareCommits,
  createOrgRepo,
  createPullRequest,
  createRef,
  createRelease,
  GitHubApiError,
  getPullRequest,
  getReleaseByTag,
  installationToken,
  listPullRequestsForCommit,
} from '@/api/services/launch/github-app'
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

/** A repo with `main`, a released `0.1.0` tag, and a session branch with one change. */
async function releasedRepo(name = 'shop') {
  const t = await token()
  await createOrgRepo(t, org(), { name }, opts())
  const base = cloud.github.pushCommit(org(), name, {
    'package.json': JSON.stringify({ name, version: '0.1.0' }),
  })
  await createRef(t, org(), name, 'refs/tags/0.1.0', base, opts())
  const head = cloud.github.pushCommit(
    org(),
    name,
    { 'src/a.ts': 'export const a = 1\n' },
    'Add a',
    'session/abcdefghijkl'
  )
  return { t, base, head }
}

describe('GitHub: tags and releases', () => {
  it('tags a commit once; a second tag of the same name is a 422', async () => {
    const { t, base } = await releasedRepo()
    expect(cloud.callsTo('github').find(c => c.path.endsWith('/git/refs'))?.body).toEqual({
      ref: 'refs/tags/0.1.0',
      sha: base,
    })
    expect(cloud.github.repo(org(), 'shop')?.refs.get('tags/0.1.0')).toBe(base)
    expect(cloud.github.readFile(org(), 'shop', 'package.json', '0.1.0')).toContain('0.1.0')

    const again = await createRef(t, org(), 'shop', 'refs/tags/0.1.0', base, opts()).catch(e => e)
    expect(again).toBeInstanceOf(GitHubApiError)
    expect(again.status).toBe(422)
  })

  it('a token without contents: write cannot tag', async () => {
    const { base } = await releasedRepo()
    const t = await token({ permissions: { contents: 'read' } })
    const err = await createRef(t, org(), 'shop', 'refs/tags/0.2.0', base, opts()).catch(e => e)
    expect(err.status).toBe(403)
  })

  it('publishes a release on a tag once, finds it by tag, and calls onRelease', async () => {
    const { t, base } = await releasedRepo()
    expect(await getReleaseByTag(t, org(), 'shop', '0.1.0', opts())).toBeNull()

    const published: string[] = []
    cloud.github.onRelease = release => {
      published.push(release.tag)
    }
    const release = await createRelease(t, org(), 'shop', { tagName: '0.1.0' }, opts())
    expect(release).toMatchObject({ tag_name: '0.1.0', draft: false, prerelease: false })
    expect(release.html_url).toBe(`https://github.com/${org()}/shop/releases/tag/0.1.0`)
    expect(published).toEqual(['0.1.0'])
    expect(cloud.github.releaseFor(org(), 'shop', '0.1.0')).toMatchObject({ sha: base, via: 'api' })
    expect((await getReleaseByTag(t, org(), 'shop', '0.1.0', opts()))?.id).toBe(release.id)

    const twice = await createRelease(t, org(), 'shop', { tagName: '0.1.0' }, opts()).catch(e => e)
    expect(twice.status).toBe(422)
    expect(published).toEqual(['0.1.0'])
  })

  it('a release on a missing tag needs a target (GitHub then creates the tag)', async () => {
    const { t, base } = await releasedRepo()
    const missing = await createRelease(t, org(), 'shop', { tagName: '9.9.9' }, opts()).catch(
      e => e
    )
    expect(missing.status).toBe(422)
    await createRelease(t, org(), 'shop', { tagName: '0.1.1', targetCommitish: 'main' }, opts())
    expect(cloud.github.repo(org(), 'shop')?.refs.get('tags/0.1.1')).toBe(base)
  })

  it('publish() is a release made by hand in GitHub — the job-originated path; no onRelease', async () => {
    const { t } = await releasedRepo()
    let called = false
    cloud.github.onRelease = () => {
      called = true
    }
    cloud.github.publish(org(), 'shop', '0.1.0')
    expect(called).toBe(false)
    expect((await getReleaseByTag(t, org(), 'shop', '0.1.0', opts()))?.tag_name).toBe('0.1.0')
    expect(cloud.github.releaseFor(org(), 'shop', '0.1.0')?.via).toBe('hook')
  })
})

describe('GitHub: merges, compare and the PRs of a commit', () => {
  it("a session PR merged, a person's PR merged, and a version bump: compare and commit → pulls find both", async () => {
    const { t, head } = await releasedRepo()
    const session = await createPullRequest(
      t,
      org(),
      'shop',
      { title: 'Add a', head: 'session/abcdefghijkl', base: 'main' },
      opts()
    )
    const mergeA = cloud.github.merge(
      org(),
      'shop',
      session.number,
      new Date('2026-09-28T10:00:00Z')
    )

    cloud.github.pushCommit(org(), 'shop', { 'src/b.ts': 'b\n' }, 'Add b', 'feature/b')
    const person = cloud.github.openPull(org(), 'shop', {
      head: 'feature/b',
      title: 'Add b',
      author: 'hubot',
    })
    const mergeB = cloud.github.merge(org(), 'shop', person.number)

    // The Release button's bump, on main, through the Git Data API.
    const bump = await commitFiles(
      t,
      org(),
      'shop',
      'main',
      [{ path: 'package.json', content: JSON.stringify({ name: 'shop', version: '0.1.1' }) }],
      'Release 0.1.1',
      opts()
    )

    const merged = await getPullRequest(t, org(), 'shop', session.number, opts())
    expect(merged).toMatchObject({
      state: 'closed',
      merged: true,
      merged_at: '2026-09-28T10:00:00.000Z',
      merge_commit_sha: mergeA,
      user: { login: 'company-launch[bot]' },
    })

    const comparison = await compareCommits(t, org(), 'shop', '0.1.0', bump.sha, opts())
    expect(comparison.status).toBe('ahead')
    const shas = comparison.commits.map(c => c.sha)
    // Parents before children: the session commit, its merge, feature/b, its merge, the bump.
    expect(shas).toContain(head)
    expect(shas.indexOf(head)).toBeLessThan(shas.indexOf(mergeA))
    expect(shas.indexOf(mergeA)).toBeLessThan(shas.indexOf(mergeB))
    expect(shas.at(-1)).toBe(bump.sha)
    expect(comparison.total_commits).toBe(shas.length)

    const ofMergeA = await listPullRequestsForCommit(t, org(), 'shop', mergeA, opts())
    expect(ofMergeA.map(p => p.number)).toEqual([session.number])
    const ofMergeB = await listPullRequestsForCommit(t, org(), 'shop', mergeB, opts())
    expect(ofMergeB).toEqual([
      expect.objectContaining({
        number: person.number,
        merged: true,
        user: { login: 'hubot' },
        merge_commit_sha: mergeB,
      }),
    ])
    expect(await listPullRequestsForCommit(t, org(), 'shop', bump.sha, opts())).toEqual([])

    // Nothing new since the bump.
    expect((await compareCommits(t, org(), 'shop', bump.sha, bump.sha, opts())).status).toBe(
      'identical'
    )
  })

  it('closePull closes without merging; merging a closed PR is refused by the fake', async () => {
    const { t } = await releasedRepo()
    const pr = await createPullRequest(
      t,
      org(),
      'shop',
      { title: 'Nope', head: 'session/abcdefghijkl', base: 'main' },
      opts()
    )
    cloud.github.closePull(org(), 'shop', pr.number)
    expect(await getPullRequest(t, org(), 'shop', pr.number, opts())).toMatchObject({
      state: 'closed',
      merged: false,
      merged_at: null,
    })
    expect(() => cloud.github.merge(org(), 'shop', pr.number)).toThrow(/not open/)
  })
})
