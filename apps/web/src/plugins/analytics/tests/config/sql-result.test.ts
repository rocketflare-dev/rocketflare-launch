/**
 * `rowsOf` / `affectedRows` read a raw `execute` result from either driver the kit may run: the
 * postgres.js `RowList` (an array with `.count`, kit ≤ 0.14) and the Neon serverless driver's
 * `QueryResult` (`{ rows, rowCount }`, kit 0.15.0+). Pure — no DB.
 */

import { describe, expect, it } from 'vitest'
import { affectedRows, rowsOf } from '../../services/sql-result'

/** What postgres.js resolves to: an array of rows with the affected-row count on it. */
function rowList<T>(rows: T[], count: number): T[] & { count: number } {
  return Object.assign([...rows], { count })
}

/** What the Neon serverless driver (node-postgres shape) resolves to. */
function queryResult<T>(rows: T[], rowCount: number | null) {
  return { command: 'SELECT', rowCount, rows, fields: [] }
}

describe('rowsOf', () => {
  it('returns a postgres.js RowList as its rows', () => {
    const result = rowList([{ max_ts: '2026-01-10' }], 1)
    const rows = rowsOf<{ max_ts: string }>(result)
    expect(rows).toBe(result)
    expect(rows[0]).toEqual({ max_ts: '2026-01-10' })
    expect(rows).toHaveLength(1)
  })

  it('returns a Neon QueryResult’s `.rows`', () => {
    const result = queryResult([{ max_ts: '2026-01-10' }, { max_ts: null }], 2)
    expect(rowsOf<{ max_ts: string | null }>(result)).toEqual([
      { max_ts: '2026-01-10' },
      { max_ts: null },
    ])
  })

  it('is empty for an empty result of either shape', () => {
    expect(rowsOf(rowList([], 0))).toHaveLength(0)
    expect(rowsOf(queryResult([], 0))).toEqual([])
  })

  it('is empty for anything that is neither shape', () => {
    for (const value of [undefined, null, 42, 'rows', {}, { rows: 'nope' }]) {
      expect(rowsOf(value)).toEqual([])
    }
  })
})

describe('affectedRows', () => {
  it('reads `.count` off a postgres.js RowList', () => {
    expect(affectedRows(rowList([], 4))).toBe(4)
  })

  it('reads `.rowCount` off a Neon QueryResult', () => {
    expect(affectedRows(queryResult([], 3))).toBe(3)
  })

  it('is 0 when the driver reports no count', () => {
    expect(affectedRows(queryResult([], null))).toBe(0)
    expect(affectedRows([])).toBe(0)
    expect(affectedRows({})).toBe(0)
    expect(affectedRows(undefined)).toBe(0)
    expect(affectedRows(null)).toBe(0)
  })

  it('ignores a non-numeric count', () => {
    expect(affectedRows({ count: '4', rowCount: 2 })).toBe(2)
  })
})
