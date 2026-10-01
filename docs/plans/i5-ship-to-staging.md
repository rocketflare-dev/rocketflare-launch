# Issue #5: Ship means "live on staging"

The build plan for rocketflare-launch#5, parts 1–7 plus spec and docs. Part 8, the "Promote to
production" strip on `AppDetailPage`, is already built (commit c9dfef5: `launch-promotion.ts`,
`releases/promotion.ts`, `GET /api/apps/:id/promotion`, `PipelineStrip`, `PromoteDialog`); this
plan only feeds it data. Checked against `main` at 2406739.

Ship today ends at an open PR. The ship round (`apps/web/src/api/workflows/session.ts:484-569`)
runs the gate, opens the PR (`services/sessions/ship.ts:428`) and settles `shipping → shipped`.
The loop then returns, and `cleanupStep` (`services/sessions/steps.ts:1841-1913`) destroys the
container and the Neon branch. After that only `sessions.checks` follows the PR to its merge
(`services/sessions/checks-cron.ts:67-145`), and someone has to press Release
(`services/launch/releases/release.ts:269`).

**Exit test:** a person presses Ship and, with no GitHub visit, the session ends on "Live on
staging: <url>, version X.Y.Z". With the review policy on, nothing merges until an approver in
Launch approves. Production is unchanged: Promote, then `deploy.production`.

## 0. The user's decisions (2026-10-01)

1. **A failure after the merge stalls the session; it never reopens.** Release, deploy and
   health failures end the session as `shipped` with stage `stalled`, a sentence and a link to
   the app page. The change is already in `main`.
2. **Every app defaults to `staging`, imported ones included.** hola-world's next ship merges.
3. **Owners and admins set an app's review policy; an admin `approval_policies` row for
   `session.merge` wins**, and the app setting then shows read-only. This relaxes P4 §1.5 for
   this one kind.
4. **A `session.merge` approval expires after 2 days** (`SESSION_MERGE_EXPIRY_HOURS = 48`).
5. **The required check is `Gate`.** The kit's `ci.yml` job `gate` is named `Gate`
   (`KIT_REQUIRED_CHECK = 'Gate'`). App repos live in the `guidemode` org (GitHub Team), so
   rulesets on private repos are available. `unavailable` handling stays, for other owners.

## 1. Decisions

1. **No new session statuses; the jsonb column `sessions.landing` holds the stage.**
   - `shipping` now spans the gate AND what follows the PR (CI, review, merge). `shipped` now
     means merged, or "PR open" in `pr` mode. The stage is `sessions.landing.stage`:
     `ci | approval | merging | releasing | deploying | live | pr | stalled`.
   - Why: `shipping` is already active, non-terminal, End-able (`routes/session-ship.ts:130-138`)
     and served by the preview gateway (`api/preview/gateway.ts:83`). `shipped` is already
     terminal everywhere it is read (`SessionPage.tsx:46`, `SessionHeader.tsx:85`,
     `apps/cli/src/commands/sessions.ts:364`, `steps.ts:1869`, `checks-cron.ts:89`). A new
     `session_status` value would change `sessions_app_active_idx` (predicate rendered from
     `ACTIVE_SESSION_STATUSES`, `packages/shared/src/launch-sessions.ts:71-80`,
     `db/schema/sessions.ts:80`), and Drizzle's migrator runs all pending migrations in ONE
     transaction, where Postgres refuses a freshly added enum value.
   - `sessions.checks`'s merge follower skips Launch-merged PRs on its own, because `pr.merged`
     is already recorded (`checks-cron.ts:91-99`).
