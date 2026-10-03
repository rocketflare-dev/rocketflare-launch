ALTER TYPE "public"."credential_kind" ADD VALUE 'openai_api_key';--> statement-breakpoint
CREATE TABLE "agent_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"runtime" text NOT NULL,
	"kind" text NOT NULL,
	"secret_sealed" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"expires_at" timestamp with time zone,
	"claimed_by_session_id" uuid,
	"claimed_at" timestamp with time zone,
	"claim_expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"last_refreshed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_credentials_user_runtime_key" UNIQUE("tenant_id","user_id","runtime")
);
--> statement-breakpoint
ALTER TABLE "agent_credentials" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "agent_logins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"runtime" text NOT NULL,
	"status" text DEFAULT 'starting' NOT NULL,
	"instance_id" text,
	"sandbox_id" text,
	"verification_url" text,
	"user_code" text,
	"code_sealed" text,
	"error" text,
	"expires_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_logins_sandbox_id_key" UNIQUE("sandbox_id")
);
--> statement-breakpoint
ALTER TABLE "agent_logins" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD COLUMN "billing" text DEFAULT 'metered' NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "runtime" text DEFAULT 'claude_code' NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "credential_source" text DEFAULT 'platform' NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "agent_credential_id" uuid;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "runtime_state" jsonb;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "pending_message_user_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_credentials" ADD CONSTRAINT "agent_credentials_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_credentials" ADD CONSTRAINT "agent_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_credentials" ADD CONSTRAINT "agent_credentials_membership_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."tenant_users"("tenant_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_logins" ADD CONSTRAINT "agent_logins_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_logins" ADD CONSTRAINT "agent_logins_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_credentials_claim_idx" ON "agent_credentials" USING btree ("tenant_id","claim_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_logins_active_idx" ON "agent_logins" USING btree ("tenant_id","user_id","runtime") WHERE "agent_logins"."status" IN ('starting', 'awaiting_user', 'submitting', 'finishing');--> statement-breakpoint
CREATE INDEX "agent_logins_tenant_expires_idx" ON "agent_logins" USING btree ("tenant_id","expires_at");--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_agent_credential_id_agent_credentials_id_fk" FOREIGN KEY ("agent_credential_id") REFERENCES "public"."agent_credentials"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_pending_message_user_id_users_id_fk" FOREIGN KEY ("pending_message_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "agent_credentials_tenant_isolation" ON "agent_credentials" AS PERMISSIVE FOR ALL TO "launch_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "agent_logins_tenant_isolation" ON "agent_logins" AS PERMISSIVE FOR ALL TO "launch_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);