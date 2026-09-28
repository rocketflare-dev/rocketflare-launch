/**
 * Coding-session fixtures (Launch P3). An app a session can run on — a repo in the FakeCloud's
 * GitHub with a commit on `main`, a Neon project with `neondb_owner`, the production environment
 * pointing at it, and optionally a PREPARED `dev` branch recorded in `apps.session_db` — plus a
 * `sessions` row inserted directly (the lifecycle has its own suite) and the fake ports bundle.
 *
 * ```ts
 * const cloud = createFakeCloud()
 * const s = await seedSessionApp(db, cloud, { prepared: true })   // s.tenant, s.user, s.cookie, s.app, s.repo, s.neonProjectId
 * const row = await insertSession(db, s, { status: 'ready' })     // shortId, previewToken, policy filled
 * const ports = createFakeSessionPorts({ model: createFakeAnthropic().upstream })
 * ports.sandbox(row.id)                                            // a FakeSandbox, the same one every call
 * ```
 *
 * `createFakeSessionPorts` answers `sandbox(name)` with one `FakeSandbox` per name (kept in
 * `ports.sandboxes`, scripted through `ports.script(sandbox => …)`), and the db / repo ports with
 * whatever a test hands in — by default ones that throw, so a test that reaches a port it did not
 * provide fails by name. The real Neon / GitHub adapters over `cloud.fetch` are what the slices'
 * own suites hand in.
 */
import {
  type AppSessionDb,
  DEFAULT_SESSION_POLICY,
  newPreviewToken,
  newSessionShortId,
  type SessionPolicy,
  sessionBranchName,
} from '@launch/shared/launch-sessions'
import { and, eq } from 'drizzle-orm'
import { createOrgRepo } from '@/api/services/launch/github-app'
import { NeonClient } from '@/api/services/launch/neon'
import type {
  ModelUpstream,
  RepoHostPort,
  SessionAppRef,
  SessionDbPort,
  SessionEgressPort,
  SessionPorts,
} from '@/api/services/sessions/ports'
import type { Database } from '@/db/client'
import {
  type AppRow,
  appEnvironments,
  apps,
  type NewSessionRow,
  type SessionRow,
  sessions,
} from '@/db/schema'
import { createTestSession, createTestTenantWithUser, sessionCookieHeader } from './auth'
import type { FakeCloud } from './fake-cloud'
import { FakeSandbox } from './fake-sandbox'
import { seedApp, uniqueSlug } from './launch-apps'

export interface SessionAppFixture {
  tenant: { id: string; name: string; slug: string }
  user: { id: string; email: string }
  /** `{ Cookie }` for `user` in `tenant`. */
  cookie: Record<string, string>
  app: AppRow
  repo: { owner: string; repo: string }
  neonProjectId: string
  /** The `dev` branch id when `prepared`, else null. */
  devBranchId: string | null
}

export interface SeedSessionAppOptions {
  /** The member's role in the new tenant (default `owner`). */
  role?: 'owner' | 'admin' | 'member'
  /** Reuse a tenant (and its user) instead of creating one. */
  tenant?: { id: string; name: string; slug: string }
  user?: { id: string; email: string }
  slug?: string
  /**
   * Create the `dev` branch as the Neon adapter would (`init_source: schema-only` from `main`,
   * role `session_owner`, database `session_app`) and record it READY in `apps.session_db`.
   */
  prepared?: boolean
}

/** The files a fresh repo gets on `main` — enough for a clone and a PR. */
const REPO_FILES = {
  'README.md': '# App\n',
  'package.json': '{ "name": "app", "private": true }\n',
}

export async function seedSessionApp(
  db: Database,
  cloud: FakeCloud,
  opts: SeedSessionAppOptions = {}
): Promise<SessionAppFixture> {
  const created =
    opts.tenant && opts.user ? null : await createTestTenantWithUser(db, opts.role ?? 'owner')
  const tenant = opts.tenant ?? (created?.tenant as SessionAppFixture['tenant'])
  const user = opts.user ?? (created?.user as SessionAppFixture['user'])
  const slug = opts.slug ?? uniqueSlug('sess')
  const owner = cloud.opts.org

  // The repo, through the API as the pipeline creates it, then a commit on `main`.
  const token = cloud.github.issueToken().token
  await createOrgRepo(token, owner, { name: slug }, { fetch: cloud.fetch })
  cloud.github.pushCommit(owner, slug, REPO_FILES, 'Initial commit')

  // The Neon project the app runs on (a new one has `main`, `neondb_owner`, `neondb`).
  const neon = new NeonClient('neon-test-key-abcdefghijklmnop', {
    fetch: cloud.fetch,
    sleep: async () => {},
  })
  const project = await neon.createProject({ name: slug, regionId: 'aws-us-east-2' })
  const neonProjectId = project.project.id

  let devBranchId: string | null = null
  let sessionDb: AppSessionDb | null = null
  if (opts.prepared) {
    const dev = await neon.createBranch(neonProjectId, {
      name: 'dev',
      parentId: project.branch.id,
      initSource: 'schema-only',
    })
    devBranchId = dev.branch.id
    // As the adapter makes it: the role IN SQL by `neondb_owner` (no `neon_superuser`), the
    // database through the API, `vector` in it.
    cloud.neon.sqlRole(neonProjectId, devBranchId, 'session_owner', { canCreateRole: true })
    await neon.createDatabase(neonProjectId, devBranchId, {
      name: 'session_app',
      ownerName: 'session_owner',
    })
    cloud.neon.projects
      .get(neonProjectId)
      ?.branches.get(devBranchId)
      ?.extensions.set('session_app', new Set(['vector']))
    sessionDb = {
      devBranchId,
      database: 'session_app',
      preparedCommit: cloud.github.repo(owner, slug)?.refs.get('heads/main') ?? null,
      preparedAt: new Date(),
      status: 'ready',
    }
  }

  const { app } = await seedApp(db, tenant.id, { slug })
  const [updated] = await db
    .update(apps)
    .set({ repoOwner: owner, repoName: slug, defaultBranch: 'main', sessionDb })
    .where(and(eq(apps.tenantId, tenant.id), eq(apps.id, app.id)))
    .returning()
  await db
    .update(appEnvironments)
    .set({
      neon: { projectId: neonProjectId, branchId: project.branch.id, databaseName: 'neondb' },
    })
    .where(
      and(
        eq(appEnvironments.tenantId, tenant.id),
        eq(appEnvironments.appId, app.id),
        eq(appEnvironments.name, 'production')
      )
    )

  const cookie = sessionCookieHeader(await createTestSession(db, user.id, tenant.id))
  return {
    tenant,
    user,
    cookie,
    app: updated ?? app,
    repo: { owner, repo: slug },
    neonProjectId,
    devBranchId,
  }
}

