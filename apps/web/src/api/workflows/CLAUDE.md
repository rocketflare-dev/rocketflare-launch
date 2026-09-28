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

`SessionWorkflow` (`SESSION_WORKFLOW`, `launch-session[-staging]`) drives one coding session;
params `SessionWorkflowParams` (`{ sessionId, tenantId }`, `@launch/shared/launch-sessions`), the
instance id is the session id (`<id>-rN` after a restart — `wakeOrRestart`,
`services/sessions/lifecycle.ts`). The class wires names and configs only; the bodies are plain
functions in `../services/sessions/steps.ts` over a `StepScope` (one DB client, the ports, the
hooks, a step realtime).

Shape: `claim` → boot `db → sandbox.start → repo → [prepare → branch] → bootstrap → dev` (or
`salvage` instead, for a live session whose instance was lost) (each
wrapped in `withProgress`, which writes the boot checklist's `step` events) → a loop of
`inspect#N` (the row decides: end · drain-suspend · resume · ship · turn · wait) and one of
`wait#N` (`waitForEvent(SESSION_WAKE_EVENT)`, timeout = what is left of the idle policy counted
from `last_activity_at`, or the suspended expiry; on an idle timeout `suspend#N` re-reads the stamp
and does nothing when the preview moved it meanwhile — the next round waits out the rest),
`turn#N` (3c's `runTurn`, `turnStepConfig`: `retries: 0`) → `checkpoint#N` | `rollout#N`,
`ship#N` (3d's `ship`), `suspend#N` (an IDLE suspend keeps the container: `container_kept_at`,
`services/sessions/warm.ts`), `cool#N` (a kept container's warm window is over — the suspended
`wait#N` then times out after `SESSION_WARM_KEEP_MINUTES`, `cool: true` — or a drain), `resume#N`
→ `sandbox.start#K` → WARM (it found its own boot marker: `dev#K` only, reusing the dev server when
it answers) or COLD (`restore.check#K` → `restore#K` when the workspace backup is at the branch
head, else `repo#K` → `bootstrap#K` — never re-seeds, migrates only when `sessions.migrations_hash`
differs, and does nothing after a restore with unchanged migrations — → `dev#K` → `transcript#K`),
`end#N` →
`fail` on a thrown step → `cleanup` ALWAYS (destroy the sandbox, delete the branch, `ended` unless
`shipped`/`failed`, audit `session.ended`). A pending message after boot or resume runs at once
(`inspect` before any wait). `sandbox.start` returns a `bootId` (written into the container); the
boot steps after it take that id as a closure argument and refuse a container that no longer
carries it (`SandboxRestartedError`). Every boot step runs under `withProgress`, which also polls
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
for tests.

The three calls into other slices go through `SessionStepHooks` (`services/sessions/hooks.ts`,
bound once in `defaultSessionStepHooks`); the hooks own the status INSIDE their work (`runTurn`
claims `ready → working`, `ship` claims `shipping`), and the Workflow reads the row afterwards.

Tests (`tests/api/session-workflow.test.ts`) set `workflow.overrides = { ports, hooks }` —
`createFakeSessionPorts()` with the real `NeonSessionDb` over the FakeCloud, 3c's real `runTurn`
with fast timers, recording checkpoint/ship fakes — and drive `run` with
`createFakeWorkflowStep({ onWait })`, asserting the exact step names.

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
