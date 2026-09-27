/**
 * The shape a cube-isolation case takes (D31 decision 6), declared here rather than in the test so
 * a CONTRIBUTING plugin can import a type without reaching into anybody's tests.
 *
 * **A cube is not done until it has a case.** drizzle-cube adds no second line of defence — an
 * unscoped cube hands every tenant's rows to every member — so the coverage assertion in
 * `tests/api/cube-isolation.test.ts` compares the case keys to the whole registry, this plugin's
 * cubes and every contributed one together. A contributed cube with no case fails the host's suite.
 */
import type { Database } from '@/plugins/api'

export type IsolationSide = 'a' | 'b'
export type IsolationRows = Array<Record<string, unknown>>

export interface CubeIsolationCase {
  /** The cube's `name`, which is what the coverage assertion matches on. */
  cube: string
  /** Rows for this cube's table, for ONE of the two seeded tenants. */
  seed?: (db: Database, ctx: { tenantId: string; userId: string }) => Promise<void>
  /** A `POST /cubejs-api/v1/load` query body. */
  query: unknown
  /** What that tenant — and only that tenant — must get back. */
  expect: (rows: IsolationRows, side: IsolationSide) => void
}
