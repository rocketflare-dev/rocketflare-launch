/**
 * Publishing a release's GitHub Release — Promote's `applyAfter` (`deploy.production`, subject
 * `release`) — and its notes (issue #12, build once; the kit's `docs/DEPLOYER.md` "Build once").
 *
 * On a build-once kit the staging run attaches `launch-bundle-<tag>.tgz` to a DRAFT release for the
 * tag (a draft fires no `release: published`). Promote publishes THAT draft, so production deploys
 * the bytes staging ran instead of rebuilding:
 *
 * 1. `GET …/releases/tags/{tag}` 200 → already published (a retry, or a person published it):
 *    nothing to do. A draft answers 404 here.
 * 2. Else `GET …/releases?per_page=100` → the draft whose `tag_name` is the tag, the one carrying
 *    the bundle first (`releaseBundleAssetName`), then the newest → `PATCH …/releases/{id}`
 *    `{ draft: false, name, body }` — never `tag_name`. That fires `release: published` once.
 * 3. No draft (an older kit, or the bundle job has not run): `POST …/releases`, as before —
 *    production rebuilds from the tag.
 *
 * The notes (`releaseNotes`) carry the PRs, the release commit's tree, each session PR's
 * `launch/gate` check (issue #9: its head and the tree the gate ran on), Staging's Worker version
 * id and artifact digest, and a `Live Worker version` line that production's `activate` fills in
 * (`prepareLiveVersion`, a best-effort PATCH after the deploy is already live).
 */
import { releaseBundleAssetName } from '@launch/shared/launch-releases'
import { and, eq, inArray } from 'drizzle-orm'
import type { Database } from '../../../../db/client'
import {
  type AppReleaseRow,
  type AppRow,
  appReleases,
  apps,
  deployTickets,
  sessions,
} from '../../../../db/schema'
import type { ApprovalDeps } from '../../approvals/types'
import {
  createRelease,
  type GitHubOptions,
  type GitHubRelease,
  getCommit,
  getReleaseByTag,
  listReleases,
  updateRelease,
} from '../github-app'
import { type ImportGitHub, loadImportGitHub } from '../import'
import { withRepoToken } from './github'

/** What `publishGitHubRelease` did. */
export type PublishAction = 'existing' | 'published_draft' | 'created'

export interface PublishOutcome {
  release: GitHubRelease
  action: PublishAction
}

/**
 * The draft to publish for `tag`, or null: the one carrying the bundle first, then the newest
 * (GitHub lists newest first). Pure.
 */
export function draftFor(releases: readonly GitHubRelease[], tag: string): GitHubRelease | null {
  const drafts = releases.filter(r => r.draft && r.tag_name === tag)
  const asset = releaseBundleAssetName(tag)
  return drafts.find(r => (r.assets ?? []).some(a => a.name === asset)) ?? drafts[0] ?? null
}

/** Whether `release` carries the build-once bundle for `tag`. Pure. */
export function hasBundle(release: Pick<GitHubRelease, 'assets'>, tag: string): boolean {
  const asset = releaseBundleAssetName(tag)
  return (release.assets ?? []).some(a => a.name === asset)
}

/**
 * Steps 1–3 of the header, under a `contents: write` token. `body` is asked for once the path is
 * known: `bundle` says whether the release being published carries the build-once bundle.
 */
export async function publishGitHubRelease(
  token: string,
  owner: string,
  repo: string,
  input: { tag: string; name: string; body: (bundle: boolean) => string },
  gh: GitHubOptions = {}
): Promise<PublishOutcome> {
  const existing = await getReleaseByTag(token, owner, repo, input.tag, gh)
  if (existing) return { release: existing, action: 'existing' }
  const draft = draftFor(await listReleases(token, owner, repo, gh), input.tag)
  if (draft) {
    const published = await updateRelease(
      token,
      owner,
      repo,
      draft.id,
      { draft: false, name: input.name, body: input.body(hasBundle(draft, input.tag)) },
      gh
    )
    return { release: published, action: 'published_draft' }
  }
  const created = await createRelease(
    token,
    owner,
    repo,
    { tagName: input.tag, name: input.name, body: input.body(false) },
    gh
  )
  return { release: created, action: 'created' }
}

