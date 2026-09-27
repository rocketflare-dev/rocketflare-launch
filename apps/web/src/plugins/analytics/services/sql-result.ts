/**
 * Read a raw `db.execute(sql…)` result without caring which Postgres driver the host runs.
 *
 * The kit up to 0.14.x runs Drizzle over postgres.js, whose `execute` resolves to a `RowList`: an
 * ARRAY of rows carrying the affected-row count on `.count`. From 0.15.0 it runs the Neon
 * serverless driver, whose `execute` resolves to a node-postgres-style `QueryResult`:
 * `{ rows, rowCount, … }`. This plugin supports both, so it never indexes, iterates or reads
 * `.count` off an `execute` result directly — it goes through these two functions.
 *
 * Both take `unknown` on purpose: the host's `Database` type names one driver or the other, and
 * neither signature should leak into the plugin.
 */

/** The rows of an `execute` result: the array itself (postgres.js) or its `.rows` (Neon / pg). */
export function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[]
  if (result !== null && typeof result === 'object' && 'rows' in result) {
    const { rows } = result as { rows: unknown }
    if (Array.isArray(rows)) return rows as T[]
  }
  return []
}

/**
 * The statement's affected-row count: `.count` (postgres.js) or `.rowCount` (Neon / pg, where it
 * is `null` for a statement that reports none). 0 when neither is a number.
 */
export function affectedRows(result: unknown): number {
  if (result === null || typeof result !== 'object') return 0
  const { count, rowCount } = result as { count?: unknown; rowCount?: unknown }
  if (typeof count === 'number') return count
  if (typeof rowCount === 'number') return rowCount
  return 0
}
