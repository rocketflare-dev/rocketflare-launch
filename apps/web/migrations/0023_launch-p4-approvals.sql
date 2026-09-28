CREATE TYPE "public"."release_status" AS ENUM('tagged', 'staging', 'staging_active', 'awaiting_approval', 'promoting', 'production_active', 'rejected', 'failed');--> statement-breakpoint
ALTER TYPE "public"."deploy_decision_source" ADD VALUE 'approval';--> statement-breakpoint
CREATE TABLE "app_releases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"version" text NOT NULL,
	"tag" text NOT NULL,
	"sha" text NOT NULL,
	"previous_tag" text,
	"prs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "release_status" DEFAULT 'tagged' NOT NULL,
	"created_by_user_id" uuid,
	"approval_id" uuid,
	"staging_ticket_id" uuid,
	"production_ticket_id" uuid,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_releases_app_tag_key" UNIQUE("app_id","tag")
);
--> statement-breakpoint
ALTER TABLE "app_releases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "approval_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"user_email" text NOT NULL,
	"decision" text NOT NULL,
	"comment" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_decisions_request_user_key" UNIQUE("request_id","user_id"),
	CONSTRAINT "approval_decisions_comment_length" CHECK (char_length("approval_decisions"."comment") <= 1000)
);
--> statement-breakpoint
ALTER TABLE "approval_decisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "approval_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" uuid,
	"approvers" jsonb NOT NULL,
	"min_approvals" integer DEFAULT 1 NOT NULL,
	"allow_self_approval" boolean DEFAULT false NOT NULL,
	"expires_after_minutes" integer,
	"auto_approve_role" text,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_policies_scope_key" UNIQUE NULLS NOT DISTINCT("tenant_id","kind","scope_type","scope_id"),
	CONSTRAINT "approval_policies_min_approvals_check" CHECK ("approval_policies"."min_approvals" >= 1)
);
--> statement-breakpoint
ALTER TABLE "approval_policies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "approval_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"app_id" uuid,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_by_user_id" uuid,
	"requested_by_label" text,
	"reason" text,
	"context" jsonb NOT NULL,
	"policy" jsonb NOT NULL,
	"required_approvals" integer DEFAULT 1 NOT NULL,
	"excluded_user_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"expires_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"applied_at" timestamp with time zone,
	"apply_error" text,
	"apply_attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_requests_required_approvals_check" CHECK ("approval_requests"."required_approvals" >= 1)
);
--> statement-breakpoint
ALTER TABLE "approval_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "audit_chain" (
	"tenant_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"audit_event_id" uuid NOT NULL,
	"prev_hash" text NOT NULL,
	"hash" text NOT NULL,
	"sealed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_chain_pkey" PRIMARY KEY("tenant_id","seq"),
	CONSTRAINT "audit_chain_audit_event_id_key" UNIQUE("audit_event_id")
);
--> statement-breakpoint
ALTER TABLE "audit_chain" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "deploy_tickets" ADD COLUMN "release_id" uuid;--> statement-breakpoint
ALTER TABLE "deploy_tickets" ADD COLUMN "approval_id" uuid;--> statement-breakpoint
ALTER TABLE "app_releases" ADD CONSTRAINT "app_releases_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_releases" ADD CONSTRAINT "app_releases_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_releases" ADD CONSTRAINT "app_releases_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_releases" ADD CONSTRAINT "app_releases_approval_id_approval_requests_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approval_requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_decisions" ADD CONSTRAINT "approval_decisions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_decisions" ADD CONSTRAINT "approval_decisions_request_id_approval_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."approval_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_policies" ADD CONSTRAINT "approval_policies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_policies" ADD CONSTRAINT "approval_policies_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_chain" ADD CONSTRAINT "audit_chain_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_chain" ADD CONSTRAINT "audit_chain_audit_event_id_audit_events_id_fk" FOREIGN KEY ("audit_event_id") REFERENCES "public"."audit_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_releases_tenant_app_created_idx" ON "app_releases" USING btree ("tenant_id","app_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "approval_decisions_tenant_request_idx" ON "approval_decisions" USING btree ("tenant_id","request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "approval_requests_pending_subject_idx" ON "approval_requests" USING btree ("tenant_id","kind","subject_type","subject_id","app_id") WHERE "approval_requests"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "approval_requests_tenant_status_created_idx" ON "approval_requests" USING btree ("tenant_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "approval_requests_tenant_app_created_idx" ON "approval_requests" USING btree ("tenant_id","app_id","created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "deploy_tickets" ADD CONSTRAINT "deploy_tickets_release_id_app_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."app_releases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deploy_tickets" ADD CONSTRAINT "deploy_tickets_approval_id_approval_requests_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approval_requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_tenant_approval_idx" ON "audit_events" USING btree ("tenant_id","approval_id") WHERE "audit_events"."approval_id" IS NOT NULL;--> statement-breakpoint
CREATE POLICY "app_releases_tenant_isolation" ON "app_releases" AS PERMISSIVE FOR ALL TO "launch_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "approval_decisions_tenant_isolation" ON "approval_decisions" AS PERMISSIVE FOR ALL TO "launch_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "approval_policies_tenant_isolation" ON "approval_policies" AS PERMISSIVE FOR ALL TO "launch_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "approval_requests_tenant_isolation" ON "approval_requests" AS PERMISSIVE FOR ALL TO "launch_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "audit_chain_tenant_isolation" ON "audit_chain" AS PERMISSIVE FOR ALL TO "launch_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
-- Launch P4 (hand-written, appended): move P1's request-access queue onto the approvals engine,
-- then retire it. The generated DROPs of `app_access_requests` were moved down here so the copy runs
-- first; everything is one migration, so a failure leaves the old table in place.
--
-- 1. Every PENDING `app_access_requests` row becomes an `app.access` approval request with the SAME
--    id (so its `app.access.requested` audit row still names it), subject `user`, the person as
--    requester and as the one excluded decider, and the code default policy snapshotted exactly
--    as `DEFAULT_APPROVAL_POLICIES['app.access']` spells it (a test compares the two). A request is
--    given a fresh 14 days from now rather than from when it was made: migrating must not expire
--    somebody's open request under them. Decided rows are not copied — their audit rows are the
--    history, and nothing reads a decided P1 request after P4.
INSERT INTO "approval_requests" (
  "id", "tenant_id", "kind", "app_id", "subject_type", "subject_id", "status",
  "requested_by_user_id", "requested_by_label", "reason", "context", "policy",
  "required_approvals", "excluded_user_ids", "expires_at", "created_at", "updated_at"
)
SELECT
  r."id", r."tenant_id", 'app.access', r."app_id", 'user', r."user_id"::text, 'pending',
  r."user_id", NULL, r."message",
  jsonb_build_object('kind', 'app.access', 'userId', r."user_id", 'message', r."message"),
  '{"approvers":{"appOwners":true,"admins":false,"groupIds":[],"userIds":[]},"minApprovals":1,"allowSelfApproval":false,"expiresAfterMinutes":20160,"autoApproveRole":null}'::jsonb,
  1, jsonb_build_array(r."user_id"::text), now() + interval '14 days', r."created_at", r."created_at"
FROM "app_access_requests" r
WHERE r."status" = 'pending';--> statement-breakpoint
-- 2. Retire the P1 table and its enum (the statements drizzle-kit generated, moved here).
ALTER TABLE "app_access_requests" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY "app_access_requests_tenant_isolation" ON "app_access_requests" CASCADE;--> statement-breakpoint
DROP TABLE "app_access_requests" CASCADE;--> statement-breakpoint
DROP TYPE "public"."app_access_request_status";--> statement-breakpoint
-- 3. `approval_decisions` and `audit_chain` are APPEND-ONLY by the database, like `audit_events`
--    (P1): the same row trigger, raising unless `pg_trigger_depth() > 1` (a cascade — the tenant,
--    the request, the event). The function is replaced to name the table it guards; for
--    `audit_events` its message is unchanged. `db-roles.ts` revokes UPDATE/DELETE/TRUNCATE from
--    the app role (`APPEND_ONLY_TABLES`). No TRUNCATE trigger: the test harness truncates.
CREATE OR REPLACE FUNCTION "audit_events_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN COALESCE(OLD, NEW);
  END IF;
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "approval_decisions_append_only"
BEFORE UPDATE OR DELETE ON "approval_decisions"
FOR EACH ROW EXECUTE FUNCTION "audit_events_append_only"();--> statement-breakpoint
CREATE TRIGGER "audit_chain_append_only"
BEFORE UPDATE OR DELETE ON "audit_chain"
FOR EACH ROW EXECUTE FUNCTION "audit_events_append_only"();
