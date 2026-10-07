/**
 * `launch audit export --format csv|json --out <file>` and `launch audit verify` — the hash-chained
 * audit log (Launch P4, plan §4e), over `/api/audit/{export,verify}` and
 * `@launch/shared/launch-audit`. Both are `read AuditEvent` on the server (admin+), so a member's
 * key exits 3.
 *
 * - `verify` asks the server to recompute the organisation's chain. Exit 0 when it is intact
 *   (events newer than the last five-minute seal are reported as unsealed, not as a failure),
 *   exit 1 at the first broken link — printed, so a pipeline can alert on it.
 * - `export` writes the log, filtered by `--app`, `--action` (the action or anything beneath it),
 *   `--from` and `--to` (`from ≤ at < to`), to `--out`, created `0600` because it is the
 *   organisation's audit trail. It refuses to replace an existing file without `--force`. JSON
 *   Lines is the verifiable format: `node scripts/verify-audit-export.mjs <file>` re-derives every
 *   hash offline, with no Launch and no dependencies. CSV is for reading (cells a spreadsheet would
 *   run as a formula are prefixed with `'`).
 *
 * The export is streamed end to end: the server writes it a page at a time and `api.ts`'s
 * `download` hands the body over chunk by chunk, straight into the file (a cut-off download is
 * removed, never left to verify as a shorter chain). A filtered JSON Lines export verifies with
 * `--filtered`: each row carries the `prevHash` it was sealed on.
 *
 * `ls` (issue #6) reads `GET /api/audit` — newest first, cursor-paged — as a table. The server
 * filters by `--app` and `--action`; `--actor` (email, user id or actor type) and `--from`/`--to`
 * are applied here, walking the cursor pages (at most {@link AUDIT_LS_MAX_PAGES}) until `--limit`
 * rows match or the log is older than `--from`. `--json` prints `{ items, nextCursor }` — the
 * server's page shape over the matching rows.
 *
 * `cli.ts` calls `registerAuditCommands(program, action)` once, after the kit's own commands (the
 * plugin `register` shape, `plugins/types.ts`), so this file never edits `cli.ts`.
 */
import {
  AUDIT_EXPORT_FORMATS,
  AUDIT_PAGE_SIZE_MAX,
  type AuditEvent,
  type AuditExportFormat,
  auditListResponseSchema,
  auditVerifySchema,
} from '@launch/shared/launch-audit'
import chalk from 'chalk'
import { type Command, InvalidArgumentError } from 'commander'
import { type CommandContext, requireClient } from '../context'
import { CliError, EXIT_ERROR } from '../errors'
import type { ActionWrapper } from '../plugins/types'
import { downloadToFile } from '../utils/input'
import { formatDate, renderTable } from '../utils/output'

/** How many cursor pages `audit ls` walks looking for rows that match the client-side filters. */
export const AUDIT_LS_MAX_PAGES = 20

export interface AuditListOptions {
  app?: string
  action?: string
  /** An actor's email (case-insensitive), user id, or actor type (`user`, `system`…). */
  actor?: string
  from?: string
  to?: string
  limit?: number
}

function matchesActor(event: AuditEvent, actor: string): boolean {
  const needle = actor.toLowerCase()
  return (
    event.actorEmail?.toLowerCase() === needle ||
    event.actorUserId === actor ||
    event.actorType === needle
  )
}

export async function runAuditList(ctx: CommandContext, options: AuditListOptions = {}) {
  const limit = options.limit ?? 50
  const from = options.from ? new Date(options.from) : undefined
  const to = options.to ? new Date(options.to) : undefined
  const clientSide = Boolean(options.actor || from || to)
  const client = requireClient(ctx)
  const items: AuditEvent[] = []
  let cursor: string | undefined
  let nextCursor: string | null = null
  for (let page = 0; page < AUDIT_LS_MAX_PAGES; page++) {
    const data = await client.get('/api/audit', {
      schema: auditListResponseSchema,
      query: {
        appId: options.app,
        action: options.action,
        cursor,
        limit: clientSide ? AUDIT_PAGE_SIZE_MAX : Math.min(limit, AUDIT_PAGE_SIZE_MAX),
      },
    })
    nextCursor = data.nextCursor
    let older = false
    for (const event of data.items) {
      if (from && event.at < from) {
        older = true
        break
      }
      if (to && event.at >= to) continue
      if (options.actor && !matchesActor(event, options.actor)) continue
      items.push(event)
      if (items.length >= limit) break
    }
    if (older) nextCursor = null
    if (items.length >= limit || older || !data.nextCursor) break
    cursor = data.nextCursor
  }
  ctx.out.data({ items, nextCursor }, () =>
    renderTable(items, [
      { header: 'At', value: e => formatDate(e.at) },
      { header: 'Action', value: e => e.action },
      { header: 'Actor', value: e => e.actorEmail ?? e.actorType },
      {
        header: 'Target',
        value: e => (e.targetType ? `${e.targetType} ${e.targetId ?? ''}`.trim() : null),
      },
      { header: 'App', value: e => e.appId },
      { header: 'Summary', value: e => summaryText(e.summary) },
    ])
  )
  if (nextCursor && items.length >= limit) {
    ctx.out.text(chalk.dim(`Showing ${items.length}; raise --limit for more.`))
  }
}

function summaryText(summary: unknown): string | null {
  if (summary === null || summary === undefined) return null
  if (typeof summary === 'string') return summary
  const text = JSON.stringify(summary)
  return text.length > 120 ? `${text.slice(0, 120)}…` : text
}

