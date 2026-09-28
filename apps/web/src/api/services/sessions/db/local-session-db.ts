/**
 * `LocalSessionDb` — the `SessionDbPort` on the laptop (`SESSION_BACKEND=local`,
 * `docs/SESSIONS-LOCAL.md`): `dev` is the database `launch_sessdev_<slug>` on the local Postgres
 * (`SESSION_LOCAL_DB_URL`), and a session's is `CREATE DATABASE launch_sess_<short> TEMPLATE
 * launch_sessdev_<slug>` — Postgres's own copy, the local stand-in for a Neon branch (a prepared
 * template makes a session's database in well under a second).
 *
 * The sandbox reaches it through the kit's local Neon proxy (`SESSION_LOCAL_NEON_PROXY`, the
 * container's `NEON_LOCAL_PROXY`), because a locked sandbox speaks only HTTP(S) to Postgres (S7)
 * and the kit's `neon` driver is what runs deployed. The proxy routes by the connection string's
 * DATABASE and ignores its host, so the URI handed to the container is `SESSION_LOCAL_DB_URL` with
 * the database swapped (and a Neon-shaped host, `sandboxDatabaseUri`). It carries the local owner role's password — a laptop-only credential,
 * refused outside `APP_ENV=development` by `loadConfig`.
 *
 * Two Postgres rules shape the SQL:
 *
 * - `CREATE DATABASE … TEMPLATE t` fails while ANYTHING is connected to `t` — and the Neon proxy
 *   POOLS its backend connections, so a prepare run leaves some behind. The template's other
 *   backends are terminated first (a local database nobody else uses).
 * - `CREATE/DROP DATABASE` cannot take parameters, so every name is built from a checked pattern
 *   (`[a-z0-9_]`) before it is rendered.
 */
import type { AppSessionDb, SessionDb } from '@launch/shared/launch-sessions'
import { sql } from 'drizzle-orm'
import type { AppConfig } from '../../../../config'
import { type DatabaseHandle, openDatabase, rows } from '../../../../db/client'
import { ServiceUnavailableError } from '../../../utils/core/errors'
import type { SessionAppRef, SessionBranch, SessionDbPort } from '../ports'

const IDENT = /^[a-z][a-z0-9_]{0,62}$/

/** `launch_sessdev_<slug>`: the app's prepared template. */
export function localDevDatabase(slug: string): string {
  return checkedIdent(`launch_sessdev_${slug.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`)
}

/** `launch_sess_<short>`: one session's database. */
export function localSessionDatabase(shortId: string): string {
  return checkedIdent(`launch_sess_${shortId.toLowerCase()}`)
}

function checkedIdent(name: string): string {
  const cut = name.slice(0, 63)
  if (!IDENT.test(cut)) throw new Error(`Not a safe database name: ${cut}`)
  return cut
}

/** `url` with its database replaced. */
export function withDatabase(url: string, database: string): string {
  const parsed = new URL(url)
  parsed.pathname = `/${database}`
  return parsed.toString()
}

/**
 * The host a local session's URI names. The kit's bootstrap refuses `--driver neon` for a URL
 * that is not `*.neon.tech` (kit 0.15), and the local Neon proxy routes by the connection
 * string's DATABASE and ignores its host — so the container gets a Neon-shaped host that is never
 * resolved (`NEON_LOCAL_PROXY` sends every query to the proxy).
 */
export const LOCAL_NEON_HOST = 'launch-local.neon.tech'

/** `SESSION_LOCAL_DB_URL` as the container uses it: the database swapped, the host Neon-shaped. */
export function sandboxDatabaseUri(adminUrl: string, database: string): string {
  const url = new URL(withDatabase(adminUrl, database))
  url.hostname = LOCAL_NEON_HOST
  url.port = ''
  return url.toString()
}

export interface LocalSessionDbOptions {
  /** Tests: open the admin connection another way. */
  open?: (url: string) => DatabaseHandle
}

export class LocalSessionDb implements SessionDbPort {
  constructor(
    readonly cfg: AppConfig,
    readonly opts: LocalSessionDbOptions = {}
  ) {}

  private get adminUrl(): string {
    const url = this.cfg.SESSION_LOCAL_DB_URL
    if (!url) {
      throw new ServiceUnavailableError(
        'SESSION_BACKEND=local needs SESSION_LOCAL_DB_URL (docs/SESSIONS-LOCAL.md)',
        'sessions_not_configured'
      )
    }
    return url
  }

  /** One short-lived owner connection (postgres.js: CREATE DATABASE cannot run in a transaction). */
  private async admin<T>(fn: (handle: DatabaseHandle) => Promise<T>): Promise<T> {
    const handle = this.opts.open
      ? this.opts.open(this.adminUrl)
      : openDatabase({ DATABASE_DRIVER: 'postgres', DATABASE_URL: this.adminUrl })
    try {
      return await fn(handle)
    } finally {
      await handle.close()
    }
  }

  private async exists(handle: DatabaseHandle, name: string): Promise<boolean> {
    const found = rows<{ datname: string }>(
      await handle.db.execute(sql`select datname from pg_database where datname = ${name}`)
    )
    return found.length > 0
  }

  async ensureDev(app: SessionAppRef): Promise<AppSessionDb> {
    const name = localDevDatabase(app.slug)
    await this.admin(async handle => {
      if (!(await this.exists(handle, name))) {
        await handle.db.execute(sql.raw(`CREATE DATABASE ${name}`))
      }
    })
    const kept = app.sessionDb?.database === name ? app.sessionDb : null
    return {
      devBranchId: null,
      database: name,
      preparedCommit: kept?.preparedCommit ?? null,
      preparedAt: kept?.preparedAt ?? null,
      status: kept?.status ?? 'none',
    }
  }

  async createBranch(
    app: SessionAppRef,
    session: { id: string; shortId: string }
  ): Promise<SessionBranch> {
    const template = localDevDatabase(app.slug)
    const name = localSessionDatabase(session.shortId)
    await this.admin(async handle => {
      if (await this.exists(handle, name)) return
      // The Neon proxy pools connections to the template: nothing may be connected to it.
      await handle.db.execute(
        sql`select pg_terminate_backend(pid) from pg_stat_activity
             where datname = ${template} and pid <> pg_backend_pid()`
      )
      await handle.db.execute(sql.raw(`CREATE DATABASE ${name} TEMPLATE ${template}`))
    })
    const url = new URL(this.adminUrl)
    return {
      db: {
        provider: 'local',
        projectId: null,
        branchId: name,
        host: url.host,
        database: name,
        role: decodeURIComponent(url.username),
      },
      uri: sandboxDatabaseUri(this.adminUrl, name),
    }
  }

  async deleteBranch(_app: SessionAppRef, db: SessionDb): Promise<void> {
    if (db.provider !== 'local') return
    const name = checkedIdent(db.database)
    await this.admin(async handle => {
      await handle.db.execute(sql.raw(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`))
    })
  }

  async devUriFor(app: SessionAppRef): Promise<string> {
    return sandboxDatabaseUri(this.adminUrl, localDevDatabase(app.slug))
  }
}
