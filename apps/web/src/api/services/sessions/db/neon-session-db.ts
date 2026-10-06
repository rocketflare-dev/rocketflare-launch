/**
 * `NeonSessionDb` — THE `SessionDbPort` (plan §1.7), under either `SESSION_BACKEND`: a session's
 * database is always a real Neon branch of the app's project, which the container reaches
 * directly over the neon driver (HTTPS + WebSocket) with exactly that endpoint allow-listed
 * (`sessionDbEgressHosts`). The app's `dev` branch (cut from STAGING and scrubbed — below — role
 * `session_owner`, empty database `session_app`), and per session a branch of `dev` with
 * `session_owner`'s password reset. Built on `NeonClient` (`services/launch/neon.ts`) and the
 * sealed `neon_org_api_key` credential.
 *
 * - **`dev` is cut `parent-data` from the app's staging branch, then scrubbed.** It was once
 *   `schema-only` from `main`, but Neon refuses a schema-only branch of a parent holding a NOLOGIN
 *   role ("legacy web access role"), and every app has one on `main` from its first production
 *   migration: the kit's RLS role (`<app>_app`, its `db-roles`). Staging is the same project, its
 *   data is test data, and a `parent-data` branch has no such limit. Before `ensureDev` returns —
 *   so before any prepare run or session branch can exist — `scrubDev` deletes every database but
 *   `neondb` and `session_app` (the app's `app`), empties `neondb` of relations of its own, and
 *   resets every inherited LOGIN password (`migrator`, `app`), so staging's credentials open
 *   nothing here. A failed scrub deletes `dev`; `devSource: 'staging'` on `apps.session_db` records
 *   a finished one. An app with no staging branch still gets `schema-only` from `main` (fine
 *   until its first migration; after it, a 503 `session_dev_needs_staging`, not Neon's words).
 *
 * - **`session_owner` is made IN SQL, as `neondb_owner`** (`LOGIN CREATEROLE`, a throwaway password
 *   the API resets before anyone uses it) — exactly as `provision-neon.ts` makes `migrator`. A role
 *   Neon's role API creates is a `neon_superuser` member, far more than the one credential a
 *   session's container holds should carry. `vector` is created in `session_app` as `neondb_owner`
 *   for the same reason (the kit's own `CREATE EXTENSION IF NOT EXISTS` is then a no-op). A `dev`
 *   an earlier Launch made through the API is REPAIRED: its `session_app` and `session_owner` are
 *   deleted through the API (only the API can drop an API role) and made again, and `dev` goes
 *   back to `none` so the next session prepares it afresh — `dev` is scratch, never data.
 * - **The app's RLS role is made here too** — the APP's name for it, `<snake>_app`
 *   (`appRlsRoleFor`: the kit's `APP_ROLE` is `rocketflare_app`, and the kit's rename turns
 *   `rocketflare_` into `<snake>_`, so `hello-world`'s is `hello_world_app`) — NOLOGIN, with
 *   `session_owner` given it WITH ADMIN OPTION, so the kit's `db-roles` (which a turn's
 *   `pnpm db:migrate` and the ship gate's test setup run) may `ALTER ROLE … SET
 *   statement_timeout` it: Postgres 16+ lets a CREATEROLE role alter only a role it holds WITH
 *   ADMIN. Its migrations name it in `CREATE POLICY`, so it must exist before they run — and
 *   making it here means a prepare never needs `db-roles`: each of the kit's scripts opens its own
 *   database WebSocket through the container's egress interception, and on real Cloudflare
 *   containers the third or so of those hangs (docs/plans/sandbox-session-issues.md). A branch
 *   inherits it. On a `dev` cut from staging the role already EXISTS, made by `migrator` (the
 *   kit's `db-roles` during a deploy), and `neondb_owner` cannot grant it: `ensureAppRole` borrows
 *   `migrator`'s ADMIN for the one GRANT (proven on Postgres 17 — see there).
 *   Launch once used the kit's PRE-rename name `rocketflare_app`: it made a useless role of that,
 *   the real one was never granted, and the gate's `db-roles` failed "permission denied to alter
 *   role". `ensureDev` runs at every session's start, so a `dev` prepared then is repaired by the
 *   next session, and `createGateBranch` repairs an older session's own branch before cutting a
 *   gate branch from it.
 *
 * - **`dev` never holds production data.** It is cut from staging (scrubbed) or `schema-only` from
 *   `main`, and filled by a PREPARE run (the kit's migrate + seed into `session_app`), so every session starts from the
 *   same seeded workspace in ~1 s (S7: a prepared parent saves ~45 s of migrate + seed).
 * - **One role per branch, one password per session.** A branch inherits its parent's roles WITH
 *   their passwords, so `createBranch` resets `session_owner` on the new branch: the credential a
 *   session's container holds opens that branch and nothing else. `devUriFor` resets it on `dev`
 *   for the same reason (a prepare run's container never learns a password a session also uses).
 * - **Every write is retry-safe**, because a Workflow step may run twice: an existing `dev`, role,
 *   database or `session-<short>` branch is found and reused, and a branch already deleted is
 *   success.
 * - The URIs returned are SECRETS: the caller seals them (`db_uri_sealed`) and never returns them
 *   from a step. Direct (unpooled) endpoints — the kit's migrations open a WebSocket pool.
 * - **The ship gate's branches** (issue #1, `gate-branch.ts`): `gate-<short>-<attempt>`, a CHILD
 *   of the session's branch, one per attempt's test step (`createGateBranch`), whose URI
 *   (`gateBranchUri`, password reset) goes only into the test command's environment. They are
 *   deleted by name — `deleteGateBranches` (the step after the tests, and cleanup BEFORE the
 *   session's branch: Neon refuses to delete a parent) and `sweepGateBranches` (the cron, by the
 *   `gate-` prefix and `created_at`) — so no row has to remember them.
 */
