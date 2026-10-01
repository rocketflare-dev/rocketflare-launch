/**
 * Issue #5 (`docs/plans/i5-ship-to-staging.md`): a piece a later slice builds. Thrown by S1's stubs
 * so a call that arrives too early fails by NAME rather than by `undefined is not a function` (the
 * P3/P4/P5 pattern — `sessions/ports.ts`, `approvals/types.ts`, `grants/types.ts`). Delete this
 * file once nothing throws it.
 */
export class NotWiredError extends Error {
  constructor(what: string, slice: 'S2' | 'S3' | 'S4') {
    super(`${what} is not wired yet (issue #5 slice ${slice}, docs/plans/i5-ship-to-staging.md)`)
    this.name = 'NotWiredError'
  }
}
