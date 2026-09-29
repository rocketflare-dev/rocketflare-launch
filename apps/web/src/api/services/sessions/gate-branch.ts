/**
 * The ship gate's throwaway database branch, by NAME (issue #1) — a leaf, so the Neon adapter, the
 * gate and the sweep share one definition without importing each other.
 *
 * `gate-<shortId>-<attempt>` is exactly what the kit's `safetyCheck()` accepts as
 * `TEST_DATABASE_BRANCH` (kit 0.15.7, `apps/web/tests/helpers/db-safety.ts` `GATE_BRANCH_RE`): a
 * session's short id is base32 (`[a-z2-7]{12}`), so the name always matches. The prefix is also how
 * cleanup finds a session's gate branches (`gate-<shortId>-`), and how the cron sweep finds any
 * gate branch at all (`gate-`), with no row recording them.
 */

/** The kit's `GATE_BRANCH_RE`, verbatim (kit 0.15.7, `tests/helpers/db-safety.ts`). */
export const GATE_BRANCH_RE = /^gate-[a-z0-9]+-\d+$/

/** Every gate branch's name starts with this — the sweep's filter (with {@link GATE_BRANCH_RE}). */
export const GATE_BRANCH_PREFIX = 'gate-'

/** The prefix of one session's gate branches. */
export const gateBranchPrefix = (shortId: string): string => `${GATE_BRANCH_PREFIX}${shortId}-`

/** The gate branch of one attempt: `gate-<shortId>-<attempt>`. */
export function gateBranchName(shortId: string, attempt: number): string {
  const name = `${gateBranchPrefix(shortId)}${attempt}`
  if (!GATE_BRANCH_RE.test(name)) throw new Error(`Not a gate branch name: ${name}`)
  return name
}

/** A gate branch of THIS session (`gate-<shortId>-<n>`). */
export function isGateBranchOf(name: string, shortId: string): boolean {
  return GATE_BRANCH_RE.test(name) && name.startsWith(gateBranchPrefix(shortId))
}

/** Any session's gate branch. */
export const isGateBranch = (name: string): boolean => GATE_BRANCH_RE.test(name)

/**
 * A gate branch older than this is an orphan, and the `*\/5` sweep deletes it
 * (`gate-sweep.ts`). One lives for ONE attempt's test step — at most the test deadline
 * (`SHIP_GATE_COMMANDS.test`) plus the branch's own creation — so three hours is far past any
 * live one, and short enough that an orphan does not hold one of the project's branch slots
 * (Neon caps them: 10 on Launch, 25 on Scale) for long.
 */
export const GATE_BRANCH_MAX_AGE_MS = 3 * 60 * 60 * 1000