import type { AppSessionDb, AppSessionDevSource, SessionDb } from '@launch/shared/launch-sessions'
import type { AppConfig } from '../../../../config'
import type { Database } from '../../../../db/client'
import { ServiceUnavailableError } from '../../../utils/core/errors'
import { getCredential } from '../../launch/credentials'
import {
  isNeonNotFound,
  NeonApiError,
  type NeonBranch,
  NeonClient,
  type NeonOperation,
  neonSqlEndpoint,
} from '../../launch/neon'
import {
  isTrue,
  NEON_SUPERUSER,
  OWNER_DATABASE,
  OWNER_ROLE,
  type OwnerSession,
  ownerSession,
  quoteIdent,
  quoteLiteral,
  throwawayPassword,
} from '../../launch/pipeline/provision-neon'
import { GATE_BRANCH_PREFIX, isGateBranch, isGateBranchOf } from '../gate-branch'
import type { GateBranch, SessionAppRef, SessionBranch, SessionDbPort } from '../ports'

/** The prepared parent every session branches from. */
export const DEV_BRANCH_NAME = 'dev'
/** The role a session's app connects as, on `dev` and every branch of it. */
export const SESSION_DB_ROLE = 'session_owner'
/** The database the kit migrates and seeds (`dev`) and a session runs on (its branch). */
export const SESSION_DB_NAME = 'session_app'

/**
 * `session_owner` runs the kit's migrations, and a turn may run the kit's `db-roles`, which alters
 * the app's RLS role: it needs CREATEROLE.
 */
const SESSION_ROLE_ATTRIBUTES = 'LOGIN CREATEROLE'
/**
 * The app's RLS role (`APP_ROLE` in its `apps/web/src/db/schema/rls.ts`): its migrations'
 * `CREATE POLICY … TO <role>` need it to exist, and its `db-roles` alters it. The kit ships
 * `rocketflare_app`; the kit's `scripts/rename.mjs` (`deriveNames` + the `snake` class of
 * `scripts/lib/rename-lib.mjs`) rewrites every `rocketflare_` to `<snake>_`, snake = the slug with
 * `-` → `_`. Every app Launch scaffolds is renamed to its slug, so this is its role.
 *
 * DERIVED, not read from the repo: an IMPORTED app renamed to something other than its Launch slug
 * (or one that renamed its role by hand) names a different role, which this does not grant — its
 * `db-roles` then fails in a session as before, in Postgres' own words. Reading `rls.ts` through
 * GitHub here would put a GitHub token into the database port for that one corner; it is a known
 * gap instead (docs/CONCEPTS.md, the session database).
 */
export function appRlsRoleFor(slug: string): string {
  const role = `${slug.replaceAll('-', '_')}_app`
  // A slug is `[a-z][a-z0-9-]*`, at most 40 characters: this only guards that rule.
  quoteIdent(role)
  return role
}
/** The only extension the kit's migrations create. */
const SESSION_EXTENSIONS = ['vector'] as const

/**
 * Issue #15: the version of what `ensureDev` checks and repairs on `dev` — `session_owner` made in
 * SQL, `session_app` with its extensions, the app's RLS role held WITH ADMIN. `ensureDev` records it
 * (with the role name) on `apps.session_db`; **bump it whenever those checks change**, so every
 * `dev` is checked again by its next session instead of being trusted.
 */
