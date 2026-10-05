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
import { readFileSync } from 'node:fs'
import type {
  AgentCredentialKind,
  AgentCredentialMetadata,
  AgentCredentialStatus,
  AgentRuntimeId,
} from '@launch/shared/launch-agents'
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
import { HEAD_TREE_COMMAND } from '@/api/services/sessions/checkpoint'
import { putSealed } from '@/api/services/sessions/credentials/store'
import { GATE_KIT_PROBE, GATE_LIST_COMMAND } from '@/api/services/sessions/gate'
import type { SessionStepHooks } from '@/api/services/sessions/hooks'
import type {
  ModelUpstream,
  RepoHostPort,
  SessionAppRef,
  SessionDbPort,
  SessionEgressPort,
  SessionPorts,
} from '@/api/services/sessions/ports'
import type { SessionCredentialPort } from '@/api/services/sessions/runtimes/types'
import { loadConfig } from '@/config'
import type { Database } from '@/db/client'
import {
  type AgentCredentialRow,
  type AppRow,
  agentCredentials,
  appEnvironments,
  apps,
  type NewSessionRow,
  type SessionRow,
  sessions,
} from '@/db/schema'
import { createTestEnv } from '../mocks/bindings'
import { createTestSession, createTestTenantWithUser, sessionCookieHeader } from './auth'
import type { FakeCloud } from './fake-cloud'
import { type ExecScript, FakeSandbox } from './fake-sandbox'
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
  /** The `staging` branch id when `withStaging`, else null. */
  neonStagingBranchId: string | null
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
  /**
   * As a launched app that has deployed: on `main`, `migrator` + `app` (LOGIN, made in SQL),
   * database `app` (owned by `migrator`) holding a table, and the kit's NOLOGIN RLS role
   * (`<slug>_app`, as the app's own `db-roles` makes it — so Neon refuses a schema-only child of
   * `main`); then branch `staging` (parent-data) with both passwords reset, recorded on the
   * `staging` environment row.
   */
  withStaging?: boolean
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

  let neonStagingBranchId: string | null = null
  if (opts.withStaging) {
    const mainId = project.branch.id
    cloud.neon.sqlRole(neonProjectId, mainId, 'migrator', { canCreateRole: true })
    cloud.neon.sqlRole(neonProjectId, mainId, 'app')
    await neon.createDatabase(neonProjectId, mainId, { name: 'app', ownerName: 'migrator' })
    cloud.neon.addTable(neonProjectId, mainId, 'app', 'orders')
    cloud.neon.sqlRole(neonProjectId, mainId, `${slug.replaceAll('-', '_')}_app`, {
      createdBy: 'migrator',
      noLogin: true,
    })
    const staging = await neon.createBranch(neonProjectId, { name: 'staging', parentId: mainId })
    neonStagingBranchId = staging.branch.id
    await neon.resetRolePassword(neonProjectId, neonStagingBranchId, 'migrator')
    await neon.resetRolePassword(neonProjectId, neonStagingBranchId, 'app')
  }

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
  if (neonStagingBranchId) {
    await db
      .update(appEnvironments)
      .set({
        neon: { projectId: neonProjectId, branchId: neonStagingBranchId, databaseName: 'app' },
      })
      .where(
        and(
          eq(appEnvironments.tenantId, tenant.id),
          eq(appEnvironments.appId, app.id),
          eq(appEnvironments.name, 'staging')
        )
      )
  }

  const cookie = sessionCookieHeader(await createTestSession(db, user.id, tenant.id))
  return {
    tenant,
    user,
    cookie,
    app: updated ?? app,
    repo: { owner, repo: slug },
    neonProjectId,
    devBranchId,
    neonStagingBranchId,
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
    neonStagingBranchId: f.neonStagingBranchId,
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
  createGateBranch: () => missing('sessionDb'),
  gateBranchUri: () => missing('sessionDb'),
  deleteGateBranches: () => missing('sessionDb'),
  sweepGateBranches: () => missing('sessionDb'),
}

const missingRepo: RepoHostPort = {
  gitUpstream: () => missing('repoHost'),
  gitAuth: () => missing('repoHost'),
  openPullRequest: () => missing('repoHost'),
  getChecks: () => missing('repoHost'),
  getPullRequest: () => missing('repoHost'),
  mergePullRequest: () => missing('repoHost'),
  failedCheckLog: () => missing('repoHost'),
  createCheckRun: () => missing('repoHost'),
}

/**
 * Issue #5's Phase B hooks for a suite that never lands a ship: each throws by name if reached.
 * Spread into a test's `SessionStepHooks` (`...UNEXPECTED_LAND_HOOKS`) and override the ones it drives.
 */
export const UNEXPECTED_LAND_HOOKS: Pick<
  SessionStepHooks,
  'landRelease' | 'landStaging' | 'landHealth'
