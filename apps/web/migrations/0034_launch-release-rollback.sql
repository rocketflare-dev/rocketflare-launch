ALTER TYPE "public"."release_status" ADD VALUE 'rolled_back';--> statement-breakpoint
ALTER TABLE "app_releases" ADD COLUMN "rolled_back_from" text;--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "main_compare" jsonb;--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "main_compare_at" timestamp with time zone;