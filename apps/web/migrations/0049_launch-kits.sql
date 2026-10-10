CREATE TABLE "kits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"repo" text NOT NULL,
	"pin" jsonb,
	"manifest" jsonb,
	"manifest_source" text,
	"contract_version" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'unchecked' NOT NULL,
	"problems" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"checked_at" timestamp with time zone,
	"latest_check" jsonb,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "kit_id" uuid;--> statement-breakpoint
ALTER TABLE "kits" ADD CONSTRAINT "kits_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "kits_slug_key" ON "kits" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "kits_one_default_idx" ON "kits" USING btree ("is_default") WHERE "kits"."is_default";--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_kit_id_kits_id_fk" FOREIGN KEY ("kit_id") REFERENCES "public"."kits"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- D36 K1 data: the built-in Rocketflare kit, the default, carrying the `template_pin` setting when
-- one is set (its repo on the row, the rest as the pin) — else no pin, i.e. Launch's code default
-- (`DEFAULT_TEMPLATE_PIN`), as an unset setting meant. The setting row is left in place: Launch
-- keeps it mirrored for one release so a rollback reads the same pin (`kits/store.ts`).
INSERT INTO "kits" ("slug", "name", "description", "repo", "pin", "is_default", "latest_check")
SELECT
	'rocketflare',
	'Rocketflare',
	'Multi-tenant SaaS starter for internal tools and B2B products',
	CASE WHEN p.valid THEN p.value->>'repo' ELSE 'rocketflare-dev/rocketflare' END,
	CASE WHEN p.valid THEN p.value - 'repo' ELSE NULL END,
	true,
	(SELECT "value" FROM "launch_settings" WHERE "key" = 'template_pin_check')
FROM (
	SELECT
		(SELECT "value" FROM "launch_settings" WHERE "key" = 'template_pin') AS value,
		coalesce((
			SELECT jsonb_typeof("value") = 'object'
				AND ("value"->>'repo') ~ '^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$'
				AND ("value"->>'commit') ~ '^[0-9a-f]{40}$'
			FROM "launch_settings" WHERE "key" = 'template_pin'
		), false) AS valid
) AS p
ON CONFLICT DO NOTHING;--> statement-breakpoint
UPDATE "apps" SET "kit_id" = (SELECT "id" FROM "kits" WHERE "is_default") WHERE "kit_id" IS NULL;
