ALTER TABLE "deploy_tickets" ADD COLUMN "activation_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "deploy_tickets" ADD COLUMN "run_polled_at" timestamp with time zone;