# drizzle-cube 0.8.3: cube API reference (as this app uses it)

Checked against the published `drizzle-cube@0.8.3` type declarations (`dist/server/types/cube.d.ts`,
`core.d.ts`, `cube-utils.d.ts`). The current 0.9.x has the same `defineCube`, `Measure` and
`CubeJoin` shapes. If you bump the pin, re-check this file against the new `.d.ts`.

## `defineCube(name, definition): Cube`

| Field | Type | Notes |
|---|---|---|
| `title`, `description` | string | shown in the explorer and to MCP clients |
| `sql` | `(ctx: QueryContext) => BaseQueryDefinition` | **required**; returns `{ from, where }`, and `where` must include `eq(table.tenantId, tenantIdOf(ctx))` |
| `dimensions` | `Record<string, Dimension>` | exactly one `primaryKey: true` |
| `measures` | `Record<string, Measure>` | |
| `joins` | `Record<string, CubeJoin>` | keyed by the TARGET cube's name |
| `meta` | `Record<string, any>` | `eventStream` unlocks funnel, flow and retention (below) |

## Dimension

`{ name, title?, description?, synonyms?, type, sql, primaryKey?, shown?, format?, granularities? }`

- `type`: `'string' | 'number' | 'time' | 'boolean'`
- `sql`: a column, a drizzle `sql\`…\`` expression, or `(ctx) => column | SQL`
- `synonyms`: alternative names that MCP `discover` matches on (for example `['signups', 'joins']`).
  Cheap to add, and it makes natural-language questions land.

## Measure

`{ name, title?, description?, synonyms?, type, sql?, filters?, format?, calculatedSql?, drillMembers?, rollingWindow? }`

- `type`: `count`, `countDistinct`, `countDistinctApprox`, `sum`, `avg`, `min`, `max`,
  `runningTotal`, `number`, `calculated`, `stddev`, `stddevSamp`, `variance`, `varianceSamp`,
  `percentile`, `median`, `p95`, `p99`, `lag`, `lead`, `rank`, `denseRank`, `rowNumber`, `ntile`,
  `firstValue`, `lastValue`, `movingAvg`, `movingSum`
- `filters`: `Array<(ctx: QueryContext) => SQL>`, for example `[() => eq(t.role, 'owner')]`. **Not**
  `[{ sql: … }]`.
- `calculated`: set `calculatedSql` to a template over OTHER measures of the same cube, for example
  `"1.0 * {paidCount} / NULLIF({count}, 0)"`. Leave `sql` unset.

## CubeJoin

```ts
joins: {
  Users: {
    targetCube: () => usersCube,             // thunk: breaks import cycles
    relationship: 'belongsTo',               // 'belongsTo' | 'hasOne' | 'hasMany' | 'belongsToMany'
    on: [{ source: orders.userId, target: users.id }],
    // sqlJoinType?: 'inner' | 'left' | 'right' | 'full'
  },
}
```

- **In this app**, declare `belongsTo` only. The reverse direction works without declaring it, and
  a declared `hasMany` breaks ungrouped queries that mix the two cubes (`cubes/CLAUDE.md`).
- `belongsToMany` goes through a junction table:
  `through: { table, sourceKey: [{ source, target }], targetKey: [{ source, target }], securitySql?: (securityContext) => SQL | SQL[] }`.
  **Give the junction its own tenant predicate in `securitySql`**; the target cube's predicate does
  not cover it.

## Event streams: `meta.eventStream`

```ts
meta: {
  eventStream: {
    bindingKey: 'ActivityEvents.userId',     // who: the entity followed across steps
    timeDimension: 'ActivityEvents.createdAt',
    eventDimension: 'ActivityEvents.type',   // what happened
  },
},
```

With this set, the explorer offers **Funnel**, **Flow** and **Retention** modes over the cube, and
`/cubejs-api/v1/load` accepts `funnel` / `flow` / `retention` queries (`analytics-queries`).

## The security context this app passes

Built in `api/routes/cube-api.ts` → `buildSecurityContext(ctx.detached())`:

`{ tenantId, userId, role, groupIds, groups (names by type), groupIdsByType, isAdmin }`

- Scope by tenant with `tenantIdOf(ctx)`. It throws if there's no tenant, rather than silently
  compiling `tenant_id = NULL`.
- `groupFilter(ctx, typeName, column)` narrows by group ids of one type. It returns `undefined` for
  admins and `false` for a reader with no group of that type.
- `role` is present but **no cube should restrict rows by role**. Access is membership plus
  `read Analytics`; row filtering is by tenant (and by group, where you choose to).

Sources: https://www.npmjs.com/package/drizzle-cube/v/0.8.3 · https://www.drizzle-cube.dev ·
`apps/web/src/plugins/analytics/cubes/{CLAUDE.md,security.ts}`
