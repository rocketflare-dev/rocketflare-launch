/**
 * `github_webhook_deliveries` — the GitHub App webhook's dedupe claim (issue #19). One row per
 * `X-GitHub-Delivery` id the route accepted: `INSERT … ON CONFLICT DO NOTHING RETURNING` is the
 * claim, so a redelivery (GitHub's retry, or someone pressing "Redeliver") enqueues nothing more,
 * whichever isolate it lands on. A delivery whose enqueue failed gives its row back, so GitHub's
 * retry can claim it again.
 *
 * No tenant: the route claims a delivery BEFORE it knows which app (and so which tenant) the event
 * is about — the queue handler resolves that. Platform infrastructure, in `RLS_REVOKED_TABLES`.
 * Rows older than {@link GITHUB_DELIVERY_RETENTION_DAYS} are pruned by the nightly `pruneExpired`.
 */
import { index, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

/** How long a delivery id is remembered: GitHub redelivers for at most three days. */
export const GITHUB_DELIVERY_RETENTION_DAYS = 7

export const githubWebhookDeliveries = pgTable(
  'github_webhook_deliveries',
  {
    /** `X-GitHub-Delivery` (a GUID GitHub mints per delivery; a redelivery reuses it). */
    deliveryId: text('delivery_id').primaryKey(),
    /** `X-GitHub-Event` — for the logs and a look at the table, never read back. */
    event: text('event').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  table => [index('github_webhook_deliveries_received_idx').on(table.receivedAt)]
)

export type GitHubWebhookDeliveryRow = typeof githubWebhookDeliveries.$inferSelect