export const SESSION_DEV_ROLE_VERSION = 1

/**
 * Issue #15: `dev` is prepared and the running Launch's checks last passed on it, for this app's
 * role — a session may branch from it without `ensureDev` (which resets `neondb_owner`'s
 * password, runs the role and extension SQL and lists the branches: seconds of Neon calls). A
 * `dev` cut from staging must also have finished its scrub (`devSource`). Pure.
 */
export function devIsCurrent(app: Pick<SessionAppRef, 'slug' | 'sessionDb'>): boolean {
  const dev = app.sessionDb
  return (
    dev?.status === 'ready' &&
    !!dev.devBranchId &&
    dev.devSource !== undefined &&
    dev.roleVersion === SESSION_DEV_ROLE_VERSION &&
    dev.appRole === appRlsRoleFor(app.slug)
  )
}

export const sessionBranchNameFor = (shortId: string): string => `session-${shortId}`

/** A Neon compute endpoint's host: `ep-<name>-<id>[-pooler].<region…>.neon.tech`. */
const NEON_ENDPOINT_HOST = /^ep-[a-z0-9]+(?:-[a-z0-9]+)*\.(?:[a-z0-9-]+\.)+neon\.tech$/

/**
 * The hosts a container needs to reach the database in `uri` over the neon driver, and nothing
 * else: the ENDPOINT itself (the `Pool`'s `wss://<host>/v2` — the kit's migrate, seed and
 * `db:check`) and its region's HTTP SQL host (`api.<region>.neon.tech/sql` — the app's Worker
 * under `pnpm dev`, exactly as `@neondatabase/serverless` derives it; `neonSqlEndpoint`). Throws
 * for anything that is not a Neon endpoint, so no other host can be allow-listed through a
 * session's database URI. The URI is a secret; the hosts are not.
 */
export function sessionDbEgressHosts(uri: string): string[] {
  let host: string
  try {
    host = new URL(uri).hostname.toLowerCase()
  } catch {
    throw new Error('The session database URI does not parse')
  }
  if (!NEON_ENDPOINT_HOST.test(host)) {
    throw new Error(`The session database host ${host} is not a Neon endpoint`)
  }
  return [host, new URL(neonSqlEndpoint(uri)).hostname]
}

const isConflict = (err: unknown) =>
  err instanceof NeonApiError && (err.status === 409 || /already exists/i.test(err.message))

/**
 * Neon's refusal to cut a `schema-only` branch from a parent that has a NOLOGIN role: "project
 * with a legacy web access role do not support schema-only branches; role: …".
 */
export const isSchemaOnlyRefused = (err: unknown) =>
  err instanceof NeonApiError && /not support schema-only branches/i.test(err.message)

/**
 * The schemas of the owner's database that hold relations of their own — not Postgres' own, and
 * not an extension's members (a `neon` or `vector` object is no app data). Read by `scrubDev`.
 */
const OWNER_DATA_SCHEMAS_SQL =
  "SELECT DISTINCT n.nspname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND left(n.nspname, 3) <> 'pg_' AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')"

export interface NeonSessionDbOptions {
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  /** Tests: the Neon org key, instead of reading the sealed credential. */
  apiKey?: string
}

export class NeonSessionDb implements SessionDbPort {
  private client: NeonClient | null = null

  constructor(
    readonly db: Database,
    readonly cfg: AppConfig,
    /** Injected `fetch` / `sleep` for tests (the `NeonOptions` of `NeonClient`). */
    readonly opts: NeonSessionDbOptions = {}
  ) {}

  private async neon(): Promise<NeonClient> {
    if (this.client) return this.client
    let apiKey = this.opts.apiKey
    if (!apiKey) {
      const stored = await getCredential(this.db, this.cfg, 'neon_org_api_key')
      if (!stored) {
        throw new ServiceUnavailableError(
          'Coding sessions need the Neon credential: connect Neon in Setup',
          'neon_not_configured'
        )
      }
      apiKey = stored.secret.apiKey
    }
    this.client = new NeonClient(apiKey, { fetch: this.opts.fetch, sleep: this.opts.sleep })
    return this.client
  }

  private projectOf(app: SessionAppRef): string {
    if (!app.neonProjectId) {
      throw new ServiceUnavailableError(
        `App ${app.slug} has no Neon project, so it has no database to branch`,
        'app_has_no_database'
      )
    }
    return app.neonProjectId
  }

  private async branches(projectId: string): Promise<NeonBranch[]> {
    const neon = await this.neon()
    const body = await neon.get<{ branches?: NeonBranch[] }>(
      `/projects/${encodeURIComponent(projectId)}/branches`
    )
    return body.branches ?? []
  }

