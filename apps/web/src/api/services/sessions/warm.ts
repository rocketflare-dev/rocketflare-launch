/**
 * Warm suspends (Launch P3, fast resume): how long a quiet session keeps its container.
 *
 * Two thresholds, both counted from the session's activity clock:
 *
 * 1. **`policy.idleSuspendMinutes`** (default 30, `launch_settings.session_policy`): a live session
 *    quiet this long is SUSPENDED — checkpointed, the preview answers 503 — but its container is
 *    KEPT, dev server and all (`sessions.container_kept_at`). A resume inside the next window
 *    finds its boot marker, skips the clone, the install and the bootstrap, and restarts the dev
 *    server only if it stopped answering: seconds instead of minutes.
 * 2. **{@link SESSION_WARM_KEEP_MINUTES}** after that suspend, the container is destroyed (the
 *    `cool#N` step, which backs the workspace up first when backups are on) and a later resume is
 *    a cold boot. A drain, a rollout and the Sandbox's own `sleepAfter` destroy it sooner.
 *
 * `SESSION_SANDBOX_SLEEP_AFTER` (the SDK's idle sleep, `sandbox/cloudflare-sandbox.ts`) must stay
 * LONGER than {@link SESSION_WARM_KEEP_MINUTES}, or the SDK stops a warm container before the
 * Workflow cools it (a config test pins the order). A warm container costs container time while
 * it waits — `sessions.container_seconds` counts it.
 */

/** How long a session suspended for idleness keeps its container before it is destroyed. */
export const SESSION_WARM_KEEP_MINUTES = 45

/**
 * Minutes left of a kept container's warm window (at least 1 while any is left; 0 once it has
 * passed), or null when the session keeps no container.
 */
export function warmMinutesLeft(
  containerKeptAt: Date | null,
  now: Date,
  keepMinutes = SESSION_WARM_KEEP_MINUTES
): number | null {
  if (!containerKeptAt) return null
  const kept = (now.getTime() - containerKeptAt.getTime()) / 60_000
  const left = keepMinutes - kept
  return left <= 0 ? 0 : Math.max(1, Math.ceil(left))
}

// ---- warm starts (issue #17) -------------------------------------------------------------------

/**
 * Warm on intent (issue #17): the app page's Start / Build it creates the session the moment the
 * person opens the composer (`warm: true` on the request), so `claim` → `db` ‖ `sandbox.start` →
 * `repo` → `bootstrap` → `dev` run while they type, and their first message finds it `ready` (or
 * waits on the row for it). Until that first message the session is an UNPROMPTED warm start
 * ({@link isUnpromptedWarmStart}):
 *
 * - the same person's next start on the app returns it instead of a second one (`createSession`);
 * - it counts against the policy's `maxWarmPerUser` (409 `warm_session_limit`) as well as
 *   `maxConcurrentPerApp`;
 * - quiet for {@link warmStartMinutes} (the person's use of the preview counts as activity), it
 *   ENDS — `end#N` with reason `unprompted`: no checkpoint (nothing was asked, so nothing is
 *   saved), then `cleanup` destroys the container and deletes the branch — instead of the idle
 *   suspend that keeps a container for {@link SESSION_WARM_KEEP_MINUTES}; a suspended one (a
 *   drain, a rollout) nobody asked to resume ends at once. No turn runs, so `turn_count` stays 0.
 */
export const SESSION_WARM_START_MINUTES = 15

/** How long an unprompted warm start may sit quiet: the shorter of the policy's idle window and ours. */
export function warmStartMinutes(policy: { idleSuspendMinutes: number }): number {
  return Math.min(policy.idleSuspendMinutes, SESSION_WARM_START_MINUTES)
}

/** A warm start nobody has written to yet. Pure. */
export function isUnpromptedWarmStart(session: {
  warmStart: boolean
  turnCount: number
  pendingMessage: string | null
}): boolean {
  return session.warmStart && session.turnCount === 0 && session.pendingMessage === null
}