function isoDate(label: string) {
  return (value: string) => {
    if (Number.isNaN(new Date(value).getTime())) {
      throw new InvalidArgumentError(`${label} must be an ISO date or timestamp`)
    }
    return value
  }
}

function auditLimit(value: string): number {
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1 || n > 1000) {
    throw new InvalidArgumentError('--limit must be an integer from 1 to 1000')
  }
  return n
}

export async function runAuditVerify(ctx: CommandContext): Promise<void> {
  const { data, raw } = await requireClient(ctx).request('GET', '/api/audit/verify', {
    schema: auditVerifySchema,
  })
  ctx.out.data(raw, () => {
    if (!data.ok) {
      return chalk.red(
        `Audit chain BROKEN at seq ${data.firstBrokenSeq} (event ${data.firstBrokenEventId}) — ` +
          `${data.checked} row(s) checked, sealed through seq ${data.sealedThrough}.`
      )
    }
    const through =
      data.sealedThrough === null ? 'nothing sealed yet' : `through seq ${data.sealedThrough}`
    return [
      `${chalk.green('Audit chain intact')}: ${data.checked} sealed event(s) verified, ${through}.`,
      `${data.unsealed} event(s) not sealed yet (the seal runs every five minutes).`,
    ].join('\n')
  })
  if (!data.ok) {
    throw new CliError(`audit chain broken at seq ${data.firstBrokenSeq}`, {
      exitCode: EXIT_ERROR,
      hint: 'Export the log (`launch audit export --format json`) and keep it; the row at that seq, or the one before it, no longer matches what was sealed.',
    })
  }
}

export interface AuditExportOptions {
  format?: AuditExportFormat
  out: string
  app?: string
  action?: string
  from?: string
  to?: string
  force?: boolean
}

/**
 * Counts the lines of a streamed body across chunk boundaries: `\n` for JSON Lines, `\r\n` for
 * CSV (whose quoted cells may hold a bare `\n`), plus a last line with no terminator.
 */
function lineCounter(format: AuditExportFormat) {
  let lines = 0
  let bytes = 0
  let previous = -1
  return {
    add(chunk: Uint8Array) {
      for (const byte of chunk) {
        if (byte === 0x0a && (format === 'json' || previous === 0x0d)) lines += 1
        previous = byte
      }
      bytes += chunk.byteLength
    },
    get bytes() {
      return bytes
    },
    get lines() {
      return lines + (bytes > 0 && previous !== 0x0a ? 1 : 0)
    },
  }
}

export async function runAuditExport(
  ctx: CommandContext,
  options: AuditExportOptions
): Promise<void> {
  const format = options.format ?? 'json'
  const filtered = Boolean(options.app || options.action || options.from || options.to)
  // The server streams the export; so does this — straight to the file, never whole in memory.
  const { body } = await requireClient(ctx).download('/api/audit/export', {
    query: {
      format,
      appId: options.app,
      action: options.action,
      from: options.from,
      to: options.to,
    },
  })
  const counter = lineCounter(format)
  // A half-written export is worse than none (it would verify as a shorter chain): a cut-off
  // download leaves no file.
  await downloadToFile({ body }, options.out, options.force, chunk => counter.add(chunk))
  const rows = format === 'csv' ? Math.max(counter.lines - 1, 0) : counter.lines
  const summary = { file: options.out, format, rows, bytes: counter.bytes }
  ctx.out.data(summary, () => {
    const verify =
      format === 'json'
        ? `\nVerify it offline: node scripts/verify-audit-export.mjs ${filtered ? '--filtered ' : ''}${options.out}`
        : ''
    return `Wrote ${rows} audit event(s) to ${options.out} (${format}).${verify}`
  })
}

function exportFormat(value: string): AuditExportFormat {
  if (!(AUDIT_EXPORT_FORMATS as readonly string[]).includes(value)) {
    throw new InvalidArgumentError(`--format must be one of ${AUDIT_EXPORT_FORMATS.join(', ')}`)
  }
  return value as AuditExportFormat
}

export function registerAuditCommands(program: Command, action: ActionWrapper): void {
  const audit = program
    .command('audit')
    .description('the organisation’s hash-chained audit log — list, export and verify (admin+)')
  audit
    .command('ls')
    .description('list recent audit events, newest first')
    .option('--app <id>', 'only events about this app (uuid)')
    .option('--action <action>', 'only this action or anything beneath it, e.g. deploy')
    .option('--actor <who>', 'only this actor: email, user id or actor type')
    .option('--from <iso>', 'only events at or after this time', isoDate('--from'))
    .option('--to <iso>', 'only events before this time', isoDate('--to'))
    .option('--limit <n>', 'at most this many rows (default 50)', auditLimit)
    .action(action((ctx, cmd) => runAuditList(ctx, cmd.opts<AuditListOptions>())))
  audit
    .command('verify')
    .description('recompute the audit hash chain on the server; exit 1 at the first broken link')
    .action(action(ctx => runAuditVerify(ctx)))
  audit
    .command('export')
    .description('write the audit log to a file as JSON Lines (verifiable) or CSV')
    .requiredOption('--out <file>', 'file to write (created 0600)')
    .option('--format <format>', 'json (JSON Lines) | csv', exportFormat, 'json')
    .option('--app <id>', 'only events about this app (uuid)')
    .option('--action <action>', 'only this action or anything beneath it, e.g. deploy')
    .option('--from <iso>', 'only events at or after this ISO timestamp')
    .option('--to <iso>', 'only events before this ISO timestamp')
    .option('--force', 'replace --out if it exists')
    .action(action((ctx, cmd) => runAuditExport(ctx, cmd.opts<AuditExportOptions>())))
}