  private async settle(projectId: string, operations: readonly NeonOperation[] | undefined) {
    if (operations?.length) await (await this.neon()).waitForOperations(projectId, operations)
  }

  /** A new branch is usable once `create_branch` finishes — its compute starts on its own. */
  private async settleBranch(projectId: string, operations: readonly NeonOperation[]) {
    if (operations.length) await (await this.neon()).waitForBranch(projectId, operations)
  }

  async ensureDev(app: SessionAppRef): Promise<AppSessionDb> {
    const projectId = this.projectOf(app)
    const neon = await this.neon()
    const all = await this.branches(projectId)
    let dev =
      (app.sessionDb?.devBranchId && all.find(b => b.id === app.sessionDb?.devBranchId)) ||
      all.find(b => b.name === DEV_BRANCH_NAME)
    const staging = app.neonStagingBranchId
      ? all.find(b => b.id === app.neonStagingBranchId)
      : undefined
    if (!dev) {
      if (staging) {
        // `parent-data`: Neon refuses `schema-only` from a parent with a NOLOGIN role (see the
        // header). The copied data is scrubbed below, before `ensureDev` returns.
        const created = await neon.createBranch(projectId, {
          name: DEV_BRANCH_NAME,
          parentId: staging.id,
          initSource: 'parent-data',
          endpoints: [{ type: 'read_write' }],
        })
        await this.settleBranch(projectId, created.operations)
        dev = created.branch
      } else {
        dev = await this.cutDevFromMain(projectId, all)
      }
    }
    const devSource: AppSessionDevSource =
      staging && dev.parent_id === staging.id ? 'staging' : 'main'
    // Launch never keeps `neondb_owner`'s password: one is minted for these statements and dropped.
    const owner = await ownerSession(neon, { redact: () => {} }, projectId, dev.id)
    // Recorded only after a scrub finished (this method's result is what records it).
    const scrubbed = app.sessionDb?.devBranchId === dev.id && app.sessionDb.devSource === 'staging'
    if (devSource === 'staging' && !scrubbed) await this.scrubDev(projectId, dev.id, owner)
    // Every call (each session's `db` step) re-checks the app's RLS role, so a `dev` prepared
    // before Launch granted the right one is repaired here, without a reset.
    const repaired = await this.ensureSessionRole(projectId, dev.id, owner, appRlsRoleFor(app.slug))
    const kept = app.sessionDb?.devBranchId === dev.id && !repaired ? app.sessionDb : null
    return {
      devBranchId: dev.id,
      database: SESSION_DB_NAME,
      // Issue #15: what just passed — a later session on a `ready` `dev` may trust it.
      roleVersion: SESSION_DEV_ROLE_VERSION,
      appRole: appRlsRoleFor(app.slug),
      preparedCommit: kept?.preparedCommit ?? null,
      preparedAt: kept?.preparedAt ?? null,
      status: kept?.status ?? 'none',
      devSource,
      ...(kept?.migrationsHash ? { migrationsHash: kept.migrationsHash } : {}),
      // A prepare claim in flight stays with its holder (`claimDevPrepare`).
      ...(kept?.status === 'preparing' && kept.preparingSessionId
        ? { preparingSessionId: kept.preparingSessionId, preparingSince: kept.preparingSince }
        : {}),
    }
  }

  /**
   * The fallback for an app with no staging branch: `dev` cut `schema-only` from `main` — which
   * works only until `main` has a NOLOGIN role (the app's kit RLS role, made by its first
   * production migration). Neon's refusal then becomes a 503 with a code, not Neon's own words.
   */
  private async cutDevFromMain(projectId: string, all: NeonBranch[]): Promise<NeonBranch> {
    const main = all.find(b => b.default) ?? all.find(b => b.name === 'main') ?? all[0]
    if (!main) throw new ServiceUnavailableError('The app’s Neon project has no branches')
    const neon = await this.neon()
    try {
      const created = await neon.createBranch(projectId, {
        name: DEV_BRANCH_NAME,
        parentId: main.id,
        initSource: 'schema-only',
        endpoints: [{ type: 'read_write' }],
      })
      await this.settleBranch(projectId, created.operations)
      return created.branch
    } catch (err) {
      if (isSchemaOnlyRefused(err)) {
        throw new ServiceUnavailableError(
          'Coding sessions cannot copy this app’s database: it has no staging branch, and Neon ' +
            'refuses a schema-only copy of production once the app has migrated',
          'session_dev_needs_staging'
        )
      }
      throw err
    }
  }

