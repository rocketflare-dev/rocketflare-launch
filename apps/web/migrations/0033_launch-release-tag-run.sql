ALTER TABLE "app_releases" ADD COLUMN "tag_run" jsonb;--> statement-breakpoint
ALTER TABLE "app_releases" ADD COLUMN "tag_run_polled_at" timestamp with time zone;