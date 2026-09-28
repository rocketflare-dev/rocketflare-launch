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
 * `cli.ts` calls `registerAuditCommands(program, action)` once, after the kit's own commands (the
 * plugin `register` shape, `plugins/types.ts`), so this file never edits `cli.ts`.
 */
import { type FileHandle, open, rm } from 'node:fs/promises'
import {
  AUDIT_EXPORT_FORMATS,
  type AuditExportFormat,
  auditVerifySchema,
} from '@launch/shared/launch-audit'
import chalk from 'chalk'
import { type Command, InvalidArgumentError } from 'commander'
import { type CommandContext, requireClient } from '../context'
import { CliError, EXIT_ERROR } from '../errors'
import type { ActionWrapper } from '../plugins/types'

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
  let file: FileHandle
  try {
    file = await open(options.out, options.force ? 'w' : 'wx', 0o600)
  } catch (error) {
    const code = (error as { code?: string }).code
    throw new CliError(
      code === 'EEXIST'
        ? `${options.out} already exists`
        : `cannot write ${options.out}: ${code ?? error}`,
      { exitCode: EXIT_ERROR, hint: code === 'EEXIST' ? 'Pass --force to replace it.' : undefined }
    )
  }
  const counter = lineCounter(format)
  try {
    for await (const chunk of body) {
      counter.add(chunk)
      await file.write(chunk)
    }
  } catch (error) {
    await file.close()
    // A half-written export is worse than none: it would verify as a shorter chain.
    await rm(options.out, { force: true })
    throw new CliError(`the export was cut off: ${(error as Error).message ?? error}`, {
      exitCode: EXIT_ERROR,
      hint: 'Nothing was kept; run the export again.',
      cause: error,
    })
  }
  await file.close()
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
    .description('the organisation’s hash-chained audit log — export and verify (admin+)')
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
