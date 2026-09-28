/**
 * Launch audit log contracts (spec/08). `audit_events` is append-only: a trigger refuses UPDATE and
 * DELETE and the app role holds no grant for either. A row names who did what to which target,
 * with a before/after summary that **never carries a secret value** — only "set", "rotated" or
 * "removed". `summary` is typed here so the jsonb column agrees.
 *
 * `GET /api/audit` pages by CURSOR rather than by page number: the log only ever grows at the
 * head, so an offset page shifts under the reader while they scroll.
 */
import { z } from 'zod'

/** Who acted: a person in the console, Launch itself (a cron, a pipeline step), or an app. */
export const AUDIT_ACTOR_TYPES = ['user', 'system', 'app'] as const
export const auditActorTypeSchema = z.enum(AUDIT_ACTOR_TYPES)
export type AuditActorType = z.infer<typeof auditActorTypeSchema>

/** `{ before?, after? }` — the facts that changed, never a credential. */
export const auditSummarySchema = z.object({
  before: z.record(z.string(), z.unknown()).optional(),
  after: z.record(z.string(), z.unknown()).optional(),
})
export type AuditSummary = z.infer<typeof auditSummarySchema>

/** Dotted, lower-case action names: `app.imported`, `oidc.signin`, `credential.rotated`. */
export const auditActionSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9_]+(\.[a-z0-9_]+)*$/, 'Dotted lower-case action, e.g. app.imported')

export const auditEventSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  at: z.coerce.date(),
  actorType: auditActorTypeSchema,
  actorUserId: z.string().uuid().nullable(),
  actorEmail: z.string().nullable(),
  action: z.string(),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  appId: z.string().uuid().nullable(),
  summary: auditSummarySchema,
  requestId: z.string().nullable(),
  approvalId: z.string().uuid().nullable(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
})
export type AuditEvent = z.infer<typeof auditEventSchema>

export const AUDIT_PAGE_SIZE_DEFAULT = 50
export const AUDIT_PAGE_SIZE_MAX = 200

/**
 * `?appId&action&cursor&limit`. `action` matches the action itself or anything beneath it:
 * `action=oidc` returns `oidc.signin` and `oidc.key.rotated`. `cursor` is opaque — the
 * `nextCursor` of the previous page.
 */
export const auditListQuerySchema = z.object({
  appId: z.string().uuid().optional(),
  action: auditActionSchema.optional(),
  cursor: z.string().trim().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(AUDIT_PAGE_SIZE_MAX).default(AUDIT_PAGE_SIZE_DEFAULT),
})
export type AuditListQuery = z.infer<typeof auditListQuerySchema>

export const auditListResponseSchema = z.object({
  items: z.array(auditEventSchema),
  /** Null on the last page. */
  nextCursor: z.string().nullable(),
})
export type AuditListResponse = z.infer<typeof auditListResponseSchema>

// ---- P4: the hash chain, verify and export (spec/08 "Integrity options") ----------------------

/**
 * `GET /api/audit/verify` (admin+). The `audit.seal` cron appends `audit_chain` rows —
 * `hash = sha256(prev_hash ‖ canonical JSON of the event)` per tenant, in `seq` order — and verify
 * recomputes them. `ok` is false at the first row whose hash does not follow; events newer than
 * the last seal are counted as `unsealed`, not as a failure (tampering is evident within one
 * five-minute seal, not instantly — plan §1.12).
 */
export const auditVerifySchema = z.object({
  ok: z.boolean(),
  /** Sealed rows checked. */
  checked: z.number().int().nonnegative(),
  /** The last sealed `seq`, or null before the first seal. */
  sealedThrough: z.number().int().nonnegative().nullable(),
  /** Events not sealed yet. */
  unsealed: z.number().int().nonnegative(),
  /** The first row that failed, when `ok` is false. */
  firstBrokenSeq: z.number().int().nonnegative().nullable(),
  firstBrokenEventId: z.string().uuid().nullable(),
  verifiedAt: z.coerce.date(),
})
export type AuditVerify = z.infer<typeof auditVerifySchema>

export const AUDIT_EXPORT_FORMATS = ['csv', 'json'] as const
export const auditExportFormatSchema = z.enum(AUDIT_EXPORT_FORMATS)
export type AuditExportFormat = z.infer<typeof auditExportFormatSchema>

/**
 * `GET /api/audit/export?format=csv|json` (admin+, audited `audit.exported`). `json` is JSON
 * Lines — one `auditExportRowSchema` per line — so a large log streams; `from`/`to` bound `at`.
 */
export const auditExportQuerySchema = z.object({
  format: auditExportFormatSchema.default('json'),
  appId: z.string().uuid().optional(),
  action: auditActionSchema.optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
})
export type AuditExportQuery = z.infer<typeof auditExportQuerySchema>

/** One exported row: the event plus its place in the chain (`null` for an unsealed event). */
export const auditExportRowSchema = auditEventSchema.extend({
  seq: z.number().int().nonnegative().nullable(),
  hash: z.string().nullable(),
})
export type AuditExportRow = z.infer<typeof auditExportRowSchema>