  /**
   * A `dev` cut `parent-data` from staging holds staging's DATA and staging's PASSWORDS; neither
   * may reach a session. Done as `neondb_owner` before `ensureDev` returns — so before any prepare
   * run or session branch exists — and safe to repeat (a retried step, or a crash between the cut
   * and the record of `devSource`):
   *
   * 1. every database on `dev` but the owner's (`neondb`) and `session_app` is DELETED through the
   *    API. The app's `app` is owned by `migrator`, so `neondb_owner` cannot `DROP DATABASE` it in
   *    SQL, and `dev` needs no empty copy of it: sessions run on `session_app`. Gone is success;
   * 2. if the owner's database holds relations of its own (an app whose database IS `neondb`), each
   *    schema holding them is dropped `CASCADE`, and `public` is made again as Postgres makes it;
   * 3. every LOGIN role's password is reset and the answer dropped — all but `neondb_owner` (just
   *    reset by `ownerSession`) and `session_owner` (reset before every use) — so staging's
   *    `migrator` and `app` credentials open nothing on `dev` or any branch of it. A NOLOGIN role
   *    (`authentication_method: no_login`, the app's kit RLS role) has no password.
   *
   * Any failure DELETES `dev` before rethrowing: a half-scrubbed copy of staging is never left for
   * a later step to find, and the retry cuts it afresh.
   */
  private async scrubDev(
    projectId: string,
    devBranchId: string,
    owner: OwnerSession
  ): Promise<void> {
    const neon = await this.neon()
    try {
      for (const database of await neon.listDatabases(projectId, devBranchId)) {
        if (database.name === OWNER_DATABASE || database.name === SESSION_DB_NAME) continue
        try {
          const deleted = await neon.deleteDatabase(projectId, devBranchId, database.name)
          await this.settle(projectId, deleted.operations)
        } catch (err) {
          if (!isNeonNotFound(err)) throw err
        }
      }
      const schemas = await owner.sql(OWNER_DATABASE, OWNER_DATA_SCHEMAS_SQL)
      for (const row of schemas.rows) {
        const schema = String(row.name)
        await owner.sql(OWNER_DATABASE, `DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`)
        if (schema === 'public') {
          await owner.sql(OWNER_DATABASE, 'CREATE SCHEMA public AUTHORIZATION pg_database_owner')
          await owner.sql(OWNER_DATABASE, 'GRANT USAGE ON SCHEMA public TO PUBLIC')
        }
      }
      for (const role of await neon.listRoles(projectId, devBranchId)) {
        if (role.name === OWNER_ROLE || role.name === SESSION_DB_ROLE) continue
        if (role.authentication_method === 'no_login') continue
        // The new password is in the answer; it is dropped here, unread.
        const reset = await neon.resetRolePassword(projectId, devBranchId, role.name)
        await this.settle(projectId, reset.operations)
      }
    } catch (err) {
      await this.deleteBranchById(projectId, devBranchId).catch(() => {})
      throw err
    }
  }

  /**
   * `session_owner` (in SQL, as `neondb_owner`), `session_app` owned by it, and `vector` in it —
   * see the header. True when an API-made `session_owner` was replaced, so `dev` must be prepared
   * again. Every write is checked first or takes a 409 as done: a retried step repeats nothing.
   */
  private async ensureSessionRole(
    projectId: string,
    devBranchId: string,
    owner: OwnerSession,
    appRole: string
  ): Promise<boolean> {
    const neon = await this.neon()
    const readRole = async () =>
      (
        await owner.sql(
          OWNER_DATABASE,
          `SELECT r.rolname AS name, EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid WHERE m.member = r.oid AND g.rolname = '${NEON_SUPERUSER}') AS superuser FROM pg_roles r WHERE r.rolname IN ($1)`,
          [SESSION_DB_ROLE]
        )
      ).rows[0]
    let role: Record<string, unknown> | undefined = await readRole()
    let repaired = false
    if (role && isTrue(role.superuser)) {
      // Made by an earlier Launch through Neon's role API: only the API can drop it, and only
      // once it owns nothing.
      for (const drop of [
        () => neon.deleteDatabase(projectId, devBranchId, SESSION_DB_NAME),
        () => neon.deleteRole(projectId, devBranchId, SESSION_DB_ROLE),
      ]) {
        try {
          await this.settle(projectId, (await drop()).operations)
        } catch (err) {
          if (!isNeonNotFound(err)) throw err
        }
      }
      repaired = true
      role = undefined
    }
    if (!role) {
      await owner.sql(
        OWNER_DATABASE,
        `CREATE ROLE ${quoteIdent(SESSION_DB_ROLE)} ${SESSION_ROLE_ATTRIBUTES} PASSWORD ${quoteLiteral(throwawayPassword())}`
      )
    }
    await ensureAppRole(owner, appRole)
    try {
      const database = await neon.createDatabase(projectId, devBranchId, {
        name: SESSION_DB_NAME,
        ownerName: SESSION_DB_ROLE,
      })
      await this.settle(projectId, database.operations)
    } catch (err) {
      if (!isConflict(err)) throw err
    }
    for (const extension of SESSION_EXTENSIONS) {
      await owner.sql(SESSION_DB_NAME, `CREATE EXTENSION IF NOT EXISTS ${quoteIdent(extension)}`)
    }
    return repaired
  }

