/**
 * The DATABASE as re-scaffold evidence (`rescaffold-check.ts`). A deploy job handed the migrator
 * credential and never activated may or may not have migrated: the kit's `db:migrate:ci` runs its
 * role phase (`db-roles.ts`, one transaction) BEFORE drizzle's migrator, so a job that failed there
 * left the database untouched. Rather than guess from the credential, Launch asks the environment's
 * database itself:
 *
 * - **Applied migrations**: the rows of `drizzle.__drizzle_migrations` — drizzle's default
 *   migrations table, which the kit's `scripts/migrate.ts` (`migrate()` of `neon-serverless` or
 *   `postgres-js`, no `migrationsTable` override) writes one row per applied migration into. A
 *   missing table is zero.
 * - **Tables in `public`**: belt and braces — any at all is evidence, whatever wrote them.
 *
 * Read as `neondb_owner` over Neon's HTTP SQL, as `provision-neon.ts` does: its password is reset
 * on the environment's branch (Launch never stores it), a DIRECT URI for database `app` read back,
 * and each statement sent on its own. The password and URI are used at once and dropped; a Neon
 * error is scrubbed of both before it becomes a message.
 *
 * Vendor calls: made only for the credential-issued, never-activated case, and only by the POST.
 */
import type { AppEnvironmentNeon } from '@launch/shared/launch-apps'
import type { AppConfig } from '../../../../config'
import type { Database } from '../../../../db/client'
import { getCredential } from '../credentials'
import { NeonClient, type NeonOptions } from '../neon'

const OWNER_ROLE = 'neondb_owner'
const APP_DATABASE = 'app'
/** drizzle's default: schema `drizzle`, table `__drizzle_migrations` (the kit overrides neither). */
export const MIGRATIONS_TABLE = 'drizzle.__drizzle_migrations'

export interface DatabaseEvidence {
  /** Rows in `drizzle.__drizzle_migrations` (0 when the table does not exist). */
  migrations: number
  /** Tables in `public`. */
  tables: number
}

/** Neon answers a count as text over HTTP SQL; a driver would parse it. Accept both. */
function count(value: unknown): number {
  const n = Number(value ?? 0)
  return Number.isFinite(n) ? n : 0
}

function isTrue(value: unknown): boolean {
  return value === true || value === 't' || value === 'true'
}

/** Drop every secret from a vendor message. */
function scrubbed(message: string, secrets: readonly string[]): string {
  let out = message
  for (const s of secrets) if (s) out = out.replaceAll(s, '[redacted]')
  return out
}

/**
 * How many migrations the environment's database has applied, and how many tables `public` holds.
 * Throws (with a scrubbed message) when Neon cannot answer, or no branch is recorded.
 */
export async function databaseEvidence(
  client: NeonClient,
  neon: AppEnvironmentNeon | null | undefined
): Promise<DatabaseEvidence> {
  const projectId = neon?.projectId
  const branchId = neon?.branchId
  if (!projectId || !branchId) throw new Error('no Neon branch is recorded for it')
  const database = neon?.databaseName ?? APP_DATABASE
  const secrets: string[] = []
  try {
    const reset = await client.resetRolePassword(projectId, branchId, OWNER_ROLE)
    if (reset.role.password) secrets.push(reset.role.password)
    await client.waitForOperations(projectId, reset.operations ?? [])
    const uri = await client.connectionUri(projectId, {
      branchId,
      databaseName: database,
      roleName: OWNER_ROLE,
      pooled: false,
    })
    secrets.push(uri)
    const tables = await client.sql(
      uri,
      "SELECT count(*)::text AS n FROM pg_tables WHERE schemaname = 'public'"
    )
    const tracked = await client.sql(
      uri,
      `SELECT (to_regclass('${MIGRATIONS_TABLE}') IS NOT NULL) AS tracked`
    )
    let migrations = 0
    if (isTrue(tracked.rows[0]?.tracked)) {
      const applied = await client.sql(uri, `SELECT count(*)::text AS n FROM ${MIGRATIONS_TABLE}`)
      migrations = count(applied.rows[0]?.n)
    }
    return { migrations, tables: count(tables.rows[0]?.n) }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(scrubbed(message, secrets))
  }
}

/** Launch's Neon client from the stored org key, or null when Neon is not connected. */
export async function loadNeonClient(
  db: Database,
  cfg: AppConfig,
  opts: Pick<NeonOptions, 'fetch' | 'sleep'> = {}
): Promise<NeonClient | null> {
  const key = await getCredential(db, cfg, 'neon_org_api_key')
  return key ? new NeonClient(key.secret.apiKey, opts) : null
}