2. **The chain after the PR runs in `SESSION_WORKFLOW`, in two phases.**
   - **Phase A** (status `shipping`; stages `ci → [approval] → merging`) runs inside the turn
     loop, so a failure can reopen the session. `inspectStep` (`steps.ts:1297`) returns a new
     action `land` when a `shipping` row has a `landing`; the loop dispatches it to
     `SessionWorkflow.land(run, step, n, bootId)`. The `land` check comes BEFORE the
     `maxSessionHours` end and after an explicit End, so a merge never stops half-way.
   - **Phase B** (status `shipped`; stages `releasing → deploying → live | stalled`) runs after
     `cleanup`: `run()` calls `this.finish()` (container and branch freed at once), then
     `this.release(run, step)` when the loop reported it merged.
   - Why the split: the merge is the point of no return. Before it the session must be
     resumable; after it nothing needs the container or the Neon branch. Not a separate
     Workflow: the session row is already the claim and the reconcile/restart tooling
     (`lifecycle.ts:95,110`) exists.
3. **Step names and the claim.**
   - Phase A, per loop round `N`: `inspect#N`, then `land.ci#N` + `land.wait#N`
     (`waitForEvent(SESSION_WAKE_EVENT)` for one round); or `land.review#N` + `land.wait#N`; or
     `land.merge#N`; or `land.reopen#N`.
   - Phase B, with counter `K`: `land.release#K.R` / `land.release-wait#K.R`,
     `land.staging#K.R` / `land.staging-wait#K.R`, `land.health#K.R` / `land.health-wait#K.R`,
     `land.live#K` or `land.stalled#K`.
   - `claimStep` (`steps.ts:457`): `shipping` with a `landing` → `{start:'loop'}`, never
     salvage (`SALVAGE_STATUSES`, `steps.ts:442`); `shipped` with stage `releasing | deploying`
     → `{start:'land'}`, after `cleanup` if `ended_at` is still null.