  async createBranch(
    app: SessionAppRef,
    session: { id: string; shortId: string }
  ): Promise<SessionBranch> {
    const projectId = this.projectOf(app)
    const devBranchId = app.sessionDb?.devBranchId
    if (!devBranchId) throw new Error('createBranch before ensureDev: the app has no dev branch')
    const neon = await this.neon()
    const name = sessionBranchNameFor(session.shortId)
    let branch = (await this.branches(projectId)).find(b => b.name === name)
    let host = ''
    if (!branch) {
      const created = await neon.createBranch(projectId, {
        name,
        parentId: devBranchId,
        endpoints: [{ type: 'read_write' }],
      })
      await this.settleBranch(projectId, created.operations)
      branch = created.branch
      host = created.endpoints[0]?.host ?? ''
    }
    if (!host) host = (await neon.listBranchEndpoints(projectId, branch.id))[0]?.host ?? ''
    const reset = await neon.resetRolePassword(projectId, branch.id, SESSION_DB_ROLE)
    await this.settle(projectId, reset.operations)
    const uri = await neon.connectionUri(projectId, {
      branchId: branch.id,
      databaseName: SESSION_DB_NAME,
      roleName: SESSION_DB_ROLE,
      pooled: false,
    })
    return {
      db: {
        provider: 'neon',
        projectId,
        branchId: branch.id,
        host: host || new URL(uri).hostname,
        database: SESSION_DB_NAME,
        role: SESSION_DB_ROLE,
      },
      uri: withSslMode(uri),
    }
  }

  async deleteBranch(_app: SessionAppRef, db: SessionDb): Promise<void> {
    if (db.provider !== 'neon' || !db.projectId) return
    try {
      const neon = await this.neon()
      const deleted = await neon.deleteBranch(db.projectId, db.branchId)
      await this.settle(db.projectId, deleted.operations)
    } catch (err) {
      if (!isNeonNotFound(err)) throw err
    }
  }

  /**
   * The ship gate's branch (issue #1): a child of the session's branch — so it starts from the
   * session's schema and roles (`session_owner` holds ADMIN on the app's RLS role there too, which
   * the kit's test setup — `db-roles` — alters), and the kit's test setup migrates, truncates and
   * seeds it — with its own read-write compute. `create_branch` is all that is waited for
   * (`waitForBranch`); the first connection wakes the compute. A retried step finds the branch by
   * name.
   *
   * Before a NEW gate branch is cut, `ensureAppRole` runs on the session's own branch (as
   * `neondb_owner`, a password minted for it and dropped): a session branched from a `dev`
   * prepared while Launch granted the wrong role (`rocketflare_app`) is repaired, so its gate —
   * and its later turns' `pnpm db:migrate` — pass `db-roles`. On a branch already right it is two
   * catalogue reads.
   */
  async createGateBranch(app: SessionAppRef, parent: SessionDb, name: string): Promise<GateBranch> {
    if (!isGateBranch(name)) throw new Error(`Not a gate branch name: ${name}`)
    if (parent.provider !== 'neon') throw new Error('The session has no Neon branch to test on')
    const projectId = this.projectOf(app)
    const neon = await this.neon()
    let branch = (await this.branches(projectId)).find(b => b.name === name)
    let endpoint: { id: string; host: string } | undefined
    if (!branch) {
      const owner = await ownerSession(neon, { redact: () => {} }, projectId, parent.branchId)
      await ensureAppRole(owner, appRlsRoleFor(app.slug))
      const created = await neon.createBranch(projectId, {
        name,
        parentId: parent.branchId,
        endpoints: [{ type: 'read_write' }],
      })
      await this.settleBranch(projectId, created.operations)
      branch = created.branch
      endpoint = created.endpoints[0]
    }
    if (!endpoint?.host) endpoint = (await neon.listBranchEndpoints(projectId, branch.id))[0]
    if (!endpoint?.host || !endpoint.id) {
      throw new Error(`The gate branch ${name} has no compute endpoint`)
    }
    return { name, branchId: branch.id, endpointId: endpoint.id, host: endpoint.host }
  }

