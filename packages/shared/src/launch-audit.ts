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
