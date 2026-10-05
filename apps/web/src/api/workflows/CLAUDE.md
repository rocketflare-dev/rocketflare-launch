# Workflows (D5, D7)

`agent-run.ts` — `AgentRunWorkflow extends WorkflowEntrypoint<AppBindings, { runId, tenantId }>`,
bound as `AGENT_RUN_WORKFLOW` in BOTH tomls (`name` is account-scoped: `launch-agent-run` /
`-staging`; `binding` + `class_name` identical — the parity test enforces). Exported from
`src/worker.ts` only.

Shape: `step.do('claim')` → a LOOP of `step.do('execute#N', { retries: { limit: 2, delay:
'10 seconds', backoff: 'exponential' }, timeout: '10 minutes' })` and, whenever that returns
`awaiting_input`, `step.waitForEvent('resume#N', { type: AGENT_RESUME_EVENT, timeout:
cfg.AGENT_INTERRUPT_TIMEOUT })` → `step.do('finish')`. The bodies are plain functions in
`../services/agents/runtime.ts` (tests call them with `{ db, env }`); the class only wires steps and
opens/closes ONE DB client per step (`withStepDatabase`, awaited `close()` in `finally`). Step return
values are small serialisable objects (ids + status), never rows. Tracing (D32): `execute#N`
passes `{ round }` so the attempt's span is named for its step, and only `finish` passes `{ cfg }`
to `finishStep`, which records the run's root span — one root per run, so the `expire#N` call
must not.

**A step name is its IDENTITY to the platform**, so every name inside the loop carries its round.
A fixed `'execute'` called a second time replays the first call's cached result — the run re-asks
the question it already had answered, and the bug reads as "the agent ignored my approval". Nothing
in a Node suite can catch that; `tests/api/agent-run-workflow.test.ts` asserts the recorded names
are distinct per round, which is the closest we get.

Three more things the loop holds:

- **The resume payload is ignored on purpose.** The answer is already an `agent_run_interrupts` row,
  written by the resolve route, which also flips `awaiting_input → running` BEFORE it wakes the
  instance (decision 2). `execute#N+1` re-enters `run()` from the top and reads it. That is what
  lets `nudgeOrRestartInstance` create a fresh instance when the old one is gone — a new instance
  has no event to replay and needs none. `AGENT_RESUME_EVENT` is a constant because a `.` in the
  type is `workflow.invalid_event_type` (T8).
- **The `try/catch` around `execute` lives inside the loop and clears `outcome`** — a previous
  round's `awaiting_input` falling through to `finish` would say the run is parked when it is not.
- **`MAX_INTERRUPT_ROUNDS` (32)** ends a runaway agent `failed`. A correctness guard, not a capacity
  one: the step budget is 10,000 and a round costs two steps.

**The whole tool loop lives in the ONE `execute` step by decision, not by omission** — one `step.do`
per model turn was investigated and rejected (`docs/CONCEPTS.md` §9 Known gaps). Steps do not nest,
so it needs `run()` outside a step, and Workflows replays everything outside a step. Wall clock per
step is unlimited, so a long run is a bigger `timeout`, not more steps.

Rules: idempotent steps (the `agent_runs` row is the claim); cooperative cancel (poll the row between
turns); CPU is bounded PER STEP by `[limits] cpu_ms`; no `waitUntil` — await everything, including
nudges (`createStepRealtime().settle()`). `wrangler dev` runs instances locally; inspect deployed ones
with `wrangler workflows instances describe launch-agent-run <runId>`.