  async gateBranchUri(app: SessionAppRef, branch: GateBranch): Promise<string> {
    const projectId = this.projectOf(app)
    const neon = await this.neon()
    const reset = await neon.resetRolePassword(projectId, branch.branchId, SESSION_DB_ROLE)
    await this.settle(projectId, reset.operations)
    return withSslMode(
      await neon.connectionUri(projectId, {
        branchId: branch.branchId,
        databaseName: SESSION_DB_NAME,
        roleName: SESSION_DB_ROLE,
        pooled: false,
      })
    )
  }

  async deleteGateBranches(
    app: SessionAppRef,
    shortId: string,
    opts: { keep?: string } = {}
  ): Promise<string[]> {
    if (!app.neonProjectId) return []
    const projectId = app.neonProjectId
    const doomed = (await this.branches(projectId)).filter(
      b => isGateBranchOf(b.name, shortId) && b.name !== opts.keep
    )
    for (const branch of doomed) await this.deleteBranchById(projectId, branch.id)
    return doomed.map(b => b.name)
  }

  async sweepGateBranches(app: SessionAppRef, olderThan: Date): Promise<string[]> {
    if (!app.neonProjectId) return []
    const projectId = app.neonProjectId
    const doomed = (await this.branches(projectId)).filter(b => {
      if (!b.name.startsWith(GATE_BRANCH_PREFIX) || !isGateBranch(b.name)) return false
      const created = b.created_at ? Date.parse(b.created_at) : Number.NaN
      // No creation time: not provably old — left for a later sweep that can tell.
      return Number.isFinite(created) && created < olderThan.getTime()
    })
    for (const branch of doomed) await this.deleteBranchById(projectId, branch.id)
    return doomed.map(b => b.name)
  }

  /** Delete one branch; already gone is success. */
  private async deleteBranchById(projectId: string, branchId: string): Promise<void> {
    try {
      const neon = await this.neon()
      const deleted = await neon.deleteBranch(projectId, branchId)
      await this.settle(projectId, deleted.operations)
    } catch (err) {
      if (!isNeonNotFound(err)) throw err
    }
  }

  async devUriFor(app: SessionAppRef): Promise<string> {
    const projectId = this.projectOf(app)
    const devBranchId = app.sessionDb?.devBranchId
    if (!devBranchId) throw new Error('devUriFor before ensureDev: the app has no dev branch')
    const neon = await this.neon()
    const reset = await neon.resetRolePassword(projectId, devBranchId, SESSION_DB_ROLE)
    await this.settle(projectId, reset.operations)
    return withSslMode(
      await neon.connectionUri(projectId, {
        branchId: devBranchId,
        databaseName: SESSION_DB_NAME,
        roleName: SESSION_DB_ROLE,
        pooled: false,
      })
    )
  }
}

/**
 * The roles holding `$1` WITH ADMIN OPTION — its creator among them: Postgres 16+ records a
 * creator's ADMIN as a membership row (grantor the bootstrap superuser, no INHERIT, no SET) —
 * other than `$2` (`session_owner`) and `$3` (`neondb_owner`). `migrator`, the creator of an app's
 * RLS role on every Launch project, first. (`neondb_owner`'s own creator row for `migrator` is
 * exactly such an ADMIN-only row, which is why it may grant itself `migrator` but does not
 * inherit its ADMIN until it does.)
 */
const APP_ROLE_ADMINS_SQL =
  "SELECT h.rolname AS name FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid JOIN pg_roles h ON h.oid = m.member WHERE g.rolname = $1 AND m.admin_option AND h.rolname NOT IN ($2, $3) ORDER BY h.rolname = 'migrator' DESC, h.rolname"

/** Postgres refusing a role GRANT for want of ADMIN (vanilla PG17, and Neon's wording). */
const isGrantRefused = (err: unknown) =>
  err instanceof NeonApiError &&
  /no possible grantors|permission denied to grant/i.test(err.message)

