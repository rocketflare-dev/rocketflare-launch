ALTER TABLE "app_environments" ADD COLUMN "thumbnail_key" text;--> statement-breakpoint
ALTER TABLE "app_environments" ADD COLUMN "thumbnail_captured_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app_environments" ADD COLUMN "thumbnail_version" text;--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "thumbnail_refresh_at" timestamp with time zone;