/** The fixture as the ports see it. */
export function sessionAppRef(f: SessionAppFixture): SessionAppRef {
  return {
    id: f.app.id,
    tenantId: f.tenant.id,
    slug: f.app.slug,
    repoOwner: f.repo.owner,
    repoName: f.repo.repo,
    defaultBranch: f.app.defaultBranch ?? 'main',
    neonProjectId: f.neonProjectId,
    sessionDb: f.app.sessionDb ?? null,
  }
}

/** A `sessions` row for the fixture's app, straight into the table. */
export async function insertSession(
  db: Database,
  f: Pick<SessionAppFixture, 'tenant' | 'user' | 'app'>,
  overrides: Partial<NewSessionRow> & { policy?: SessionPolicy } = {}
): Promise<SessionRow> {
  const shortId = overrides.shortId ?? newSessionShortId()
  const [row] = await db
    .insert(sessions)
    .values({
      tenantId: f.tenant.id,
      appId: f.app.id,
      createdByUserId: f.user.id,
      shortId,
      previewToken: newPreviewToken(),
      branch: sessionBranchName(shortId),
      baseRef: f.app.defaultBranch ?? 'main',
      policy: DEFAULT_SESSION_POLICY,
      ...overrides,
    })
    .returning()
  if (!row) throw new Error('insertSession: insert returned no row')
  return row
}

// ---- ports -------------------------------------------------------------------------------------

function missing(port: string): never {
  throw new Error(`createFakeSessionPorts: this test did not provide a ${port}`)
}

const missingDb: SessionDbPort = {
  ensureDev: () => missing('sessionDb'),
  createBranch: () => missing('sessionDb'),
  deleteBranch: () => missing('sessionDb'),
  devUriFor: () => missing('sessionDb'),
}

const missingRepo: RepoHostPort = {
  gitUpstream: () => missing('repoHost'),
  gitAuth: () => missing('repoHost'),
  openPullRequest: () => missing('repoHost'),
  getChecks: () => missing('repoHost'),
}

export interface FakeSessionPorts extends SessionPorts {
  /** Every sandbox handed out, by name. */
  sandboxes: Map<string, FakeSandbox>
  /** Apply `fn` to every sandbox created from now on (script them before the code asks). */
  script(fn: (sandbox: FakeSandbox) => void): FakeSessionPorts
}

export function createFakeSessionPorts(
  overrides: {
    sessionDb?: SessionDbPort | ((db: Database) => SessionDbPort)
    repoHost?: RepoHostPort | ((db: Database) => RepoHostPort)
    model?: ModelUpstream
    /** The egress mode (default: none — `egressFor` answers `proxied`). */
    egress?: SessionEgressPort | ((db: Database) => SessionEgressPort)
  } = {}
): FakeSessionPorts {
  const sandboxes = new Map<string, FakeSandbox>()
  const scripts: ((sandbox: FakeSandbox) => void)[] = []
  const pick = <T>(value: T | ((db: Database) => T) | undefined, fallback: T, db: Database): T =>
    value === undefined
      ? fallback
      : typeof value === 'function'
        ? (value as (db: Database) => T)(db)
        : value
  const ports: FakeSessionPorts = {
    sandboxes,
    script(fn) {
      scripts.push(fn)
      for (const sandbox of sandboxes.values()) fn(sandbox)
      return ports
    },
    sandbox(name) {
      let sandbox = sandboxes.get(name)
      if (!sandbox) {
        sandbox = new FakeSandbox({ name })
        for (const fn of scripts) fn(sandbox)
        sandboxes.set(name, sandbox)
      }
      return sandbox
    },
    sessionDb: db => pick(overrides.sessionDb, missingDb, db),
    repoHost: db => pick(overrides.repoHost, missingRepo, db),
    model: overrides.model ?? { fetch: () => missing('model upstream') },
    ...(overrides.egress
      ? {
          egress: (db: Database) =>
            typeof overrides.egress === 'function'
              ? overrides.egress(db)
              : (overrides.egress as SessionEgressPort),
        }
      : {}),
  }
  return ports
}