> = {
  landRelease: async () => {
    throw new Error('a landRelease hook call was not expected in this test')
  },
  landStaging: async () => {
    throw new Error('a landStaging hook call was not expected in this test')
  },
  landHealth: async () => {
    throw new Error('a landHealth hook call was not expected in this test')
  },
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
    /**
     * §18.22: each turn's credential lease (default: none — `credentialsFor` answers
     * `PLATFORM_CREDENTIALS`: platform rows lease nothing, a `user` row fails its turn by name).
     */
    credentials?: SessionCredentialPort | ((db: Database) => SessionCredentialPort)
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
    ...(overrides.credentials
      ? {
          credentials: (db: Database) =>
            typeof overrides.credentials === 'function'
              ? overrides.credentials(db)
              : (overrides.credentials as SessionCredentialPort),
        }
      : {}),
  }
  return ports
}

// ---- §18.22: personal AI accounts ----------------------------------------------------------------

/** A sentinel that must never appear in a response, an event, a step result or a log line. */
export const AGENT_SECRET_SENTINEL = 'sk-ant-oat01-SENTINEL-agent-credential-never-echoed'

/**
 * A connected personal account, sealed exactly as the store seals one (`putSealed`). Returns the
 * row (sealed — never hand it to a response) and the secret that went in.
 */
export async function seedAgentCredential(
  db: Database,
  f: { tenant: { id: string }; user: { id: string } },
  opts: {
    runtime?: AgentRuntimeId
    kind?: AgentCredentialKind
    secret?: string
    status?: AgentCredentialStatus
    expiresAt?: Date | null
    metadata?: AgentCredentialMetadata
  } = {}
): Promise<{ row: AgentCredentialRow; secret: string }> {
  const runtime = opts.runtime ?? 'claude_code'
  const secret = opts.secret ?? AGENT_SECRET_SENTINEL
  await putSealed(db, loadConfig(createTestEnv()), {
    tenantId: f.tenant.id,
    userId: f.user.id,
    runtime,
    kind: opts.kind ?? (runtime === 'codex' ? 'codex_chatgpt_auth' : 'claude_oauth_token'),
    secret,
    expiresAt: opts.expiresAt ?? null,
    metadata: opts.metadata ?? {},
  })
  if (opts.status && opts.status !== 'active') {
    await db
      .update(agentCredentials)
      .set({ status: opts.status })
      .where(
        and(
          eq(agentCredentials.tenantId, f.tenant.id),
          eq(agentCredentials.userId, f.user.id),
          eq(agentCredentials.runtime, runtime)
        )
      )
  }
  const [row] = await db
    .select()
    .from(agentCredentials)
    .where(
      and(
        eq(agentCredentials.tenantId, f.tenant.id),
        eq(agentCredentials.userId, f.user.id),
        eq(agentCredentials.runtime, runtime)
      )
    )
    .limit(1)
  if (!row) throw new Error('seedAgentCredential: no row')
  return { row, secret }
}

/** The pinned kit's `pnpm gate --list --json` (`tests/fixtures/kit-gate/`), verbatim. */
export const KIT_GATE_LIST_JSON = readFileSync(
  new URL('../fixtures/kit-gate/0.16.0.json', import.meta.url),
  'utf8'
)

/**
 * Issue #9: the tree the scripted checkout reports for both reads — the working tree's
 * (`worktreeTreeScript`, its temp index `launch-tree-index`) and the commit's (`HEAD^{tree}`) — so
 * a green gate's tree and `ship.commit`'s agree unless a test says otherwise.
 */
export const GATE_TREE = 'c0ffee0123456789abcdef0123456789abcdef01'
/** What matches the working-tree read (`worktreeTreeScript`'s temp index). */
export const WORKTREE_TREE_MATCH = /launch-tree-index/

/**
 * Script a checkout's kit for the ship gate's `ship.kit` probe (`gate.ts`): `gate` (0.16.0+,
 * answering `pnpm gate --list --json` with `list` — the pinned kit's by default), `legacy` (only
 * `test:ephemeral`) or `none` (older than 0.15.7). Issue #9: both tree reads answer
 * {@link GATE_TREE}, unless `trees` scripts one (`worktree` / `head`) — e.g. a workspace that
 * moves after the gate.
 */
export function scriptKitGate(
  sandbox: FakeSandbox,
  kit: 'gate' | 'legacy' | 'none' = 'gate',
  list: string = KIT_GATE_LIST_JSON,
  trees: { worktree?: ExecScript; head?: ExecScript } = {}
): FakeSandbox {
  if (trees.worktree) sandbox.onExec(WORKTREE_TREE_MATCH, trees.worktree)
  if (trees.head) sandbox.onExec(HEAD_TREE_COMMAND, trees.head)
  return sandbox
    .onExec(GATE_KIT_PROBE, { stdout: kit })
    .onExec(GATE_LIST_COMMAND, { stdout: `${list}\n` })
    .onExec(WORKTREE_TREE_MATCH, { stdout: `tree=${GATE_TREE}\n` })
    .onExec(HEAD_TREE_COMMAND, { stdout: `${GATE_TREE}\n` })
}