// ---- the notes ----------------------------------------------------------------------------------

/** One session PR's gate, as the notes link it. */
export interface NoteGate {
  pr: number
  /** The PR head the `launch/gate` check run is on. */
  headSha: string
  tree: string | null
}

/** What the notes say beyond the PRs. Every field is optional: a fact Launch lacks is left out. */
export interface ReleaseNoteFacts {
  repo?: { owner: string; repo: string } | null
  /** The release commit's git tree (what the kit's bundle manifest calls `treeSha`). */
  tree?: string | null
  gates?: NoteGate[]
  stagingVersionId?: string | null
  stagingDigest?: string | null
  /** Set only after production activated; before, the line says it is pending. */
  liveVersionId?: string | null
  /** The draft being published carries the build-once bundle. */
  bundle?: boolean
}

/** The `Live Worker version` line — the one `prepareLiveVersion` rewrites. */
const LIVE_LINE = /^- Live Worker version: .*$/m

function liveLine(versionId: string | null | undefined): string {
  return `- Live Worker version: ${versionId ? `\`${versionId}\`` : 'pending (set when production goes live)'}`
}

/** The release notes. Pure. */
export function releaseNotes(release: AppReleaseRow, facts: ReleaseNoteFacts = {}): string {
  const out: string[] = []
  if (release.prs.length === 0) out.push(`Release ${release.version}, promoted from Launch.`)
  else {
    out.push('Promoted from Launch.', '')
    for (const p of release.prs) {
      out.push(`- #${p.number} ${p.title}${p.author ? ` (@${p.author})` : ''}`)
    }
  }
  const build: string[] = []
  if (facts.tree) build.push(`- Tree: \`${facts.tree}\``)
  for (const g of facts.gates ?? []) {
    const link = facts.repo
      ? `[launch/gate](https://github.com/${facts.repo.owner}/${facts.repo.repo}/commit/${g.headSha}/checks)`
      : 'launch/gate'
    build.push(`- Gate: #${g.pr} ${link}${g.tree ? ` on tree \`${g.tree}\`` : ''}`)
  }
  if (facts.stagingVersionId) build.push(`- Staging Worker version: \`${facts.stagingVersionId}\``)
  build.push(liveLine(facts.liveVersionId))
  if (facts.stagingDigest) build.push(`- Artifact digest (staging): \`${facts.stagingDigest}\``)
  build.push(
    facts.bundle
      ? `- Production deploys ${releaseBundleAssetName(release.tag)}, the build staging ran.`
      : '- Production builds from the tag (no release bundle).'
  )
  out.push('', '**Build**', '', ...build)
  return `${out.join('\n')}\n`
}

/** `body` with Live's version id in its `Live Worker version` line (appended when it has none). */
export function withLiveVersion(body: string | null | undefined, versionId: string): string {
  const text = body ?? ''
  if (LIVE_LINE.test(text)) return text.replace(LIVE_LINE, liveLine(versionId))
  return `${text.replace(/\s*$/, '')}\n\n${liveLine(versionId)}\n`
}

/**
 * The facts Launch already holds (Staging's ticket, the session PRs' gates) plus the release
 * commit's tree from GitHub — best-effort: a read that fails leaves the line out, never the publish.
 */
