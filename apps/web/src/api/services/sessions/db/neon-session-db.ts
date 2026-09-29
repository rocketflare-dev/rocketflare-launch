/**
 * `NeonSessionDb` — THE `SessionDbPort` (plan §1.7), under either `SESSION_BACKEND`: a session's
 * database is always a real Neon branch of the app's project, which the container reaches
 * directly over the neon driver (HTTPS + WebSocket) with exactly that endpoint allow-listed
 * (`sessionDbEgressHosts`). The app's `dev` branch (`init_source: 'schema-only'` from `main`, role
 * `session_owner`, empty database `session_app`), and per session a branch of `dev` with
 * `session_owner`'s password reset. Built on `NeonClient` (`services/launch/neon.ts`) and the
 * sealed `neon_org_api_key` credential.
 *
 * - **`session_owner` is made IN SQL, as `neondb_owner`** (`LOGIN CREATEROLE`, a throwaway password
 *   the API resets before anyone uses it) — exactly as `provision-neon.ts` makes `migrator`. A role
 *   Neon's role API creates is a `neon_superuser` member, far more than the one credential a
 *   session's container holds should carry. `vector` is created in `session_app` as `neondb_owner`
 *   for the same reason (the kit's own `CREATE EXTENSION IF NOT EXISTS` is then a no-op). A `dev`
 *   an earlier Launch made through the API is REPAIRED: its `session_app` and `session_owner` are
 *   deleted through the API (only the API can drop an API role) and made again, and `dev` goes
 *   back to `none` so the next session prepares it afresh — `dev` is scratch, never data.
 * - **The kit's RLS role `rocketflare_app` is made here too**, NOLOGIN, with `session_owner` given
 *   it WITH ADMIN OPTION (so the kit's `db-roles`, if a turn runs it, may still alter it). Its
 *   migrations name it in `CREATE POLICY`, so it must exist before they run — and making it here
 *   means a sandbox never runs `db-roles` at all: each of the kit's scripts opens its own database
 *   WebSocket through the container's egress interception, and on real Cloudflare containers the
 *   third or so of those hangs (docs/plans/sandbox-session-issues.md). A branch inherits it.
 *
 * - **`dev` never holds production data.** It is cut `schema-only` from `main` and filled by a
 *   PREPARE run (the kit's migrate + seed into `session_app`), so every session starts from the
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
 */
import type { AppSessionDb, SessionDb } from '@launch/shared/launch-sessions'
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
  type OwnerSession,
  ownerSession,
  quoteIdent,
  quoteLiteral,
  throwawayPassword,
} from '../../launch/pipeline/provision-neon'
import type { SessionAppRef, SessionBranch, SessionDbPort } from '../ports'

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
 * The kit's RLS role (`APP_ROLE` in the kit's `src/db/schema/rls.ts`): its migrations'
 * `CREATE POLICY … TO rocketflare_app` need it to exist. See the header.
 */
export const SESSION_APP_ROLE = 'rocketflare_app'
/** The only extension the kit's migrations create. */
const SESSION_EXTENSIONS = ['vector'] as const

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
    if (!dev) {
      const main = all.find(b => b.default) ?? all.find(b => b.name === 'main') ?? all[0]
      if (!main) throw new ServiceUnavailableError('The app’s Neon project has no branches')
      const created = await neon.createBranch(projectId, {
        name: DEV_BRANCH_NAME,
        parentId: main.id,
        initSource: 'schema-only',
        endpoints: [{ type: 'read_write' }],
      })
      await this.settleBranch(projectId, created.operations)
      dev = created.branch
    }
    const repaired = await this.ensureSessionRole(projectId, dev.id)
    const kept = app.sessionDb?.devBranchId === dev.id && !repaired ? app.sessionDb : null
    return {
      devBranchId: dev.id,
      database: SESSION_DB_NAME,
      preparedCommit: kept?.preparedCommit ?? null,
      preparedAt: kept?.preparedAt ?? null,
      status: kept?.status ?? 'none',
      ...(kept?.migrationsHash ? { migrationsHash: kept.migrationsHash } : {}),
      // A prepare claim in flight stays with its holder (`claimDevPrepare`).
      ...(kept?.status === 'preparing' && kept.preparingSessionId
        ? { preparingSessionId: kept.preparingSessionId, preparingSince: kept.preparingSince }
        : {}),
    }
  }

  /**
   * `session_owner` (in SQL, as `neondb_owner`), `session_app` owned by it, and `vector` in it —
   * see the header. True when an API-made `session_owner` was replaced, so `dev` must be prepared
   * again. Every write is checked first or takes a 409 as done: a retried step repeats nothing.
   */
  private async ensureSessionRole(projectId: string, devBranchId: string): Promise<boolean> {
    const neon = await this.neon()
    // Launch never keeps `neondb_owner`'s password: one is minted for these statements and dropped.
    const owner = await ownerSession(neon, { redact: () => {} }, projectId, devBranchId)
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
    await ensureAppRole(owner)
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
 * `rocketflare_app` on `dev`, NOLOGIN, held by `session_owner` WITH ADMIN OPTION — see the header.
 * On Postgres 16+ a CREATEROLE role may alter only a role it holds with ADMIN, and the kit's
 * `db-roles` sets the role's timeouts: without the grant, a turn's `pnpm db:migrate` would fail.
 * A role the kit's `db-roles` made (a `dev` prepared before Launch did this) is `session_owner`'s
 * already, and one this made but did not yet grant (a retried step) gets its grant now.
 */
async function ensureAppRole(owner: OwnerSession): Promise<void> {
  const exists = await owner.sql(
    OWNER_DATABASE,
    'SELECT r.rolname AS name FROM pg_roles r WHERE r.rolname IN ($1)',
    [SESSION_APP_ROLE]
  )
  if (exists.rows.length === 0) {
    await owner.sql(OWNER_DATABASE, `CREATE ROLE ${quoteIdent(SESSION_APP_ROLE)} NOLOGIN`)
  } else {
    const held = await owner.sql(
      OWNER_DATABASE,
      'SELECT 1 FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid JOIN pg_roles u ON u.oid = m.member WHERE g.rolname = $1 AND u.rolname = $2 AND m.admin_option',
      [SESSION_APP_ROLE, SESSION_DB_ROLE]
    )
    if (held.rows.length > 0) return
  }
  await owner.sql(
    OWNER_DATABASE,
    `GRANT ${quoteIdent(SESSION_APP_ROLE)} TO ${quoteIdent(SESSION_DB_ROLE)} WITH ADMIN OPTION`
  )
}

/** Neon wants TLS; its connection URIs usually say so, and the kit's driver needs it said. */
function withSslMode(uri: string): string {
  const url = new URL(uri)
  if (!url.searchParams.has('sslmode')) url.searchParams.set('sslmode', 'require')
  return url.toString()
}
