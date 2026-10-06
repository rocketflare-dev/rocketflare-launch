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
 * 3. No draft: on a kit without build once, `POST …/releases`, as before — production rebuilds
 *    from the tag. Issue #21: on a build-once kit (`draftExpectation`) the publish WAITS for the
 *    draft instead — `deploy-production.ts` throws, and the approvals sweep retries the owed
 *    publish every few minutes — until {@link BUNDLE_DRAFT_WAIT_MINUTES} after staging went live
 *    (a draft missing past that is gone: a kit prunes old drafts) or the last allowed attempt; then
 *    it POSTs, and the notes say why production rebuilds (`rebuildReason`).
 *
 * Issue #21: a draft carrying the bundle is checked before it is published (`verifyBundleAsset`:
 * its manifest's `tag` and `bundleSha256` against the staging deploy's artifact digest); a bundle
 * that is not staging's is refused, never published.
 *
 * The notes (`releaseNotes`) carry the PRs, the release commit's tree, each session PR's
 * `launch/gate` check (issue #9: its head and the tree the gate ran on), Staging's Worker version
 * id and artifact digest, and a `Live Worker version` line that production's `activate` fills in
 * (`prepareLiveVersion`, a best-effort PATCH after the deploy is already live) — once: a rollback
 * to the tag leaves it naming the first go-live.
 */
import { releaseBundleAssetName } from '@launch/shared/launch-releases'
import { and, eq, inArray } from 'drizzle-orm'
import type { Database } from '../../../../db/client'
import {
  type AppReleaseRow,
  type AppRow,
  appReleases,
  apps,
  auditEvents,
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

/**
 * What `publishGitHubRelease` did. `waiting` (issue #21): no draft yet and the caller asked to
 * wait for one — nothing was written.
 */
export type PublishAction = 'existing' | 'published_draft' | 'created' | 'waiting'

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
 * Issue #21: `waitForDraft` — no draft yet answers `waiting` instead of POSTing (the kit's
 * `release-bundle` job has not attached it yet); `verifyDraft` runs on a draft carrying the bundle
 * before it is published, and refuses it by throwing.
 */
export async function publishGitHubRelease(
  token: string,
  owner: string,
  repo: string,
  input: {
    tag: string
    name: string
    body: (bundle: boolean) => string
    waitForDraft?: boolean
    verifyDraft?: (draft: GitHubRelease) => Promise<void>
  },
  gh: GitHubOptions = {}
): Promise<PublishOutcome | { release: null; action: 'waiting' }> {
  const existing = await getReleaseByTag(token, owner, repo, input.tag, gh)
  if (existing) return { release: existing, action: 'existing' }
  const draft = draftFor(await listReleases(token, owner, repo, gh), input.tag)
  if (!draft && input.waitForDraft) return { release: null, action: 'waiting' }
  if (draft) {
    if (input.verifyDraft && hasBundle(draft, input.tag)) await input.verifyDraft(draft)
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
  /**
   * Issue #21: why production rebuilds from the tag on a build-once kit — the bundle's draft is
   * gone (a kit prunes old drafts; or the staging run never attached one), or it did not appear
   * in time. Absent: an older kit, which has no bundle at all.
   */
  rebuildReason?: RebuildReason | null
}

/** Issue #21: why a release on a build-once kit was published without its bundle. */
export type RebuildReason = 'draft_gone' | 'draft_wait_timed_out'

const REBUILD_LINES: Record<RebuildReason, string> = {
  draft_gone:
    '- Production builds from the tag: the staging release bundle’s draft is gone (pruned, or never attached).',
  draft_wait_timed_out:
    '- Production builds from the tag: the staging release bundle’s draft did not appear in time.',
}

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
      : facts.rebuildReason
        ? REBUILD_LINES[facts.rebuildReason]
        : '- Production builds from the tag (no release bundle).'
  )
  out.push('', '**Build**', '', ...build)
  return `${out.join('\n')}\n`
}

/** The line while production has not gone live yet — the only one `withLiveVersion` fills. */
const PENDING_LIVE_LINE = /^- Live Worker version: pending\b.*$/m

/**
 * `body` with Live's version id in its PENDING `Live Worker version` line; anything else is
 * returned unchanged (issue #21): a line that already names a version is the release's first
 * go-live — a rollback or a re-deploy of the tag must not rewrite it — and a release whose notes
 * carry no such line was published by a person or before issue #12, so its notes are not Launch's
 * to edit.
 */
export function withLiveVersion(body: string | null | undefined, versionId: string): string {
  const text = body ?? ''
  return PENDING_LIVE_LINE.test(text) ? text.replace(PENDING_LIVE_LINE, liveLine(versionId)) : text
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
 * Issue #21: how long after the release's staging deploy went live Promote waits for the kit's
 * `release-bundle` job to attach the bundle to the tag's draft. That job runs right after the
 * staging job, so a draft missing past this is gone (a kit pruning old drafts, or a run that never
 * attached one) and production rebuilds.
 */
export const BUNDLE_DRAFT_WAIT_MINUTES = 20

/**
 * Issue #21: whether Promote should expect a bundle draft for `release` — `none`: the staging
 * deploy came from a kit without build once (its upload sent no `source`, which kit 0.17.0 added
 * together with the bundle), so there is never a draft; `wait`: a build-once kit, staging went
 * live under {@link BUNDLE_DRAFT_WAIT_MINUTES} ago; `gone`: a build-once kit, longer ago than that.
 * `stagingDigest` is what a bundle must match (`verifyBundleAsset`).
 */
export async function draftExpectation(
  db: Database,
  release: AppReleaseRow,
  now: Date
): Promise<{ state: 'none' | 'wait' | 'gone'; stagingDigest: string | null }> {
  if (!release.stagingTicketId) return { state: 'none', stagingDigest: null }
  const [staging] = await db
    .select({ activatedAt: deployTickets.activatedAt, digest: deployTickets.artifactDigest })
    .from(deployTickets)
    .where(
      and(
        eq(deployTickets.tenantId, release.tenantId),
        eq(deployTickets.id, release.stagingTicketId)
      )
    )
    .limit(1)
  const stagingDigest = staging?.digest ?? null
  const [uploaded] = await db
    .select({ summary: auditEvents.summary })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.tenantId, release.tenantId),
        eq(auditEvents.targetId, release.stagingTicketId),
        eq(auditEvents.action, 'deploy.uploaded')
      )
    )
    .limit(1)
  const source = (uploaded?.summary as { after?: { source?: unknown } } | null)?.after?.source
  if (!staging || typeof source !== 'string') return { state: 'none', stagingDigest }
  const since = staging.activatedAt ? now.getTime() - staging.activatedAt.getTime() : 0
  return {
    state: since < BUNDLE_DRAFT_WAIT_MINUTES * 60_000 ? 'wait' : 'gone',
    stagingDigest,
  }
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
 * GitHub Release (nobody published one) is left alone, and so is a line that already names a
 * version (issue #21: a rollback or re-deploy of the tag — `withLiveVersion`).
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
