ALTER TABLE "deploy_tickets" ADD COLUMN "activated_at" timestamp with time zone;--> statement-breakpoint
-- Backfill: "deployed" is now `activated_at`, set only by `activate`. History proves activation in
-- one place: the gateway audits `deploy.activated` (target `deploy_ticket`) in the same call that
-- moves a ticket `uploaded → active`, so a ticket with that event activated at its time. A ticket
-- still `active` with no such event (none should exist) activated no later than its last update.
-- A `finished` ticket with neither was closed before `activate` — an upload that never went live —
-- and stays NULL: that is the bug this column exists to see.
UPDATE "deploy_tickets" AS t
SET "activated_at" = a."at"
FROM (
  SELECT "tenant_id", "target_id", min("at") AS "at"
  FROM "audit_events"
  WHERE "action" = 'deploy.activated' AND "target_type" = 'deploy_ticket'
  GROUP BY "tenant_id", "target_id"
) AS a
WHERE t."purpose" = 'deploy'
  AND a."tenant_id" = t."tenant_id"
  AND a."target_id" = t."id"::text;--> statement-breakpoint
UPDATE "deploy_tickets"
SET "activated_at" = "updated_at"
WHERE "purpose" = 'deploy' AND "status" = 'active' AND "activated_at" IS NULL;--> statement-breakpoint
-- Make the old unactivated closes readable: `finish` now records this itself.
UPDATE "deploy_tickets"
SET "error" = 'finished before activate'
WHERE "purpose" = 'deploy' AND "status" = 'finished' AND "activated_at" IS NULL AND "error" IS NULL;
