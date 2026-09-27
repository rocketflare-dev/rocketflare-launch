CREATE TABLE "analytics_page_groups" (
	"tenant_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	CONSTRAINT "analytics_page_groups_page_id_group_id_pk" PRIMARY KEY("page_id","group_id")
);
--> statement-breakpoint
ALTER TABLE "analytics_page_groups" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "analytics_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"template_key" text,
	"config" jsonb NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"visibility" text DEFAULT 'tenant' NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "analytics_pages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "analytics_tenant_activity_daily_facts" (
	"tenant_id" uuid NOT NULL,
	"day" date NOT NULL,
	"user_id" uuid,
	"event_count" integer NOT NULL,
	"distinct_event_types" integer NOT NULL,
	"first_event_at" timestamp with time zone NOT NULL,
	"last_event_at" timestamp with time zone NOT NULL,
	"fact_refreshed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "analytics_tenant_activity_daily_facts_grain" UNIQUE NULLS NOT DISTINCT("tenant_id","day","user_id")
);
--> statement-breakpoint
ALTER TABLE "analytics_tenant_activity_daily_facts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "analytics_page_groups" ADD CONSTRAINT "analytics_page_groups_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_page_groups" ADD CONSTRAINT "analytics_page_groups_page_id_analytics_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."analytics_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_page_groups" ADD CONSTRAINT "analytics_page_groups_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_pages" ADD CONSTRAINT "analytics_pages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_pages" ADD CONSTRAINT "analytics_pages_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_tenant_activity_daily_facts" ADD CONSTRAINT "analytics_tenant_activity_daily_facts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "analytics_page_groups_tenant_group_idx" ON "analytics_page_groups" USING btree ("tenant_id","group_id");--> statement-breakpoint
CREATE UNIQUE INDEX "analytics_pages_tenant_slug_idx" ON "analytics_pages" USING btree ("tenant_id","slug");--> statement-breakpoint
CREATE INDEX "analytics_pages_tenant_order_idx" ON "analytics_pages" USING btree ("tenant_id","sort_order");--> statement-breakpoint
CREATE INDEX "analytics_tenant_activity_daily_facts_tenant_day_idx" ON "analytics_tenant_activity_daily_facts" USING btree ("tenant_id","day");--> statement-breakpoint
CREATE POLICY "analytics_page_groups_tenant_isolation" ON "analytics_page_groups" AS PERMISSIVE FOR ALL TO "launch_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "analytics_pages_tenant_isolation" ON "analytics_pages" AS PERMISSIVE FOR ALL TO "launch_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "analytics_tenant_activity_daily_facts_tenant_isolation" ON "analytics_tenant_activity_daily_facts" AS PERMISSIVE FOR ALL TO "launch_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);