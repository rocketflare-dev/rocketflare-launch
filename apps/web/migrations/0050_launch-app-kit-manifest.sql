-- D36 K2: the kit manifest an app is driven by (kits/adapter.ts adapterFor). No backfill: an app
-- from before K2 has none and resolves to its kit's snapshot, else the Rocketflare fallback.
ALTER TABLE "apps" ADD COLUMN "kit_manifest" jsonb;
