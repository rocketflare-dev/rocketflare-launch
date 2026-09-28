#!/usr/bin/env node
/**
 * Verify a Launch audit export OFFLINE — no Launch, no database, no dependencies (Node ≥ 18).
 *
 *   launch audit export --format json --out audit.jsonl
 *   node scripts/verify-audit-export.mjs audit.jsonl          # or: … | node scripts/verify-audit-export.mjs -
 *   launch audit export --action deploy --out deploys.jsonl
 *   node scripts/verify-audit-export.mjs --filtered deploys.jsonl
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
 * Each exported row carries its own `prevHash`, so every sealed row is checked on its own
 * (`hash = sha256(prevHash + canonical)`) AND against its neighbour wherever the next row in the
 * file is the next `seq` (`prevHash` = the previous row's `hash`). By default the file must be the
 * WHOLE chain — seq 1, 2, 3 … with no gap — which is what an unfiltered export is. `--filtered`
 * accepts gaps (an export narrowed by `--app`, `--action`, `--from` or `--to`): each row is still
 * proven to be the row that was sealed, but a filtered file cannot show that nothing between two
 * rows is missing. An older export without `prevHash` can only be verified whole.
 *
 * Rows with `seq: null` were not sealed when exported and are counted, not checked. Remember what a
 * chain cannot show on its own: rows missing from the END of the log, or a log rewritten and
 * re-sealed from some point on. Keep the last `seq`/`hash` of each export and compare it with the
 * next one.
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
 * Check parsed export rows. Returns `{ ok, checked, unsealed, whole, lastSeq, lastHash, broken }`,
 * where `whole` says the sealed rows are seq 1…N with no gap, and `broken` is `{ seq, id, reason }`
 * for the first failure. `filtered` accepts gaps in `seq` (see the header).
 */
export function verifyRows(rows, { filtered = false } = {}) {
  let prev = null
  let checked = 0
  let unsealed = 0
  let whole = true
  const fail = (row, reason) => ({
    ok: false,
    checked,
    unsealed,
    whole,
    broken: { seq: row.seq, id: row.id, reason },
  })
  for (const row of rows) {
    if (row.seq === null || row.seq === undefined) {
      unsealed += 1
      continue
    }
    checked += 1
    const expectedSeq = prev ? prev.seq + 1 : 1
    const follows = row.seq === expectedSeq
    const hasPrevHash = typeof row.prevHash === 'string'
    if (!follows) {
      whole = false
      if (!filtered || !hasPrevHash) {
        const hint = !hasPrevHash
          ? ' (this export has no prevHash: only a whole, unfiltered export can be verified)'
          : ' (if the export was filtered — --app, --action, --from, --to — pass --filtered)'
        return fail(row, `expected seq ${expectedSeq}, found ${row.seq}${hint}`)
      }
      if (prev && row.seq <= prev.seq) {
        return fail(row, `seq ${row.seq} is out of order after seq ${prev.seq}`)
      }
    }
    // The link: the previous hash this row was sealed on.
    const prevHash = hasPrevHash ? row.prevHash : prev ? prev.hash : ''
    if (row.seq === 1 && prevHash !== '') return fail(row, 'seq 1 must have an empty prevHash')
    if (follows && prev && prevHash !== prev.hash) {
      return fail(row, `prevHash is not seq ${prev.seq}'s hash`)
    }
    if (chainHash(prevHash, row) !== row.hash) return fail(row, 'hash does not match the row')
    prev = row
  }
  return {
    ok: true,
    checked,
    unsealed,
    whole,
    lastSeq: prev ? prev.seq : 0,
    lastHash: prev ? prev.hash : null,
    broken: null,
  }
}

function main(argv) {
  const args = argv.slice(2)
  const filtered = args.includes('--filtered')
  const source = args.find(a => a !== '--filtered')
  if (!source) {
    process.stderr.write(
      'usage: node scripts/verify-audit-export.mjs [--filtered] <export.jsonl | ->\n'
    )
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
  const result = verifyRows(rows, { filtered })
  if (result.ok) {
    const how = result.whole
      ? `verified through seq ${result.lastSeq}`
      : `verified one by one (a filtered export: gaps between rows are not checked; last seq ${result.lastSeq})`
    process.stdout.write(
      `ok: ${result.checked} sealed row(s) ${how}` +
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
