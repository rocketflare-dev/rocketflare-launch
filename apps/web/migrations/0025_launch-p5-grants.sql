CREATE TABLE "app_config_scans" (
	"tenant_id" uuid NOT NULL,
	"app_id" uuid PRIMARY KEY NOT NULL,
	"ref" text,
	"sha" text,
	"scanned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"declared" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"needs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	CONSTRAINT "app_config_scans_error_length" CHECK (char_length("app_config_scans"."error") <= 2000)
);
--> statement-breakpoint
ALTER TABLE "app_config_scans" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"resource_id" uuid NOT NULL,
	"environment" "app_environment_name" NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"approval_id" uuid,
	"requested_by_user_id" uuid,
	"reason" text,
	"expires_at" timestamp with time zone,
	"expiry_reminded_at" timestamp with time zone,
	"pushed_version_id" uuid,
	"pushed_at" timestamp with time zone,
	"push_error" text,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app_grants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "grant_push_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"push_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"names" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "grant_push_targets_push_grant_key" UNIQUE("push_id","grant_id")
);
--> statement-breakpoint
ALTER TABLE "grant_push_targets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "grant_pushes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"resource_id" uuid NOT NULL,
	"environment" "app_environment_name" NOT NULL,
	"reason" text NOT NULL,
	"grant_id" uuid,
	"version_id" uuid,
	"approval_id" uuid,
	"status" text DEFAULT 'queued' NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"succeeded" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"instance_id" text,
	"started_by_user_id" uuid,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "grant_pushes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "shared_resource_values" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"resource_id" uuid NOT NULL,
	"environment" "app_environment_name" NOT NULL,
	"version" integer NOT NULL,
	"sealed" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"set_by_user_id" uuid,
	"set_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone,
	CONSTRAINT "shared_resource_values_version_key" UNIQUE("resource_id","environment","version"),
	CONSTRAINT "shared_resource_values_version_check" CHECK ("shared_resource_values"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "shared_resource_values" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "shared_resources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"display_name" text NOT NULL,
	"description" text,
	"owner_group_id" uuid NOT NULL,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"policies" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by_user_id" uuid,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shared_resources_tenant_slug_key" UNIQUE("tenant_id","slug")
);
--> statement-breakpoint
ALTER TABLE "shared_resources" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app_config_scans" ADD CONSTRAINT "app_config_scans_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_config_scans" ADD CONSTRAINT "app_config_scans_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_grants" ADD CONSTRAINT "app_grants_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_grants" ADD CONSTRAINT "app_grants_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_grants" ADD CONSTRAINT "app_grants_resource_id_shared_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."shared_resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_grants" ADD CONSTRAINT "app_grants_approval_id_approval_requests_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approval_requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_grants" ADD CONSTRAINT "app_grants_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_grants" ADD CONSTRAINT "app_grants_pushed_version_id_shared_resource_values_id_fk" FOREIGN KEY ("pushed_version_id") REFERENCES "public"."shared_resource_values"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_grants" ADD CONSTRAINT "app_grants_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_push_targets" ADD CONSTRAINT "grant_push_targets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_push_targets" ADD CONSTRAINT "grant_push_targets_push_id_grant_pushes_id_fk" FOREIGN KEY ("push_id") REFERENCES "public"."grant_pushes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_push_targets" ADD CONSTRAINT "grant_push_targets_grant_id_app_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."app_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_push_targets" ADD CONSTRAINT "grant_push_targets_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_pushes" ADD CONSTRAINT "grant_pushes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_pushes" ADD CONSTRAINT "grant_pushes_resource_id_shared_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."shared_resources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_pushes" ADD CONSTRAINT "grant_pushes_grant_id_app_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."app_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_pushes" ADD CONSTRAINT "grant_pushes_version_id_shared_resource_values_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."shared_resource_values"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_pushes" ADD CONSTRAINT "grant_pushes_approval_id_approval_requests_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approval_requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_pushes" ADD CONSTRAINT "grant_pushes_started_by_user_id_users_id_fk" FOREIGN KEY ("started_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_resource_values" ADD CONSTRAINT "shared_resource_values_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_resource_values" ADD CONSTRAINT "shared_resource_values_resource_id_shared_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."shared_resources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_resource_values" ADD CONSTRAINT "shared_resource_values_set_by_user_id_users_id_fk" FOREIGN KEY ("set_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_resources" ADD CONSTRAINT "shared_resources_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_resources" ADD CONSTRAINT "shared_resources_owner_group_id_groups_id_fk" FOREIGN KEY ("owner_group_id") REFERENCES "public"."groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_resources" ADD CONSTRAINT "shared_resources_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_config_scans_tenant_app_idx" ON "app_config_scans" USING btree ("tenant_id","app_id");--> statement-breakpoint
CREATE UNIQUE INDEX "app_grants_live_idx" ON "app_grants" USING btree ("app_id","resource_id","environment") WHERE "app_grants"."status" IN ('requested', 'active', 'revoking');--> statement-breakpoint
CREATE INDEX "app_grants_tenant_resource_env_status_idx" ON "app_grants" USING btree ("tenant_id","resource_id","environment","status");--> statement-breakpoint
CREATE INDEX "app_grants_tenant_app_idx" ON "app_grants" USING btree ("tenant_id","app_id");--> statement-breakpoint
CREATE INDEX "grant_push_targets_tenant_push_idx" ON "grant_push_targets" USING btree ("tenant_id","push_id");--> statement-breakpoint
CREATE UNIQUE INDEX "grant_pushes_active_idx" ON "grant_pushes" USING btree ("resource_id","environment") WHERE "grant_pushes"."status" IN ('queued', 'running');--> statement-breakpoint
CREATE UNIQUE INDEX "grant_pushes_approval_idx" ON "grant_pushes" USING btree ("approval_id") WHERE "grant_pushes"."approval_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "grant_pushes_tenant_resource_created_idx" ON "grant_pushes" USING btree ("tenant_id","resource_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "shared_resource_values_active_idx" ON "shared_resource_values" USING btree ("resource_id","environment") WHERE "shared_resource_values"."status" = 'active';--> statement-breakpoint
CREATE INDEX "shared_resource_values_tenant_resource_idx" ON "shared_resource_values" USING btree ("tenant_id","resource_id","environment");--> statement-breakpoint
CREATE INDEX "shared_resources_tenant_owner_group_idx" ON "shared_resources" USING btree ("tenant_id","owner_group_id");--> statement-breakpoint
CREATE POLICY "app_config_scans_tenant_isolation" ON "app_config_scans" AS PERMISSIVE FOR ALL TO "launch_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "app_grants_tenant_isolation" ON "app_grants" AS PERMISSIVE FOR ALL TO "launch_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "grant_push_targets_tenant_isolation" ON "grant_push_targets" AS PERMISSIVE FOR ALL TO "launch_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "grant_pushes_tenant_isolation" ON "grant_pushes" AS PERMISSIVE FOR ALL TO "launch_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "shared_resource_values_tenant_isolation" ON "shared_resource_values" AS PERMISSIVE FOR ALL TO "launch_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "shared_resources_tenant_isolation" ON "shared_resources" AS PERMISSIVE FOR ALL TO "launch_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);