/**
 * The app's RLS role (`appRlsRoleFor`) on a branch (`dev`, or a session's own when a gate
 * repairs it), NOLOGIN, held by `session_owner` WITH ADMIN OPTION — see the header. Safe to
 * repeat: held already is two reads and nothing written.
 *
 * - **Missing** (a `dev` cut from `main` schema-only before the first migration): `neondb_owner`
 *   creates it, so holds ADMIN on it, and grants it.
 * - **Present, not held** — the case that broke: on a `dev` cut from staging the role was made by
 *   `migrator` (the kit's `db-roles` in a deploy). Only a role with ADMIN on it may grant it, and
 *   `neondb_owner` has none, so the direct GRANT is refused. But `neondb_owner` CREATED
 *   `migrator` (`provision-neon.ts`), so holds ADMIN on `migrator`: it grants ITSELF `migrator`
 *   (inheriting), the GRANT then goes through as `migrator` (recorded `grantor = migrator`), and
 *   the self-membership is revoked at once — which leaves `session_owner`'s grant standing. No
 *   credential of `migrator`'s is touched; every statement is one HTTP SQL call.
 *
 * Proven on a local Postgres 17.10 with the roles made as Neon's are — `neondb_owner` LOGIN
 * CREATEROLE (no superuser), `migrator` and `session_owner` made by it, `hello_world_app` made by
 * `migrator`: `session_owner`'s `ALTER ROLE hello_world_app SET statement_timeout = '30s'` fails
 * "permission denied to alter role"; `neondb_owner`'s GRANT … WITH ADMIN OPTION fails "no possible
 * grantors" (and `… GRANTED BY migrator` "permission denied to grant privileges as role"); `GRANT
 * migrator TO neondb_owner`, the GRANT, `REVOKE migrator FROM neondb_owner` all succeed; the
 * session_owner's membership stays (grantor `migrator`, admin `t`), and its ALTER ROLE then
 * succeeds. Repeating it only NOTICEs. (`pg_has_role(…, 'USAGE WITH ADMIN OPTION')` answers TRUE
 * for `neondb_owner` there even though the GRANT is refused — so the GRANT is TRIED, not
 * predicted.) Unproven on a real Neon project: there `neondb_owner` is also a `neon_superuser`
 * member, which may change the refusal's wording (matched loosely) or — if Neon lets
 * `neondb_owner` grant directly — make the borrow unnecessary (then it never runs).
 *
 * No admin `neondb_owner` can borrow (a role made by some other role) is an error naming the role.
 */
async function ensureAppRole(owner: OwnerSession, appRole: string): Promise<void> {
  const role = quoteIdent(appRole)
  const grant = () =>
    owner.sql(OWNER_DATABASE, `GRANT ${role} TO ${quoteIdent(SESSION_DB_ROLE)} WITH ADMIN OPTION`)
  const exists = await owner.sql(
    OWNER_DATABASE,
    'SELECT r.rolname AS name FROM pg_roles r WHERE r.rolname IN ($1)',
    [appRole]
  )
  if (exists.rows.length === 0) {
    await owner.sql(OWNER_DATABASE, `CREATE ROLE ${role} NOLOGIN`)
    await grant()
    return
  }
  const held = await owner.sql(
    OWNER_DATABASE,
    'SELECT 1 FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid JOIN pg_roles u ON u.oid = m.member WHERE g.rolname = $1 AND u.rolname = $2 AND m.admin_option',
    [appRole, SESSION_DB_ROLE]
  )
  if (held.rows.length > 0) return
  try {
    await grant()
    return
  } catch (err) {
    if (!isGrantRefused(err)) throw err
  }
  const admins = await owner.sql(OWNER_DATABASE, APP_ROLE_ADMINS_SQL, [
    appRole,
    SESSION_DB_ROLE,
    OWNER_ROLE,
  ])
  for (const row of admins.rows) {
    const admin = quoteIdent(String(row.name))
    try {
      await owner.sql(OWNER_DATABASE, `GRANT ${admin} TO ${quoteIdent(OWNER_ROLE)}`)
    } catch (err) {
      // `neondb_owner` holds no ADMIN on this one (not its creation): try the next.
      if (isGrantRefused(err)) continue
      throw err
    }
    try {
      await grant()
      return
    } catch (err) {
      if (!isGrantRefused(err)) throw err
    } finally {
      await owner.sql(OWNER_DATABASE, `REVOKE ${admin} FROM ${quoteIdent(OWNER_ROLE)}`)
    }
  }
  throw new Error(
    `Cannot give ${SESSION_DB_ROLE} the app's RLS role ${appRole} WITH ADMIN OPTION: ${OWNER_ROLE} holds no ADMIN on it, nor on any role that does`
  )
}

/** Neon wants TLS; its connection URIs usually say so, and the kit's driver needs it said. */
function withSslMode(uri: string): string {
  const url = new URL(uri)
  if (!url.searchParams.has('sslmode')) url.searchParams.set('sslmode', 'require')
  return url.toString()
}