4. **CI watch: rounds, with the cron as safety net** (the `awaitTicket` pattern,
   `workflows/app-launch.ts:185-218`).
   - `land.ci#N` reads `getPullRequest` + `getChecks` on the gate SHA, fresh each time. Result:
     `pending | success | failure | none | merged | closed | head_moved`.
   - Rounds: 30 s for the first 10 minutes, then 2 minutes. `SHIP_CI_MAX_MINUTES = 120` →
     `ci_timeout`; `SHIP_CI_NONE_GRACE_MINUTES = 10` → `none` is a refusal ("the repo's CI never
     reported"), never green.
   - Merged by hand meanwhile → Phase B (`pr.merged` recorded `via: 'sessions.checks'`). Closed
     unmerged → reopen.
   - Safety net: `sessions.checks` (`checks-cron.ts:148`, `*/5`) gains `nudgeLandingSessions`:
     every `shipping`/`shipped` row with stage in `ci | approval | merging | releasing |
     deploying` whose `landing.stageAt` is older than 3 rounds is woken with `wakeOrRestart`
     (restarted when gone).
5. **Head SHA = Launch's gate SHA, enforced twice.** `ship.pr` records `landing.gateSha` =
   `sessions.head_sha` after `ship.commit`. `land.ci` refuses `pull.head.sha !== gateSha`
   (`head_moved`); CI is read on `gateSha` only; the merge passes `sha: gateSha`, so GitHub
   answers 409 if the head moved in between.
6. **Merging is idempotent by reading first.** `land.merge#N`:
   1. `landing.mergeSha` set → return it.
   2. `getPullRequest`: merged → record, return `merge_commit_sha`. Closed → reopen `pr_closed`.
   3. Head ≠ gate SHA → `head_moved`.
   4. Re-read checks → not `success` → `ci_not_green` (reopen reason `ci_failed`).
   5. Review required → the approval must be `approved` with `context.headSha === gateSha`.
   6. `PUT merge {merge_method:'squash', sha: gateSha, commit_title: "<PR title> (#n)",
      commit_message: <ship_summary body + "Merged by Launch from session <short>[, approved by
      <name>]">}`. 200 merged; 409 → `head_moved`; 405/422 → `merge_refused` with GitHub's
      message.
   7. One CAS on `status='shipping' AND landing->>'stage'='merging'` → `shipped`, stage
      `releasing`, `mergeSha`, `mergedAt`. Then `recordPrMerged` (`releases/pr-audit.ts:46`, new
      `via: 'session.merge'`) unless already recorded, audit `session.merged` (`approvalId`,
      `gateSha`, `mergeSha`), event `ship.merged`.
   A second live instance loses the CAS and finds the PR merged at step 2.
7. **Reopening keeps the container while it can.**
   - The container is kept through `ci`, then released by backup + destroy (export
     `backupWorkspace`, `steps.ts:1646`; `landing.containerReleased = true`) when
     `policy.idleSuspendMinutes` pass in `ci`, or the `approval` stage runs longer than that, or
     a drain arrives.
   - `land.reopen#N` (`SHIP_REOPEN_REASONS`): `shipping → ready` when the container is still
     ours (boot marker with the loop's `bootId`), else `shipping → suspended` (the next message
     resumes). Either way `landing := null`, events `ship.reopened {reason, message}` + `error`,
     audit `session.ship_reopened`.
   - A red CI carries the failing check's name, URL and a redacted log tail (`GET
     …/actions/jobs/{id}/logs` for a `github-actions` check run, else annotations; last 80
     lines; `gate.ts`'s redaction). `sessionSystemNote` (`turn.ts:940`) appends the latest
     unresolved CI failure, so "fix it" works in a normal turn.
8. **Releases serialise per app on a claim on the `apps` row; the tag stays the idempotency
   key.**
   - `apps.release_claim_holder` (`session:<id>` | `user:<id>`) + `apps.release_claimed_at`,
     taken by `UPDATE … WHERE holder IS NULL OR claimed_at < now() - 10 min RETURNING` (the
     `claimDevPrepare` precedent), released in a `finally`.
   - `land.release#K.R`: `landing.releaseId` set → done. A release of the app already lists this
     PR (`app_releases.prs @> '[{"number":n}]'`) → share it. Otherwise take the claim (not won →
     `land.release-wait` 20 s, up to 15 min), re-check, then `createRelease({bump:'patch',
     userId: null, actor: SYSTEM, trigger: {sessionId}})`. PRs merged close together share one
     release.
   - `POST /api/apps/:id/releases` takes the same claim: 409 `release_in_progress`.
   - Double tags are impossible three ways: the claim, unique `(app_id, tag)`, GitHub's 422 on
     an existing ref.
9. **Following the release to staging; post-merge failures stall (decision §0.1).**
   - `land.staging#K.R` reads the release (`releases/lifecycle.ts`): `staging_active` or later →
     health next; `failed` → `stalled` (`deploy_failed`); still `tagged` after 45 min →
     `stalled` (`deploy_timeout`). Rounds 2 min.
   - `land.health#K.R`: `checkAppHealth` (`services/launch/health.ts:288`) up to 10 times, 30 s
     apart, needing staging `up` at `version === release.version`; else `stalled` (`unhealthy`).
   - `land.live`: stage `live` with `stagingUrl` (`app_environments.url`) and the version,
     `ship.staging {status:'live'}`, audit `session.landed`.
10. **Per-app setting `apps.ship_settings` jsonb, owners/admins, audited.**
    - `{ sessionShip: 'staging' | 'pr', review: { mode: 'none' | 'app_owners' | 'groups',
      groupIds: uuid[] } }`; null = `DEFAULT_APP_SHIP_SETTINGS` (`staging` + `none`).
    - `PUT /api/apps/:id/ship-settings`, gated like `viewerCanDeploy` (`mayDeployApp`), audited
      `app.ship_settings.updated` (before/after); read on `appDetailSchema.shipSettings`.
    - `ship.pr` snapshots mode and resolved review onto `landing`. `pr` mode = today's flow,
      stage `pr`. `SESSION_BACKEND=local` forces `pr`.
11. **Review policy.** `reviewPolicyFor(db, tenantId, app)`: an `approval_policies` row for
    `session.merge` at app, group or tenant scope (new `findPolicyRow` beside `resolvePolicy`,
    `services/approvals/policy.ts:75`) wins and makes review mandatory (`shipReviewSetBy:
    'policy'`). Otherwise `none` opens nothing, `app_owners` → `{approvers:{appOwners:true}}`,
    `groups` → `{approvers:{groupIds}}`. N=1, `allowSelfApproval:false`, 48 h, no auto-approve,
    passed as `OpenApprovalInput.policy` (`approvals/types.ts:112-118`).
12. **The `session.merge` kind** (`services/approvals/kinds/session-merge.ts`).
    - Subject `session` (`session.id`); requester = the session's creator. `land.review#N` opens
      it idempotently (`landing.approvalId` first, then the pending-subject index).
    - Excluded: every user who wrote a `user.message` in the session, plus the creator (as
      `releaseExclusions`, `releases/lifecycle.ts:166`).
    - Context `sessionMergeContextSchema`: sessionId, shortId, title, appSlug, prNumber, prUrl,
      PR title, summary (≤ 4 000, from `ship_summary`), diffStat (≤ 6 000), headSha,
      sessionPath.
    - `applyInTx`: CAS `landing.stage` `approval → merging`. `applyAfter`/`onClosed`:
      `wakeOrRestart` the session. Reject/expiry/cancel → `land.reopen` with `review_rejected` /
      `review_expired` and the decision's comment as the note.
    - `maySeeSession` (`services/sessions/access.ts:54`) gains a READ-ONLY grant for an eligible
      approver of a pending `session.merge` on that session (detail, events, preview grant; not
      turns, ship or end).
    - End during `ci`/`approval` cancels the request; End during `merging` → 409
      `session_merging`.
13. **Branch protection: a Launch ruleset, not classic protection**
    (`services/launch/branch-protection.ts`).
    - `POST|PUT /repos/{o}/{r}/rulesets`, named `launch`, on the default branch: rules
      `pull_request` (0 reviews), `required_status_checks` (`Gate`), `non_fast_forward`,
      `deletion`; `bypass_actors: [{actor_type:'Integration', actor_id:<App id>,
      bypass_mode:'always'}]`. Classic required checks cannot be bypassed by an App, so the
      release bump could never land; the ruleset also closes §18.17's bump-push gap.
    - New apps: the `github_env` step (`pipeline/launch-steps.ts:771-792`), idempotent by name;
      a 403/404 plan answer is recorded and non-fatal.
    - Existing apps: `GET /api/apps/:id/branch-protection` → `ok | none | blocks | unavailable |
      unknown` (rulesets with `current_user_can_bypass`, plus classic protection). `POST`
      (admins) applies the ruleset, audited `app.branch_protection.applied`. Classic protection
      is never touched: `blocks` tells the admin to remove it (DEPLOY.md).
    - **No new GitHub App permissions** (`services/launch/setup.ts:530-546`). Narrowed tokens:
      merge `{contents:'write', pull_requests:'write'}`; job logs `{actions:'read'}`; rulesets
      `{administration:'write'}` (`read` for the diagnosis).
14. **Where this meets part 8.** Releases cut on merge have `created_by_user_id = null`, a
    `release.created` summary `{trigger:'session.merge', sessionId}`, and `prs[].sessionId`.
    `releaseChain` (`releases/chain.ts:28`) gains the sessions' `session.merge` approvals; the
    `session.*` audit rows already match its rule. Slices never touch `PromoteButton`,
    `PromoteDialog`, the strip or `AppDetailPage`'s header, except S5's summary line below.
15. **The ship summary is kept on the session: `sessions.ship_summary` jsonb.** Today the
    summary goes only into the PR body. Not on `landing` (reset on reopen) nor on
    `app_releases.prs` (GitHub's compare has none).
    - `sessionShipSummarySchema`: `{ title ≤200, body ≤4000 (without Launch's "Opened by
      Launch…" footer), source: 'model'|'fallback', diffStat ≤6000, prNumber, gateSha|null, at }`.
    - Written by `openShipPullRequest` in the CAS that records the PR number (both modes;
      overwritten on a re-ship). The squash message and the `session.merge` context are built
      from it.
    - `releases/promotion.ts` selects `ship_summary->>'body'` in its tenant-first sessions join,
      as `changes[].summary` clipped to 600 (`PROMOTION_SUMMARY_MAX`). No backfill.

## 2. Contracts and schema

- **`packages/shared/src/launch-apps.ts`:** `SESSION_SHIP_MODES`, `SHIP_REVIEW_MODES`,
  `appShipSettingsSchema`, `DEFAULT_APP_SHIP_SETTINGS`, `resolveAppShipSettings(stored)`,
  `putAppShipSettingsRequestSchema` (groups needs ≥1 id); `appDetailSchema` (`:337`) gains
  `shipSettings` and `shipReviewSetBy: 'app' | 'policy'`; `BRANCH_PROTECTION_STATES`,
  `appBranchProtectionSchema {state, requiredChecks, appCanBypass, rulesetId, detail}`.
  `launch-sessions` imports the modes from `launch-apps`, never the reverse.
- **`packages/shared/src/launch-sessions.ts`:** `SHIP_LANDING_STAGES`, `SHIP_STALLED_REASONS`
  (`release_failed deploy_failed deploy_timeout unhealthy`), `SHIP_REOPEN_REASONS` (`ci_failed
  ci_timeout ci_none head_moved pr_closed review_rejected review_expired merge_refused`);
  `sessionLandingSchema` `{mode, stage, prNumber, gateSha, startedAt, stageAt, reviewMode,
  approvalId|null, mergeSha|null, mergedAt|null, releaseId|null, version|null, tag|null,
  stagingUrl|null, containerReleased, stalledReason|null, error|null}`;
  `sessionShipSummarySchema`; `sessionSchema` gains `landing` and `shipSummary` (nullable,
  default null). `SESSION_EVENT_TYPES` (`:134-152`) appends, with schemas in
  `SESSION_EVENT_DATA` (`:272`):

  | Event | Data |
  |---|---|
  | `ship.ci` | `{state, headSha, passed, failed, pending, failedCheck?: {name, url, logTail?}}` |
  | `ship.review` | `{status: requested\|approved\|rejected\|expired\|cancelled, approvalId, by?, note?}` |
  | `ship.merged` | `{number, sha, url, approvalId}` |
  | `ship.released` | `{releaseId, version, tag, shared}` |
  | `ship.staging` | `{status: deploying\|active\|live\|failed\|unhealthy\|timeout, version, url, health?, error?}` |
  | `ship.reopened` | `{reason, message}` |

  `ship.pr` gains an optional `title`.
- **`launch-approvals.ts`:** `'session.merge'` in `APPROVAL_KINDS` and `BUILT_APPROVAL_KINDS`;
  `sessionMergeContextSchema` in `approvalContextSchema`; `DEFAULT_APPROVAL_POLICIES
  ['session.merge']` = app owners, N=1, no self-approval, 48 h.
- **`launch-releases.ts`:** `RELEASE_ERROR_CODES.inProgress = 'release_in_progress'`.
- **`launch-promotion.ts`:** `promotionChangeSchema` gains `summary: z.string().nullable()
  .default(null)`.
- Server vocabulary: `recordPrMerged` `via` gains `'session.merge'`; audit actions
  `session.merged`, `session.merge_refused`, `session.ship_reopened`, `session.landed`,
  `app.ship_settings.updated`, `app.branch_protection.applied`.
- **DB**, one migration (`pnpm db:generate --name launch-i5-ship-to-staging`): `sessions.landing`
  jsonb, `sessions.ship_summary` jsonb, `apps.ship_settings` jsonb, `apps.release_claim_holder`
  text, `apps.release_claimed_at` timestamptz. No table, enum or index.
- **Ports:** `RepoHostPort` (`services/sessions/ports.ts:161`) gains `getPullRequest`,
  `mergePullRequest` (→ `{merged:true, sha} | {merged:false, code:'head_moved'|'refused',
  message}`), `failedCheckLog`; `LocalRepoHost` gets trivial versions. `SessionStepHooks`
  (`hooks.ts:79`) gains `landRelease`, `landStaging`, `landHealth`, bound in
  `defaultSessionStepHooks` (`:93`). `github-app.ts` gains `mergePullRequest`, `getJobLogs`,
  `listCheckRunAnnotations`, `listRulesets`, `createRuleset`, `updateRuleset`,
  `getBranchProtection`; `GitHubCheckRun` gains `app?.slug`.

## 3. Slices

**Rule:** only S1 runs `db:generate` or edits `packages/shared/*`, `github-app.ts`, `ports.ts`,
`hooks.ts`, `kinds/index.ts` or `tests/helpers/fake-cloud/github.ts`. A later slice that needs a
change there stops and reports.

- **S1, foundations (alone, first).** All of §2; the `github-app.ts` calls; `GitHubRepoHost` and
  `LocalRepoHost` methods; stubs throwing `NotWiredError` for `kinds/session-merge.ts`
  (registered in `KIND_HANDLERS`, `kinds/index.ts:30`), `services/sessions/land.ts`,
  `services/launch/ship-settings.ts`, `services/launch/releases/claim.ts`, and the land hooks.
  FakeCloud GitHub: squash `PUT …/pulls/{n}/merge` (409 on `sha` mismatch, 405 when blocked,
  counts merges), job logs (`setJobLog`), annotations, rulesets with `current_user_can_bypass`,
  branch protection, a `protect(owner, repo, {requiredChecks, bypassAppId?, classic?})` hook
  (non-bypassing `updateRef` to the default branch → 422; merge without green required checks
  → 405), check runs with `app.slug`. `createFakeSessionPorts` (`tests/helpers/sessions.ts:243`)
  gains the new methods. Tests: `tests/config/launch-sessions.test.ts`,
  `tests/api/github-app.test.ts`, `tests/api/session-vendors.test.ts`,
  `tests/api/approvals-foundations.test.ts`, `promotionChangeSchema` without `summary`.
- **S2, landing in the Workflow** (after S1; parallel with S3–S5). Owns `workflows/session.ts`,
  `services/sessions/{land.ts, ship-steps.ts, ship.ts, steps.ts, checks-cron.ts, access.ts,
  turn.ts}`, `routes/session-ship.ts`, `kinds/session-merge.ts`. Builds decisions 1–7, 12 and the
  write side of 15. Tests: `tests/api/session-land.test.ts` (new; the `session-ship-gate.test.ts`
  harness): CI green → merged once → `shipped/releasing`; CI red → `ready` with a redacted tail;
  red after container release → `suspended`; head moved; retried merge → 1 merge; merged by hand
  → Phase B; closed → reopen; `none` after grace; End during `ci`; lost instance in `ci` →
  restarted, no salvage; distinct step names; squash message and approval context from
  `ship_summary`. `tests/api/approvals-kinds.test.ts`: approve → merge, reject → reopened with
  note, expiry, creator/message-writers → 403 `self_approval`, a group approver reads but cannot
  ship. `session-ship-gate.test.ts` / `session-ship.test.ts`: `pr` mode unchanged; summary stored
  (model and fallback), overwritten on re-ship.
- **S3, release on merge and the staging follow** (after S1; parallel). Owns
  `services/launch/releases/{release.ts, claim.ts, chain.ts, promotion.ts}`,
  `routes/app-releases.ts`, `services/sessions/land-release.ts` (the hooks' bodies). Builds
  decisions 8, 9, 14 and the read side of 15; `CreateReleaseInput.userId` nullable + trigger.
  Tests: `tests/api/session-land-release.test.ts` (first merge → patch release with
  `sessionId`; two merges before release → one shared release, one tag; far apart → two tags;
  claim held → wait → share; stale claim taken over; manual route 409; protected branch without
  bypass → `release_failed`; staging activate + healthy → `live`; failed / unhealthy / timeout →
  `stalled`); `releases.test.ts` chain; `promotion.test.ts` summary (null without a session,
  tenant-scoped).
- **S4, ship settings, review policy, branch protection** (after S1; parallel). Owns
  `services/launch/{ship-settings.ts, branch-protection.ts, apps.ts}`, `routes/apps.ts`,
  `services/approvals/policy.ts`, `pipeline/launch-steps.ts` (`githubEnvStep`). Builds decisions
  10, 11, 13. Tests: `tests/api/app-ship-settings.test.ts`, `tests/api/branch-protection.test.ts`,
  the launch pipeline's `github_env` ruleset assertion, `tests/config/kit-required-check.test.ts`.
- **S5, UI and CLI** (after S1; parallel, against fixtures). Owns `ui/pages/sessions/components/
  {ShipPanel, SessionHeader, SessionComposer}.tsx` + `sessionChatModel.ts` (`landingTimeline`),
  `ui/pages/apps/components/ShipSettingsCard.tsx` (one line in `AppDetailPage.tsx`, below the
  strip), the summary line in `PipelineStrip.tsx`'s change rows,
  `ui/pages/approvals/components/ApprovalContext.tsx`, `ui/hooks/{useSessions,useApps}.ts`,
  `apps/cli/src/commands/sessions.ts`. Ship panel: gate → PR → CI → (approval, naming who) →
  merged → released vX.Y.Z → "Live on staging: <link>"; reopen shows the CI failure + "Ask
  Claude to fix it"; stalled shows the reason + app page link. CLI `launch sessions ship` waits
  through to `live` (`--no-wait`; `--wait` a no-op alias), exits non-zero on reopen/stall.
  Tests: `session-page`, `apps-pages`, `approvals-inbox`, `pipeline-strip`, CLI `sessions`.
- **S6, end to end and docs** (after S2–S5). `tests/api/session-land-e2e.test.ts`
  (`// @vitest-isolate`): ship → gate → PR → CI green → review (bob approves, alice refused) →
  squash → patch release → staging start/upload/activate/finish → healthy → `live`; `GET
  …/:rid/chain` reads the whole story. Variants: CI red, reject, `pr` mode. Then the docs sweep.

## 4. Docs, per slice

- **S1:** `packages/shared/CLAUDE.md`; CONCEPTS §18.15 (the kind).
- **S2:** CONCEPTS §18.9, §18.13 (CI watch, merge, reopen, `ship_summary`);
  `apps/web/src/api/workflows/CLAUDE.md`.
- **S3:** CONCEPTS §18.17 (release on merge, the claim, sharing, the follow, the bump gap closed,
  the strip's summaries).
- **S4:** CONCEPTS §18.5, §18.4; `SETUP.md` (Administration also writes rulesets; private repos
  need GitHub Team); `docs/DEPLOY.md` (existing repos: remove classic protection, press Apply).
- **S5:** CONCEPTS §18.14, §11; `.claude/rules/cli.md`.
- **S6:** `spec/08-approvals-audit-ship.md` § Shipping and § Code review; `CHANGELOG.md`.

## 5. Known gaps

- Sessions shipped before this change have no stored summary; the strip shows titles only.
- A session waiting in `approval` holds its Neon branch and a `maxConcurrentPerApp` slot for up
  to 48 h.
- Webhooks stay P6: the CI and deploy follow are bounded by their poll rounds.

## 6. Status (2026-10-01)

**Built**, S1–S6 and part 8, against fakes (the FakeSandbox, the FakeCloud's GitHub, Neon and
Cloudflare). `tests/api/session-land-e2e.test.ts` runs every slice's real code at once: the
settings route and `reviewPolicyFor`, the landing in the real `SessionWorkflow`, the
`session.merge` review through the approvals route (the creator refused 403 `self_approval`, an
owner approves), one squash merge, the patch release under the app's claim, the staging deploy
through `/ci/deploy`, the health probe, then `GET …/:rid/chain` and `GET …/promotion`; plus CI
red, a rejected review, `pr` mode, the default settings, an End while the review waits, and an
admin policy forcing a review.

**Where the code differs from this plan** (CONCEPTS §18.4, §18.5, §18.13, §18.14, §18.17 describe
what was built):

- **S2.** `ship.pr` snapshots the ship mode and the review MODE (`reviewMode`, incl. `policy`)
  onto the landing; the approvers are resolved again by `reviewPolicyFor` when `land.review`
  opens the request (a setting changed in between to "none" still gets the default owners'
  policy). A thrown land step is one more round after `LAND_RETRY_SECONDS`, never a failed
  session; a landing that cannot merge within `LAND_MERGE_MAX_MINUTES` (30) reopens
  `merge_refused`; a round in `approval` is a 30-minute backstop (the decision wakes the
  session). A stall is audited `session.land_stalled`, and a reopen also writes an `error` row.
  The safety net reads `landing.stageAt` AND `last_activity_at`. A landing the cron restarts has
  no boot id, so its reopen always suspends.
- **S3.** The release claim is released only while still the holder's own. Health counts
  `app_health_checks` rows of staging since it went live on the release (the `*/5` cron's probes
  count), not a counter, and a newer version on staging counts as live.
- **S4.** `findPolicyRow` lives in a leaf (`approvals/policy-row.ts`) to avoid a cycle through
  the kind registry; a `groups` review whose teams were all deleted falls back to the app's
  owners; a PUT that changes the review under an admin policy is 409
  `ship_review_set_by_policy`; a plan without rulesets is recorded `unavailable` and the launch
  goes on.
- **S5.** The CLI's follow gives up after four hours (a review may wait two days) and says the
  ship carries on; `--wait` stays as a no-op alias. The panel names who a review waits on only for
  a reader who may read the request.
- **S6.** `landingTimeline` takes the session's status: a landing an End abandoned (no landing,
  no reopen, not shipping) reads as the plain PR view instead of "Waiting for CI" for ever, and
  the CLI says the PR was left open instead of "did not open a pull request".

**Follow-up: hand merges are adopted** (found on hola-world, whose PR #4 — shipped before #5 — was
merged on GitHub and nothing released). `sessions.checks` now adopts a session PR merged by hand
while no landing was moving (landing null, or stage `pr`) in a `staging`-mode app, within
`LAND_ADOPT_MAX_AGE_HOURS` (24) of the merge: a `releasing` landing in one CAS, `ship.merged` /
`session.merged` `by: 'github'`, then a fresh Workflow instance into Phase B
(`services/sessions/land-adopt.ts`, `tests/api/session-land-adopt.test.ts`, CONCEPTS §18.13).

**What remains** (needs the user and real GitHub):

1. Apply Launch's ruleset to hola-world: remove any classic protection on `main`, then the app
   page's **Apply Launch's protection** (or `POST /api/apps/:id/branch-protection`), and check the
   diagnosis reads `ok` (the repo is private in `guidemode`, on GitHub Team).
2. One real ship on hola-world with the default settings: CI on the gate SHA, Launch's squash
   merge, the patch release's bump pushed past the ruleset, `deploy.yml` to staging, and the
   session ending on "Live on staging". Then once with `app_owners` review.
3. Read GitHub's real answers where the fakes follow the docs: the job-log redirect and
   annotations of a red `Gate`, the squash merge's 405/409/422, and the rulesets API.