Testing: `tests/api/agent-run-workflow.test.ts` instantiates the class with `createTestEnv()` and
`createFakeWorkflowStep(options)` (`tests/mocks/cloudflare-workers.ts`) and asserts on the rows.
The fake's `waitForEvent` is a recorder: `{ events?, onWait? }` in, `{ step, calls, waits, names,
queueEvent }` out. `onWait` is the test's stand-in for the resolve route (write the answer, flip the
row, return a payload); an empty queue with no `onWait` rejects the way the platform's timeout does,
which is how the expiry path is driven. `names` is every step name in call order.

## Launch P2: `app-launch.ts` and `app-teardown.ts`

`AppLaunchWorkflow` (`APP_LAUNCH_WORKFLOW`, `launch-app-create[-staging]`) creates an app and
`AppTeardownWorkflow` (`APP_TEARDOWN_WORKFLOW`, `launch-app-teardown[-staging]`) archives one; the
params are `AppLaunchParams` / `AppTeardownParams` from `@launch/shared/launch-pipeline`, and the
instance id is the pipeline run id (`<runId>-rN` on a retry, same `runId` in the params). They
follow `agent-run.ts` — `withStepDatabase`, distinct step names, and every step body wrapped in
`runStep` (`services/launch/pipeline/operations.ts`) so a retry skips what succeeded. The bodies
are plain functions in `services/launch/pipeline/launch-steps.ts` and `teardown-steps.ts`; the
classes only wire names, configs (`PIPELINE_STEP_CONFIG`: 3 retries, 10 s exponential, 5 min) and
DB clients. **A secret never appears in a step result**: the step that mints one puts it on the
Worker in that same step and returns ids only.

- **The two long waits are ROUNDS**: `scaffold.poll#N` / `deploy_staging.poll#N` read the ticket
  row (the truth; the event is a nudge) and ask whether the job itself died, then
  `scaffold.wait#N` / `deploy_staging.wait#N` park on the event for one round (2 min × 15, 3 min ×
  15). A retried run's events go to the OLD instance (the ticket holds the base run id), so a lost
  event costs one round, not 30 minutes; a failed job ends the wait at once. The `<prefix>.wait`
  row is written when the wait ends.
