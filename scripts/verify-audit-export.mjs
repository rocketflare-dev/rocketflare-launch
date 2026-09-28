#!/usr/bin/env node
/**
 * Verify a Launch audit export OFFLINE — no Launch, no database, no dependencies (Node ≥ 18).
 *
 *   launch audit export --format json --out audit.jsonl
 *   node scripts/verify-audit-export.mjs audit.jsonl          # or: … | node scripts/verify-audit-export.mjs -
 *
 * It re-derives every sealed row's hash from the row itself and checks the rows link up. Exit 0:
 * the chain in the file is intact; 1: a link is broken (the first one is printed); 2: the file
 * cannot be read or is not a JSON Lines export.
 *
 * The rules it implements are the canonical form documented in the header of
 * `apps/web/src/api/services/launch/audit-chain.ts` (version 1), restated here so this file can be
 * handed to an auditor on its own:
 *
 * - canonical = compact JSON of the fifteen fields below, keys in this (sorted) order, a missing
 *   value as `null`; `at` as `toISOString()` (UTC, milliseconds); `summary` with object keys sorted
 *   recursively, arrays in order; scalars as `JSON.stringify` writes them.
 * - hash = hex SHA-256 over the UTF-8 of (prevHash + canonical); prevHash is the previous row's
 *   hash and "" for seq 1; seq runs 1, 2, 3 … with no gap.
 *
 * Only an UNFILTERED export is a whole chain. Rows with `seq: null` were not sealed when exported
 * and are counted, not checked. Remember what a chain cannot show on its own: rows missing from the
 * END of the log, or a log rewritten and re-sealed from some point on. Keep the last `seq`/`hash`
 * of each export and compare it with the next one.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const CANONICAL_AUDIT_FIELDS = [
  'action',
  'actorEmail',
  'actorType',
  'actorUserId',
  'appId',
  'approvalId',
  'at',
  'id',
  'ip',
  'requestId',
  'summary',
  'targetId',
  'targetType',
  'tenantId',
  'userAgent',
]

export function stableJson(value) {
  if (value === null || value === undefined) return 'null'
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (typeof value === 'object') {
    const keys = Object.keys(value)
      .filter(k => value[k] !== undefined)
      .sort()
    return `{${keys.map(k => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function canonicalAuditJson(row) {
  const members = CANONICAL_AUDIT_FIELDS.map(field => {
    const value = field === 'at' ? new Date(row.at).toISOString() : (row[field] ?? null)
    return `${JSON.stringify(field)}:${stableJson(value)}`
  })
  return `{${members.join(',')}}`
}

export function chainHash(prevHash, row) {
  return createHash('sha256')
    .update(prevHash + canonicalAuditJson(row), 'utf8')
    .digest('hex')
}

/**
 * Check parsed export rows. Returns `{ ok, checked, unsealed, lastSeq, lastHash, broken }`, where
 * `broken` is `{ seq, id, reason }` for the first failure.
 */
export function verifyRows(rows) {
  let prevHash = ''
  let expectedSeq = 1
  let checked = 0
  let unsealed = 0
  for (const row of rows) {
    if (row.seq === null || row.seq === undefined) {
      unsealed += 1
      continue
    }
    checked += 1
    let reason = null
    if (row.seq !== expectedSeq) reason = `expected seq ${expectedSeq}, found ${row.seq}`
    else if (chainHash(prevHash, row) !== row.hash) reason = 'hash does not match the row'
    if (reason) {
      return { ok: false, checked, unsealed, broken: { seq: row.seq, id: row.id, reason } }
    }
    prevHash = row.hash
    expectedSeq += 1
  }
  const lastSeq = expectedSeq - 1
  return { ok: true, checked, unsealed, lastSeq, lastHash: prevHash || null, broken: null }
}

function main(argv) {
  const source = argv[2]
  if (!source) {
    process.stderr.write('usage: node scripts/verify-audit-export.mjs <export.jsonl | ->\n')
    return 2
  }
  let rows
  try {
    const text = readFileSync(source === '-' ? 0 : source, 'utf8')
    rows = text
      .split('\n')
      .filter(line => line.trim() !== '')
      .map(line => JSON.parse(line))
  } catch (error) {
    process.stderr.write(`cannot read ${source} as JSON Lines: ${error.message}\n`)
    return 2
  }
  const result = verifyRows(rows)
  if (result.ok) {
    process.stdout.write(
      `ok: ${result.checked} sealed row(s) verified through seq ${result.lastSeq}` +
        (result.lastHash ? ` (hash ${result.lastHash})` : '') +
        `; ${result.unsealed} unsealed\n`
    )
    return 0
  }
  process.stdout.write(
    `BROKEN at seq ${result.broken.seq} (event ${result.broken.id}): ${result.broken.reason}\n`
  )
  return 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv)
}