export async function releaseNoteFacts(
  db: Database,
  release: AppReleaseRow,
  github: { token: string; owner: string; repo: string; gh?: GitHubOptions }
): Promise<ReleaseNoteFacts> {
  const facts: ReleaseNoteFacts = { repo: { owner: github.owner, repo: github.repo } }
  try {
    facts.tree = (
      await getCommit(github.token, github.owner, github.repo, release.sha, github.gh)
    ).tree.sha
  } catch {
    facts.tree = null
  }
  if (release.stagingTicketId) {
    const [staging] = await db
      .select({ cfVersionId: deployTickets.cfVersionId, digest: deployTickets.artifactDigest })
      .from(deployTickets)
      .where(
        and(
          eq(deployTickets.tenantId, release.tenantId),
          eq(deployTickets.id, release.stagingTicketId)
        )
      )
      .limit(1)
    facts.stagingVersionId = staging?.cfVersionId ?? null
    facts.stagingDigest = staging?.digest ?? null
  }
  const sessionIds = release.prs.map(p => p.sessionId).filter((id): id is string => Boolean(id))
  if (sessionIds.length > 0) {
    const rows = await db
      .select({ id: sessions.id, landing: sessions.landing })
      .from(sessions)
      .where(and(eq(sessions.tenantId, release.tenantId), inArray(sessions.id, sessionIds)))
    const byId = new Map(rows.map(r => [r.id, r.landing]))
    facts.gates = release.prs.flatMap(p => {
      const landing = p.sessionId ? byId.get(p.sessionId) : null
      // A gate attests a tree (issue #9); a landing without one posted no `launch/gate` check.
      if (!landing?.gateSha || !landing.gateTree) return []
      return [{ pr: p.number, headSha: landing.gateSha, tree: landing.gateTree }]
    })
  }
  return facts
}

/**
 * Production went live with `versionId` for a release: write it into the published GitHub
 * Release's `Live Worker version` line. Two phases, because the write runs after the response
 * (`waitUntil`) and the request's database handle is closed by then: this function does every
 * database read NOW (the release, its app, the GitHub App credential) and returns the GitHub-only
 * work to defer — or null when there is nothing to annotate (no release row, no repo, no App).
 *
 * Best-effort and after the fact: the deploy is live whatever happens here. A failure is logged;
 * the release view shows the id anyway (`artifact.productionVersionId`). A tag with no published
 * GitHub Release (nobody published one) is left alone.
 */
export async function prepareLiveVersion(
  deps: Pick<ApprovalDeps, 'db' | 'cfg' | 'fetch' | 'logger'>,
  input: { tenantId: string; releaseId: string; versionId: string }
): Promise<(() => Promise<void>) | null> {
  const warn = (err: unknown) =>
    deps.logger.warn(
      { releaseId: input.releaseId, err: err instanceof Error ? err.message : String(err) },
      'release: could not write the Live Worker version into the GitHub Release'
    )
  let prepared: { app: AppRow; release: AppReleaseRow; github: ImportGitHub }
  try {
    const [release] = await deps.db
      .select()
      .from(appReleases)
      .where(and(eq(appReleases.tenantId, input.tenantId), eq(appReleases.id, input.releaseId)))
      .limit(1)
    if (!release) return null
    const [app] = await deps.db
      .select()
      .from(apps)
      .where(and(eq(apps.tenantId, release.tenantId), eq(apps.id, release.appId)))
      .limit(1)
    if (!app?.repoOwner || !app.repoName) return null
    prepared = { app, release, github: await loadImportGitHub(deps.db, deps.cfg) }
  } catch (err) {
    warn(err)
    return null
  }
  const { app, release, github } = prepared
  return async () => {
    try {
      await withRepoToken(
        deps.db,
        deps.cfg,
        app,
        { contents: 'write' },
        async (token, { owner, repo }) => {
          const gh = { fetch: deps.fetch }
          const published = await getReleaseByTag(token, owner, repo, release.tag, gh)
          if (!published) return
          const body = withLiveVersion(published.body, input.versionId)
          if (body === published.body) return
          await updateRelease(token, owner, repo, published.id, { body }, gh)
        },
        { fetch: deps.fetch, github }
      )
    } catch (err) {
      warn(err)
    }
  }
}
