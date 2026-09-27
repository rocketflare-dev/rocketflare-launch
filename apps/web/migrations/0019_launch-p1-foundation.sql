CREATE TYPE "public"."credential_check_status" AS ENUM('ok', 'warning', 'failed');--> statement-breakpoint
CREATE TYPE "public"."credential_kind" AS ENUM('cloudflare_api_token', 'neon_org_api_key', 'resend_api_key', 'github_app');--> statement-breakpoint
CREATE TYPE "public"."app_environment_name" AS ENUM('staging', 'production');--> statement-breakpoint
CREATE TYPE "public"."health_status" AS ENUM('unknown', 'up', 'degraded', 'down');--> statement-breakpoint
CREATE TYPE "public"."app_operation_status" AS ENUM('pending', 'running', 'succeeded', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."app_source" AS ENUM('imported', 'created');--> statement-breakpoint
CREATE TYPE "public"."app_status" AS ENUM('requested', 'provisioning', 'live', 'archived', 'failed');--> statement-breakpoint
CREATE TYPE "public"."audit_actor_type" AS ENUM('user', 'system', 'app');--> statement-breakpoint
CREATE TYPE "public"."app_access_request_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."oidc_access_policy" AS ENUM('company', 'restricted');--> statement-breakpoint
CREATE TYPE "public"."oidc_signing_key_status" AS ENUM('next', 'active', 'retiring', 'retired');--> statement-breakpoint
CREATE TABLE "admin_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "credential_kind" NOT NULL,
	"sealed" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_check_status" "credential_check_status",
	"last_check" jsonb,
	"last_checked_at" timestamp with time zone,
	"set_by_user_id" uuid,
	"set_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_credentials_kind_key" UNIQUE("kind")
);
--> statement-breakpoint
CREATE TABLE "launch_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by_user_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_environments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"name" "app_environment_name" NOT NULL,
	"url" text,
	"worker_name" text,
	"resources" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"neon" jsonb,
	"resend_key_id" text,
	"route_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_deploy_version" text,
	"last_deploy_at" timestamp with time zone,
	"last_deploy_by" text,
	"health_status" "health_status" DEFAULT 'unknown' NOT NULL,
	"health_checked_at" timestamp with time zone,
	"health_changed_at" timestamp with time zone,
	"health_version" text,
	"health_latency_ms" integer,
	"health_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_environments_app_name_key" UNIQUE("app_id","name")
);
--> statement-breakpoint
ALTER TABLE "app_environments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app_health_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" "health_status" NOT NULL,
	"http_status" integer,
	"ready_status" integer,
	"latency_ms" integer,
	"version" text,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "app_health_checks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"step" text NOT NULL,
	"status" "app_operation_status" DEFAULT 'pending' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"error" text,
	"external_ids" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_operations_run_step_key" UNIQUE("run_id","step")
);
--> statement-breakpoint
ALTER TABLE "app_operations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app_owners" (
	"tenant_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_owners_app_id_user_id_pk" PRIMARY KEY("app_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "app_owners" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "apps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"display_name" text NOT NULL,
	"description" text,
	"owner_group_id" uuid,
	"source" "app_source" NOT NULL,
	"template" text DEFAULT 'rocketflare' NOT NULL,
	"template_contract_version" text,
	"template_version" text,
	"repo_owner" text,
	"repo_name" text,
	"default_branch" text,
	"status" "app_status" DEFAULT 'requested' NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "apps_slug_key" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "apps" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_type" "audit_actor_type" NOT NULL,
	"actor_user_id" uuid,
	"actor_email" text,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"app_id" uuid,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"request_id" text,
	"approval_id" uuid,
	"ip" text,
	"user_agent" text
);
--> statement-breakpoint
ALTER TABLE "audit_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app_access_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"message" text,
	"status" "app_access_request_status" DEFAULT 'pending' NOT NULL,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app_access_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "oidc_client_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"group_id" uuid,
	"user_id" uuid,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oidc_client_grants_grantee_key" UNIQUE NULLS NOT DISTINCT("client_id","group_id","user_id"),
	CONSTRAINT "oidc_client_grants_one_grantee" CHECK (num_nonnulls("oidc_client_grants"."group_id", "oidc_client_grants"."user_id") = 1)
);
--> statement-breakpoint
ALTER TABLE "oidc_client_grants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "oidc_clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"secret_hash" text NOT NULL,
	"secret_hint" text NOT NULL,
	"secret_rotated_at" timestamp with time zone,
	"redirect_uris" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"post_logout_redirect_uris" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"access_policy" "oidc_access_policy" DEFAULT 'company' NOT NULL,
	"disabled_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oidc_clients_app_id_key" UNIQUE("app_id"),
	CONSTRAINT "oidc_clients_client_id_key" UNIQUE("client_id")
);
--> statement-breakpoint
ALTER TABLE "oidc_clients" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "oidc_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_row_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" uuid,
	"redirect_uri" text NOT NULL,
	"code_challenge" text NOT NULL,
	"nonce" text,
	"scope" text NOT NULL,
	"auth_time" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"access_token_jti" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oidc_codes_code_hash_key" UNIQUE("code_hash")
);
--> statement-breakpoint
ALTER TABLE "oidc_codes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "oidc_signing_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kid" text NOT NULL,
	"alg" text DEFAULT 'ES256' NOT NULL,
	"public_jwk" jsonb NOT NULL,
	"private_jwk_sealed" text NOT NULL,
	"status" "oidc_signing_key_status" DEFAULT 'next' NOT NULL,
	"activated_at" timestamp with time zone,
	"retire_after" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" uuid,
	CONSTRAINT "oidc_signing_keys_kid_key" UNIQUE("kid")
);
--> statement-breakpoint
ALTER TABLE "admin_credentials" ADD CONSTRAINT "admin_credentials_set_by_user_id_users_id_fk" FOREIGN KEY ("set_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "launch_settings" ADD CONSTRAINT "launch_settings_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_environments" ADD CONSTRAINT "app_environments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_environments" ADD CONSTRAINT "app_environments_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_health_checks" ADD CONSTRAINT "app_health_checks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_health_checks" ADD CONSTRAINT "app_health_checks_environment_id_app_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."app_environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_operations" ADD CONSTRAINT "app_operations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_operations" ADD CONSTRAINT "app_operations_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_owners" ADD CONSTRAINT "app_owners_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_owners" ADD CONSTRAINT "app_owners_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_owners" ADD CONSTRAINT "app_owners_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_owners" ADD CONSTRAINT "app_owners_membership_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."tenant_users"("tenant_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_owner_group_id_groups_id_fk" FOREIGN KEY ("owner_group_id") REFERENCES "public"."groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_access_requests" ADD CONSTRAINT "app_access_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_access_requests" ADD CONSTRAINT "app_access_requests_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_access_requests" ADD CONSTRAINT "app_access_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_access_requests" ADD CONSTRAINT "app_access_requests_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oidc_client_grants" ADD CONSTRAINT "oidc_client_grants_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oidc_client_grants" ADD CONSTRAINT "oidc_client_grants_client_id_oidc_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oidc_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oidc_client_grants" ADD CONSTRAINT "oidc_client_grants_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oidc_client_grants" ADD CONSTRAINT "oidc_client_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oidc_client_grants" ADD CONSTRAINT "oidc_client_grants_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oidc_clients" ADD CONSTRAINT "oidc_clients_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oidc_clients" ADD CONSTRAINT "oidc_clients_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oidc_clients" ADD CONSTRAINT "oidc_clients_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oidc_codes" ADD CONSTRAINT "oidc_codes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oidc_codes" ADD CONSTRAINT "oidc_codes_client_row_id_oidc_clients_id_fk" FOREIGN KEY ("client_row_id") REFERENCES "public"."oidc_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oidc_codes" ADD CONSTRAINT "oidc_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oidc_signing_keys" ADD CONSTRAINT "oidc_signing_keys_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_environments_tenant_app_idx" ON "app_environments" USING btree ("tenant_id","app_id");--> statement-breakpoint
CREATE INDEX "app_health_checks_tenant_env_checked_idx" ON "app_health_checks" USING btree ("tenant_id","environment_id","checked_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "app_operations_tenant_app_created_idx" ON "app_operations" USING btree ("tenant_id","app_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "app_owners_tenant_user_idx" ON "app_owners" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE INDEX "apps_tenant_status_idx" ON "apps" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "audit_events_tenant_at_idx" ON "audit_events" USING btree ("tenant_id","at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_events_tenant_target_idx" ON "audit_events" USING btree ("tenant_id","target_type","target_id");--> statement-breakpoint
CREATE INDEX "audit_events_tenant_app_at_idx" ON "audit_events" USING btree ("tenant_id","app_id","at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "app_access_requests_pending_idx" ON "app_access_requests" USING btree ("app_id","user_id") WHERE "app_access_requests"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "app_access_requests_tenant_app_status_idx" ON "app_access_requests" USING btree ("tenant_id","app_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "oidc_client_grants_tenant_client_idx" ON "oidc_client_grants" USING btree ("tenant_id","client_id");--> statement-breakpoint
CREATE INDEX "oidc_clients_tenant_idx" ON "oidc_clients" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "oidc_codes_access_token_jti_idx" ON "oidc_codes" USING btree ("access_token_jti");--> statement-breakpoint
CREATE INDEX "oidc_codes_tenant_expires_idx" ON "oidc_codes" USING btree ("tenant_id","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "oidc_signing_keys_one_active_idx" ON "oidc_signing_keys" USING btree ("status") WHERE "oidc_signing_keys"."status" = 'active';--> statement-breakpoint
CREATE POLICY "app_environments_tenant_isolation" ON "app_environments" AS PERMISSIVE FOR ALL TO "launch_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "app_health_checks_tenant_isolation" ON "app_health_checks" AS PERMISSIVE FOR ALL TO "launch_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "app_operations_tenant_isolation" ON "app_operations" AS PERMISSIVE FOR ALL TO "launch_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "app_owners_tenant_isolation" ON "app_owners" AS PERMISSIVE FOR ALL TO "launch_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "apps_tenant_isolation" ON "apps" AS PERMISSIVE FOR ALL TO "launch_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "audit_events_tenant_isolation" ON "audit_events" AS PERMISSIVE FOR ALL TO "launch_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "app_access_requests_tenant_isolation" ON "app_access_requests" AS PERMISSIVE FOR ALL TO "launch_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "oidc_client_grants_tenant_isolation" ON "oidc_client_grants" AS PERMISSIVE FOR ALL TO "launch_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "oidc_clients_tenant_isolation" ON "oidc_clients" AS PERMISSIVE FOR ALL TO "launch_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "oidc_codes_tenant_isolation" ON "oidc_codes" AS PERMISSIVE FOR ALL TO "launch_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
-- Launch (spec/08): audit_events is APPEND-ONLY by the database. The Worker connects as the table
-- owner, which no GRANT restricts, so this trigger is the real enforcement (db-roles.ts also
-- REVOKEs UPDATE/DELETE/TRUNCATE from launch_app). A row trigger at depth 1 is a direct statement
-- and is refused; at depth > 1 it is the tenants FK cascade (RI triggers run the DELETE), which
-- must still work so deleting a tenant removes its log. No TRUNCATE trigger: the test harness
-- truncates between runs.
CREATE FUNCTION "audit_events_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN COALESCE(OLD, NEW);
  END IF;
  RAISE EXCEPTION 'audit_events is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "audit_events_append_only"
BEFORE UPDATE OR DELETE ON "audit_events"
FOR EACH ROW EXECUTE FUNCTION "audit_events_append_only"();
