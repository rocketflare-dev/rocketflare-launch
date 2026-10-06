ALTER TYPE "public"."session_kind" ADD VALUE 'prebuild';--> statement-breakpoint
CREATE TABLE "app_prebuilds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"backup" jsonb,
	"mode" text,
	"sandbox_host" text,
	"image_version" text,
	"base_sha" text,
	"tree_sha" text,
	"lockfile_hash" text,
	"built_at" timestamp with time zone,
	"build_ms" integer,
	"building_session_id" uuid,
	"building_since" timestamp with time zone,
	"refresh_requested_at" timestamp with time zone,
	"last_error" text,
	"last_attempt_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_prebuilds_tenant_app_key" UNIQUE("tenant_id","app_id")
);
--> statement-breakpoint
ALTER TABLE "app_prebuilds" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app_prebuilds" ADD CONSTRAINT "app_prebuilds_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_prebuilds" ADD CONSTRAINT "app_prebuilds_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "app_prebuilds_tenant_isolation" ON "app_prebuilds" AS PERMISSIVE FOR ALL TO "launch_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);