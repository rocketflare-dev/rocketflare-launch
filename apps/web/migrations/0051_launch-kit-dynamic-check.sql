-- D36 K3: the last dynamic conformance check of a kit (kits/dynamic-check.ts) — the scaffold job
-- run against a throwaway repo. Null until one runs; a re-pin clears it.
ALTER TABLE "kits" ADD COLUMN "dynamic_check" jsonb;