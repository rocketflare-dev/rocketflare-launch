/**
 * What `apps/web/src/plugins/schema.ts` re-exports for the analytics plugin — and, through it, what
 * `db/schema/index.ts` hands to drizzle-kit, to `typeof schema` and to `rls-coverage.test.ts`.
 *
 * Nothing here is ever copied into a migration: the HOST runs `pnpm db:generate` once the barrel
 * line exists, so the DDL is numbered in the host's own journal (D31).
 *
 * Every table is `analytics_*` — the `<id>_*` namespacing rule — which is why the fact table is
 * `analytics_tenant_activity_daily_facts` rather than the name it carried while analytics lived in
 * the kit (D31 decision 7: no compatibility path; the 0.6.0 note says the old one is dropped).
 *
 * `relations()` is declared for THIS plugin's tables only. A second `relations()` for a core table
 * merges at runtime but not at the type level on drizzle-orm 0.45.2 — it silently strips `with:`
 * from that table's query results app-wide (see `apps/web/src/plugins/schema.ts`).
 */
export * from './analytics-page-groups'
export * from './analytics-pages'
export * from './facts'
