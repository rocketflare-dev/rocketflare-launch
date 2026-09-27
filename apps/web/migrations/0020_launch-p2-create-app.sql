CREATE TYPE "public"."ci_ticket_purpose" AS ENUM('deploy', 'scaffold');--> statement-breakpoint
CREATE TYPE "public"."deploy_decision_source" AS ENUM('auto', 'user', 'intent');--> statement-breakpoint
CREATE TYPE "public"."deploy_ticket_status" AS ENUM('pending', 'approved', 'rejected', 'uploaded', 'active', 'finished', 'failed');--> statement-breakpoint
CREATE TABLE "deploy_tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"purpose" "ci_ticket_purpose" NOT NULL,
	"status" "deploy_ticket_status" DEFAULT 'pending' NOT NULL,
	"repository_id" text,
	"repository" text,
	"run_id" text,
	"run_attempt" integer,
	"sha" text,
	"ref" text,
	"actor" text,
	"job_workflow_ref" text,
	"version" text,
	"cf_version_id" text,
	"bindings" jsonb,
	"refused" jsonb,
	"credentials_issued_at" timestamp with time zone,
	"credentials_revoked_at" timestamp with time zone,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"decision_source" "deploy_decision_source",
	"expires_at" timestamp with time zone,
	"launch_run_id" uuid,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "deploy_tickets_run_key" UNIQUE("environment_id","purpose","run_id","run_attempt")
);
--> statement-breakpoint
ALTER TABLE "deploy_tickets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app_environments" ADD COLUMN "encryption_key_sealed" text;--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "github_repo_id" text;--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "template_ref" text;--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "template_commit" text;--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "launch_run_id" uuid;--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "deploy_tickets" ADD CONSTRAINT "deploy_tickets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deploy_tickets" ADD CONSTRAINT "deploy_tickets_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deploy_tickets" ADD CONSTRAINT "deploy_tickets_environment_id_app_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."app_environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deploy_tickets" ADD CONSTRAINT "deploy_tickets_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deploy_tickets_tenant_app_created_idx" ON "deploy_tickets" USING btree ("tenant_id","app_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "deploy_tickets_unclaimed_intent_idx" ON "deploy_tickets" USING btree ("environment_id") WHERE "deploy_tickets"."run_id" IS NULL AND "deploy_tickets"."status" = 'approved';--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_github_repo_id_key" UNIQUE("github_repo_id");--> statement-breakpoint
CREATE POLICY "deploy_tickets_tenant_isolation" ON "deploy_tickets" AS PERMISSIVE FOR ALL TO "launch_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);