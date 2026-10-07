/**
 * `/api/audit` (spec/08), every route `read AuditEvent` (admin+ and support; members get nothing).
 *
 * - `GET /` — the organisation's audit log, newest first. Filter by `appId` and by `action` (the
 *   action or anything beneath it); page with the previous response's `nextCursor`.
 * - `GET /verify` (P4) — recompute the tenant's hash chain (`verifyChain`, `auditVerifySchema`):
 *   `ok`, rows checked, the last sealed `seq`, how many events wait for the next seal, and the
 *   first broken link when there is one.
 * - `GET /export?format=json|csv&appId&action&from&to` (P4) — the log as JSON Lines or CSV with
 *   `seq`/`hash` (null for an unsealed event), streamed a page at a time
 *   (`services/launch/audit-export.ts` has the order and formats). Audited `audit.exported`
 *   BEFORE the stream opens — the attempt is on the record even if the download is abandoned.
 *   A failure mid-stream can only abort the body, never answer JSON; a client that sees the
 *   connection end early must treat the file as incomplete.
 *
 * There is no write route — rows are appended by the services that act, through `recordAudit`,
 * and the table refuses UPDATE and DELETE.
 */
import {
  type AuditExportFormat,
  auditExportQuerySchema,
  auditListQuerySchema,
} from '@launch/shared/launch-audit'
import { guardPermission } from '../middleware/permissions'
import { auditActor, listAudit, recordAudit } from '../services/launch/audit'
import { verifyChain } from '../services/launch/audit-chain'
import {
  auditExportPages,
  CSV_HEADER,
  toCsvLine,
  toJsonLine,
} from '../services/launch/audit-export'
import { streamDatabase, withAuthAndDb } from '../utils/routes/route-helpers'
import { createRouter } from '../utils/routes/router'
import { validate } from '../utils/routes/validate'

export const auditRouter = createRouter()

/**
 * Lists the tenant's audit log, newest first, filterable by `appId` and `action`. Requires `read
 * AuditEvent` (admin+ and support); cursor-paginated via `nextCursor`.
 */
auditRouter.get('/', validate('query', auditListQuerySchema), async c => {
  guardPermission(c, 'read', 'AuditEvent')
  const { db, tenantId } = withAuthAndDb(c)
  const { cursor, ...filters } = c.req.valid('query')
  return c.json(await listAudit(db, tenantId, filters, cursor))
})

/**
 * Recomputes and verifies the tenant's audit hash chain. Requires `read AuditEvent` (admin+ and
 * support); reports `ok`, rows checked, the last sealed `seq`, and the first broken link if any.
 */
auditRouter.get('/verify', async c => {
  guardPermission(c, 'read', 'AuditEvent')
  const { db, tenantId } = withAuthAndDb(c)
  return c.json(await verifyChain(db, tenantId))
})

const EXPORT_TYPES: Record<AuditExportFormat, { contentType: string; extension: string }> = {
  json: { contentType: 'application/x-ndjson; charset=utf-8', extension: 'jsonl' },
  csv: { contentType: 'text/csv; charset=utf-8', extension: 'csv' },
}

/**
 * Streams the tenant's audit log as JSON Lines or CSV (`format=json|csv`), filterable by `appId`,
 * `action`, `from`/`to`. Requires `read AuditEvent` (admin+ and support); records an
 * `audit.exported` audit event before the stream opens.
 */
auditRouter.get('/export', validate('query', auditExportQuerySchema), async c => {
  guardPermission(c, 'read', 'AuditEvent')
  const { db, tenantId, logger } = withAuthAndDb(c)
  const { format, ...filters } = c.req.valid('query')
  await recordAudit(db, {
    tenantId,
    ...auditActor(c),
    action: 'audit.exported',
    summary: {
      after: {
        format,
        appId: filters.appId ?? null,
        action: filters.action ?? null,
        from: filters.from?.toISOString() ?? null,
        to: filters.to?.toISOString() ?? null,
      },
    },
  })

  // The request's client is ended in `waitUntil` as soon as this handler returns, before the body
  // is read — the stream reads through its own, closed when the stream ends either way.
  const handle = streamDatabase(c)
  const pages = auditExportPages(handle.db, tenantId, filters)
  const encoder = new TextEncoder()
  const line = format === 'csv' ? toCsvLine : toJsonLine
  let header = format === 'csv' ? CSV_HEADER : ''
  let closed = false
  const finish = async () => {
    if (closed) return
    closed = true
    await handle.close()
  }

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await pages.next()
        const text = header + (next.done ? '' : next.value.map(line).join(''))
        header = ''
        if (text) controller.enqueue(encoder.encode(text))
        if (next.done) {
          controller.close()
          await finish()
        }
      } catch (err) {
        logger.error({ err }, 'audit export failed mid-stream')
        controller.error(err)
        await finish()
      }
    },
    async cancel() {
      await pages.return(undefined)
      await finish()
    },
  })

  const { contentType, extension } = EXPORT_TYPES[format]
  const stamp = new Date().toISOString().slice(0, 10)
  return c.body(body, 200, {
    'Content-Type': contentType,
    'Content-Disposition': `attachment; filename="audit-${stamp}.${extension}"`,
    'Cache-Control': 'no-store',
  })
})
