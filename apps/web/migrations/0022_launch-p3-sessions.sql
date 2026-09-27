CREATE TYPE "public"."session_kind" AS ENUM('session', 'prepare');--> statement-breakpoint
CREATE TYPE "public"."session_status" AS ENUM('requested', 'booting', 'ready', 'working', 'blocked', 'suspended', 'shipping', 'shipped', 'ending', 'ended', 'failed');--> statement-breakpoint
ALTER TYPE "public"."credential_kind" ADD VALUE 'anthropic_api_key';--> statement-breakpoint
CREATE TABLE "session_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"turn" integer DEFAULT 0 NOT NULL,
	"type" text NOT NULL,
	"data" jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "session_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"created_by_user_id" uuid,
	"kind" "session_kind" DEFAULT 'session' NOT NULL,
	"short_id" text NOT NULL,
	"preview_token" text NOT NULL,
	"title" text,
	"status" "session_status" DEFAULT 'requested' NOT NULL,
	"base_ref" text,
	"base_sha" text,
	"branch" text,
	"head_sha" text,
	"instance_id" text,
	"sandbox_id" text,
	"db" jsonb,
	"db_uri_sealed" text,
	"github_token_sealed" text,
	"github_token_expires_at" timestamp with time zone,
	"claude_session_id" text,
	"transcript_key" text,
	"image_version" text,
	"policy" jsonb NOT NULL,
	"turn_count" integer DEFAULT 0 NOT NULL,
	"pending_message" text,
	"requested_action" text,
	"cancel_requested_at" timestamp with time zone,
	"tokens_in" bigint DEFAULT 0 NOT NULL,
	"tokens_out" bigint DEFAULT 0 NOT NULL,
	"cache_read" bigint DEFAULT 0 NOT NULL,
	"cache_write" bigint DEFAULT 0 NOT NULL,
	"cost_microcents" bigint DEFAULT 0 NOT NULL,
	"budget_extra_microcents" bigint DEFAULT 0 NOT NULL,
	"container_seconds" integer DEFAULT 0 NOT NULL,
	"pr_number" integer,
	"pr_url" text,
	"pr_checks" jsonb,
	"error" text,
	"last_activity_at" timestamp with time zone,
	"ready_at" timestamp with time zone,
	"suspended_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_short_id_key" UNIQUE("short_id"),
	CONSTRAINT "sessions_sandbox_id_key" UNIQUE("sandbox_id")
);
--> statement-breakpoint
ALTER TABLE "sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD COLUMN "session_id" uuid;--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "session_db" jsonb;--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "session_monthly_budget_microcents" bigint;--> statement-breakpoint
ALTER TABLE "session_events" ADD CONSTRAINT "session_events_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_events" ADD CONSTRAINT "session_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "session_events_session_seq_idx" ON "session_events" USING btree ("session_id","seq");--> statement-breakpoint
CREATE INDEX "session_events_tenant_session_idx" ON "session_events" USING btree ("tenant_id","session_id");--> statement-breakpoint
CREATE INDEX "sessions_tenant_app_created_idx" ON "sessions" USING btree ("tenant_id","app_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "sessions_app_active_idx" ON "sessions" USING btree ("app_id") WHERE "sessions"."status" IN ('requested', 'booting', 'ready', 'working', 'blocked', 'suspended', 'shipping', 'ending');--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_usage_session_idx" ON "ai_usage" USING btree ("session_id");--> statement-breakpoint
CREATE POLICY "session_events_tenant_isolation" ON "session_events" AS PERMISSIVE FOR ALL TO "launch_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "sessions_tenant_isolation" ON "sessions" AS PERMISSIVE FOR ALL TO "launch_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);