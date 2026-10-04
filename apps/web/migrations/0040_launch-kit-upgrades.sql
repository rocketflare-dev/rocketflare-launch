ALTER TYPE "public"."session_kind" ADD VALUE 'upgrade';--> statement-breakpoint
CREATE TABLE "app_upgrades" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"target_kind" text DEFAULT 'kit' NOT NULL,
	"plugin_id" text,
	"from_version" text,
	"to_version" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"session_id" uuid,
	"pr_number" integer,
	"pr_url" text,
	"error" text,
	"requested_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app_upgrades" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "upgrade_id" uuid;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "auto_ship" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "app_upgrades" ADD CONSTRAINT "app_upgrades_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_upgrades" ADD CONSTRAINT "app_upgrades_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_upgrades" ADD CONSTRAINT "app_upgrades_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_upgrades" ADD CONSTRAINT "app_upgrades_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "app_upgrades_open_idx" ON "app_upgrades" USING btree ("app_id","target_kind",coalesce("plugin_id", '')) WHERE "app_upgrades"."status" IN ('queued', 'running', 'pr_open', 'needs_attention');--> statement-breakpoint
CREATE INDEX "app_upgrades_tenant_app_created_idx" ON "app_upgrades" USING btree ("tenant_id","app_id","created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_upgrade_id_app_upgrades_id_fk" FOREIGN KEY ("upgrade_id") REFERENCES "public"."app_upgrades"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "app_upgrades_tenant_isolation" ON "app_upgrades" AS PERMISSIVE FOR ALL TO "launch_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);