- **`email` is non-blocking** (caught; its row stays `failed`); `health#N` probes with
  `health-wait#N` sleeps between; `production` is `skipped`; an uncaught failure runs
  `launch_failed` (status `failed`, `app.launch_failed` with the failed row's SCRUBBED error) and
  the run returns.
- **Adapter ports** (`services/launch/pipeline/ports.ts`): the names, `writeConfig`, the
  placeholder Worker, the scaffold files and runner come from slice 2b through `defaultPorts()`.
- **Tests** set `workflow.overrides = { ports, vendors, sleep, health }` — the credentials are
  handed in because `admin_credentials` is global — and drive `run()` with
  `createFakeWorkflowStep({ onWait })` playing the scaffold job and the deploy
  (`tests/helpers/launch-pipeline.ts` `LaunchHarness`, the FakeCloud as the global fetch).

## Launch P3: `session.ts`

`SessionWorkflow` (`SESSION_WORKFLOW`, `launch-session[-staging]`) drives one coding session — on
the sandbox host frozen on its row (`sessions.sandbox_host`, read once per step to build the
ports); params `SessionWorkflowParams` (`{ sessionId, tenantId }`, `@launch/shared/launch-sessions`), the
instance id is the session id (`<id>-rN` after a restart — `wakeOrRestart`,
`services/sessions/lifecycle.ts`). The class wires names and configs only; the bodies are plain
functions in `../services/sessions/steps.ts` over a `StepScope` (one DB client, the ports, the
hooks, a step realtime).

Shape: `claim` → boot `db → sandbox.start → repo → [prepare → branch] → bootstrap → dev` (or
`salvage` instead, for a live session whose instance was lost) (each
wrapped in `withProgress`, which writes the boot checklist's `step` events) → a loop of
`inspect#N` (the row decides: end · drain-suspend · resume · ship · turn · checkpoint · wait) and
one of
`wait#N` (`waitForEvent(SESSION_WAKE_EVENT)`, timeout = what is left of the idle policy counted
from `last_activity_at`, or the suspended expiry; on an idle timeout `suspend#N` re-reads the stamp
and does nothing when the preview moved it meanwhile — the next round waits out the rest),
`turn#N` (3c's `runTurn`, `turnStepConfig`: `retries: 0`) → `rollout#N` (`containerGone`: a
rollout or `container_lost` — the session is already `suspended`) | `checkpoint#N` (only
when the session has held unsaved changes for `SESSION_CHECKPOINT_MAX_DEFER_MS`, or the turn step
itself died) | nothing — the checkpoint is DEBOUNCED: the turn step reports `changed` (a
`git status` + HEAD-vs-`head_sha` check, fail-safe true) and `endedAt`, the loop keeps a
`DirtyState` built ONLY from those step results (never a clock read — the loop is replayed), and
passes it to `inspect#N`, which does the time arithmetic with `scope.now()`: a `wait#N` whose
timeout is what is left of `SESSION_CHECKPOINT_DEBOUNCE_MS` after the latest turn (`debounce:
true`; a timeout there is `checkpoint#N` and the loop waits on, never a suspend) or, already due,
the `checkpoint` action itself. Timeouts render through `waitDuration` (`N minutes` when whole, else
`N seconds`). `suspend#N`, `end#N` and a green ship checkpoint first and clear the state;
the ship round (below), `suspend#N` (an IDLE suspend keeps the container: `container_kept_at`,
`services/sessions/warm.ts`), `cool#N` (a kept container's warm window is over — the suspended
`wait#N` then times out after `SESSION_WARM_KEEP_MINUTES`, `cool: true` — or a drain), `resume#N`
→ `sandbox.start#K` → WARM (it found its own boot marker: `dev#K` only, reusing the dev server when
it answers) or COLD (`restore.check#K` → `restore#K` when the workspace backup is at the branch
head, else `repo#K` → `bootstrap#K` — never re-seeds, migrates only when `sessions.migrations_hash`
differs, and does nothing after a restore with unchanged migrations — → `dev#K` → `transcript#K`),
`end#N` →
`fail` on a thrown step → `cleanup` ALWAYS (destroy the sandbox, delete the ship gate's branches
and then the session's branch, `ended` unless
`shipped`/`failed`, audit `session.ended`). A pending message after boot or resume runs at once
(`inspect` before any wait). `sandbox.start` returns a `bootId` (written into the container,
`services/sessions/boot-marker.ts`); the boot steps after it take that id as a closure argument and
refuse a container that no longer carries it (`SandboxRestartedError`). The loop carries the latest
`bootId` too (the boot's, then each `sandbox.start#K`'s — a step result, so replay-safe) into
`turn#N`, `checkpoint#N`, `suspend#N`, `end#N` and `ship#N`: a turn refuses an empty container
before it starts (the message kept, `suspended` + a resume requested) and probes the marker while it
runs (`TURN_LIVENESS_PROBE_MS`; a dead container's stream goes quiet rather than ending) →
`interrupted { container_lost }`; a checkpoint on an empty container reports it lost instead of
failing at `cd`, and a `turn` checkpoint then suspends the session. A step that has no `bootId`
(the salvage path's `end#N`) checks nothing, as before. Every boot step runs under `withProgress`, which also polls
the row (an End stops the step — `fail` then settles `ending`, not `failed`) and writes the
heartbeat `services/sessions/reconcile.ts` reads (a running turn writes the same heartbeat,
`turn.ts`, every 10 s); `claim` sends an `ending` session, and a settled one with no `ended_at`,
straight to `cleanup` — which is how the reconcile's fresh instance cleans up — and a LIVE one
(`ready`/`working`/`blocked`/`shipping`: its instance was lost) to `salvage` (`SALVAGE_STEP`: one
retry, 15 min) before the loop: with the container still carrying its boot marker, stop the
orphaned turn by `TURN_PID_FILE` (the turn's `turnKillScript`), checkpoint (`reason: 'salvage'`,
transcript included), KEEP the container when the process is confirmed stopped (the loop's
`resume#N` then goes warm), else destroy it; then `suspended` + `resume` and close a `working` turn
saying whether the work was saved (`turn.failed`, or `turn.interrupted { cancelled }` for a pending
Stop). It writes the heartbeat while it runs, and catches every sandbox error — a salvage never fails
the session. A `booting` row under a lost instance is destroyed and resumed as before. The
reconcile leaves a dead `working` turn `working` for exactly this, and judges one with a Stop
pending after 30 s (`SESSION_CANCEL_STALL_MS`), which the cancel route calls at once. `transcript#K`
clears a `claude_session_id` it cannot restore (with an `error` event), so a lost transcript never
fails every later turn. `overrides.limits` shrinks the deadlines (`services/sessions/deadline.ts`)
— and the checkpoint debounce and its cap (`checkpointDebounceMs`, `checkpointMaxDeferMs`) — for
tests; `overrides.now` is the steps' clock.

**The ship round** (issue #1, bodies in `services/sessions/ship-steps.ts`, `docs/CONCEPTS.md`
§18.13) is `SessionWorkflow.ship(run, n, bootId)`: `ship.claim#N` → `ship.save#N` → `ship.kit#N`
(which commands the checkout's kit takes — its `pnpm gate` steps, the legacy `test:ephemeral`
three, or a refusal that settles the round `unfixable`; the attempts run `ship.kit`'s commands in
its order) → per attempt
`A` (numbered across the session's ships, from `ship.claim`'s result): `ship.gate#N.A.lint` →
`ship.gate#N.A.typecheck` → `ship.db#N.A` → `ship.gate#N.A.test` → `ship.db-clean#N.A` (in a
`finally`, so the gate branch never outlives a red, a throw, an end or a lost container) → on red
`ship.fix#N.A` (`turnStepConfig`: no retry) → … → green: `ship.commit#N` (issue #9: refused —
`tree_changed` — unless the workspace and then the commit are the tree the attempt's last gate step
read) → `ship.attest#N` (the `launch/gate` check run on the pushed head, `gate-attest.ts`; never
fails the round) → `ship.summary#N` →
`ship.pr#N` (`shipped` in `pr` mode; in issue #5's `staging` mode the round returns `landing`
and the session stays `shipping`); no PR: `ship.settle#N`. Every name carries the round and the attempt; the loop only
branches on step RESULTS (a gate step's `{ passed, stop }`), so a replay takes the same path. A gate
step is `gateStepConfig` (one retry — `runInBackground` re-attaches — and the command's deadline
plus 5 min). A thrown ship step is caught in the round and settles it (`error`); it never fails the
session. A lost container (`stop: 'container_lost'`, `lost`) leaves the round with the session
already `suspended` and the loop's dirty state cleared; a settled round's dirty state is
`ship.save`'s (saved → clean) plus what the fix turns changed (`ship.settle`'s result).

**The landing** (issue #5, `docs/plans/i5-ship-to-staging.md`, bodies in
`../services/sessions/land.ts`, CONCEPTS §18.13). Phase A is a loop round: `inspect#N` answers
`{ action: 'land', stage }` for a `shipping` row whose `sessions.landing` is in `ci` / `approval` /
`merging` (before `maxSessionHours`, after an explicit End — but `merging` beats an End), and
`SessionWorkflow.land(run, step, n, bootId, stage)` runs `land.ci#N` → [`land.review#N`] →
[`land.merge#N`], forward only and each at most once a round, then ONE of `land.wait#N`
(`waitForEvent(SESSION_WAKE_EVENT)` for the step's `waitSeconds`; a timeout just ends the round),
`land.reopen#N` (the session back to `ready` or `suspended`), nothing (`none`: the row moved), or
MERGED — `loop()` then returns `{ merged: n }`. A land step that throws past its retries is one
more round (`land.wait#N`, `LAND_RETRY_SECONDS`), never a failed session. `run()` runs `cleanup`
FIRST and then Phase B, `SessionWorkflow.release(run, step, k)` with `K` the merge's round:
`land.release#K.R` / `land.staging#K.R` / `land.health#K.R` (the `landRelease` / `landStaging` /
`landHealth` hooks through `land.ts`'s wrappers, `LAND_PHASE_B_STEP`), each followed while it
answers `wait` by a `step.sleep` named `land.release-wait#K.R` / `land.staging-wait#K.R` /
`land.health-wait#K.R`, ending in `land.live#K` or `land.stalled#K` (`MAX_LAND_PHASE_ROUNDS`
caps each stage). `claim` answers `{ start: 'loop' }` for a Phase A landing (never `salvage`)
and `{ start: 'land', cleanup }` for a `shipped` one in `releasing` / `deploying` — `run()` then
runs `cleanup` (when `ended_at` is still null) and `release(…, 0)` only. That is also how a hand
merge the `sessions.checks` cron ADOPTS runs (`../services/sessions/land-adopt.ts`: a `releasing`
landing written on a `shipped` row, then a fresh `<id>-rN` instance via `wakeOrRestartLanding`;
`tests/api/session-land-adopt.test.ts`). The tests are
`tests/api/session-land.test.ts` (the `session-ship-gate` harness with fake Phase B hooks; the fake
step's `sleep` is wrapped there so its names are recorded too) and
`tests/api/session-land-e2e.test.ts` (every slice's real code at once: the settings route, the
real `reviewPolicyFor`, the approvals route, the REAL Phase B hooks over the FakeCloud as the
global fetch, the staging deploy played inside the `land.staging-wait` sleep, then the release's
`chain` and the app's `promotion`).

The calls into other slices go through `SessionStepHooks` (`services/sessions/hooks.ts`, bound
once in `defaultSessionStepHooks`): `runTurn`, `checkpoint`, `shipFix` (a fix turn),
`shipSummary` (the PR's one model call) and issue #5's `landRelease` / `landStaging` /
`landHealth` (`land-release.ts`). `runTurn` owns `ready → working` inside its work, the ship
steps own `shipping`, and the Workflow reads the row afterwards.

Tests (`tests/api/session-workflow.test.ts`) set `workflow.overrides = { ports, hooks }` —
`createFakeSessionPorts()` with the real `NeonSessionDb` over the FakeCloud, 3c's real `runTurn`
with fast timers, a recording checkpoint fake — and drive `run` with
`createFakeWorkflowStep({ onWait })`, asserting the exact step names. The ship round is
`tests/api/session-ship-gate.test.ts` (the same harness, the gate commands scripted as the
FakeSandbox's background runs, the real GitHub repo host, a recording fix turn and the real
`summarizeShip` over a fake chat client).

## Launch P5: `grant-push.ts`

`GrantPushWorkflow` (`GRANT_PUSH_WORKFLOW`, `launch-grant-push[-staging]`) delivers one
`grant_pushes` row; params `GrantPushParams` (`{ tenantId, pushId }`, `@launch/shared/launch-grants`),
instance id = the push id (`<pushId>-rN` on a retry — `retryPush`). Shape: `plan` (the push
`running`; materialise `grant_push_targets`, an idempotent insert) → `push#N` (targets
`N*GRANT_PUSH_BATCH…` in id order through the `GrantBacking`; a succeeded/skipped target is never
touched again, a grant already on a newer version is skipped) → `finish` (counts, status, retire the
replaced versions when a rotation reached everyone, audit, notify) → `fail` only when a step threw
past `PIPELINE_STEP_CONFIG`'s retries (the push `failed`, its active slot released). The bodies are
`services/grants/push-steps.ts`; the class opens one DB client and one `createStepRealtime` per
step and settles the nudges before the step returns. A target's failure is caught and recorded (the
push ends `partial`), so a vendor error never retries a whole batch. Values are opened inside
`push#N`, scrubbed from every error, and never returned — a step returns counts.

Tests (`tests/api/grant-push-workflow.test.ts`) set `workflow.overrides = { backing }` — a
`WorkerSecretsBacking` whose client has `cloud.fetch`, or a `LocalGrantBacking` — and drive `run`
with `createFakeWorkflowStep()`, asserting the step names.

## §18.22: `agent-login.ts`

`AgentLoginWorkflow` (`AGENT_LOGIN_WORKFLOW`, `launch-agent-login[-staging]`) runs one relayed
sign-in for a personal AI account; params `AgentLoginParams` (`{ loginId, tenantId,
sandboxHost? }`, `@launch/shared/launch-agents` — `sandboxHost` is the Session sandbox setting when
the sign-in started, frozen for the run and picking the ports), instance id = the login id. Shape:
`start` (record the sandbox id, boot `login-<id>` with the driver's hosts, `prepareLogin` — on the
remote host the grant for that runtime's sign-in passthrough — start the CLI) → `prompt#N` → `runtime` → (a runtime
whose login takes a code back) `code#N` (`waitForEvent(AGENT_LOGIN_CODE_EVENT)`, payload ignored —
the route sealed the code onto the row) + `submit#N` → `finish#N` → `capture` (sealed into
`agent_credentials`; returns `{ ok }`) — then `expire` / `fail` when a loop ran past the TTL or a
step threw past its retries — and `cleanup` ALWAYS, in a `finally` (destroy the sandbox, null the
URL and codes). A cancel is the row flipping under it: the next step reads `stopped`. The bodies
are `services/sessions/logins/steps.ts`; the runtime's `LoginDriver` (`runtimes/<id>/login.ts`)
does the CLI-specific part. Tests (`tests/api/agent-login-workflow.test.ts`) set `overrides = {
ports, driverFor, now, sleep }` with a fake driver over the `FakeSandbox` and assert the step
names, the destroyed sandbox and that the credential is in no step result.

