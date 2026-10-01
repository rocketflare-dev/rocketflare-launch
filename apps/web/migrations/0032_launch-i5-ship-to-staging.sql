ALTER TABLE "apps" ADD COLUMN "ship_settings" jsonb;--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "release_claim_holder" text;--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "release_claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "landing" jsonb;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "ship_summary" jsonb;