# Create an app by interview: design

**Status:** proposed, 2026-10-10. Not started, and open for discussion; see §12 "Open questions".

## 1. Why

Today "New app" is a one-shot modal ([`CreateAppModal.tsx`](../../apps/web/src/ui/pages/apps/components/CreateAppModal.tsx)) that asks for name, slug, team, description and deploy-staging. Every app comes out as the same kit:
- its plugins come from the kit's own `default-plugins.mjs`;
- `TENANCY_MODE=single` is hardcoded in `rocketflare/toml.ts` `launchVars`;
- every core module is included;
- nothing from the form reaches a coding agent. "Build it" opens an empty session.

The goal is a full-screen create experience:
- **Left:** an interview about the problem being solved. It is built on interviewkit and ships as a private build-time extension (§3).
- **Right:** a live, editable "Your app" panel showing the config it implies:
  - basics
  - tenancy
  - core modules (chat, knowledge, agents)
  - plugins from a real catalogue
  - first features
  - the coding agent
- **"Just create the app"** is always available. It uses whatever is known, and falls back to today's defaults.
- **After the app is live,** a coding session starts with a first message built from the brief. It removes the modules the app doesn't want and builds the first features.

## 2. Decisions

1. **The work is split.**
   - The scaffold applies tenancy and the plugin set. This part is deterministic, gated and verified.
   - The post-live session removes the unwanted core modules and builds the features.
2. **The plugin catalogue is `catalog.json` in the plugins repo,** read by Launch at a pinned ref.
3. **The panel is editable, and edits are pinned.** A field the user touches is locked and shows as "set by you". The interview never overwrites it.
4. **The brief resolves as `kit defaults ← inferred ← pinned`.**
   - The defaults are today's behaviour: single tenant, open signup, the kit's default plugins (analytics), every module on, no features.
   - With no interview at all, the result is exactly the current create flow.
## 3. Open vs private: the interview is a build-time extension
`rocketflare-dev/rocketflare-launch` is **public**. interviewkit stays private: it is never published,
never named in a committed `package.json` or lockfile, and none of its prompts live in this repo.
Everything else is open source:
- drafts
- the full-screen page and its panel
- the catalogue
- the scaffold applying the config
- the build session

Without the extension, `/apps/new` is the same full-screen page with no conversation. The panel works
as the form, and "Create app" / "Just create the app" behave exactly as described below.

**Two switches, one declaration.** `LAUNCH_EXTENSIONS=interview` goes in the instance's git-ignored
`launch.deploy.env`; for local dev, the shell env works too. It drives both:
1. **Build:** `pnpm extensions sync` (new `scripts/extensions.mjs`):
   - Downloads the private bundle into git-ignored `apps/web/vendor/interview/` with `gh release download`.
     That uses the operator's own `gh` auth; in CI it's a `LAUNCH_EXTENSIONS_TOKEN` secret, and the step is skipped
     when the secret is absent.
   - Pins the version in the same env file, e.g. `LAUNCH_INTERVIEW_REF=v0.1.0`.
   - Writes git-ignored `apps/web/src/extensions/generated.ts`. It either re-exports the vendor bundle
     or exports `null`.
   - `pnpm install` runs it via a root `postinstall`, which always writes the `null` stub, so a fresh public
     clone typechecks, tests and builds unchanged.
   - Wrangler (esbuild), Vite and vitest all resolve the same file, so no toml `[alias]` and no
     conditional config are needed.
2. **Runtime:** a D30 `environmentGated` flag `app_interview` (`packages/shared/src/features.ts`).
   - The deploy-toml render adds it to `FEATURES_ENABLED` when the extension is declared.
   - `GET /api/app-drafts/capabilities` reports `interview: true` only when the bundle is present
     **and** the flag is on. A bundle without the flag stays off, and so does the flag without the bundle.

**Wiring:**
- Add `pnpm extensions sync` to `pnpm provision`'s build phase (the `/launch-deploy` path) and to
  `deploy.yml` (gated on the secret).
- `pnpm provision check` reports whether the extension is resolved (names only).

**The seam** (open, `apps/web/src/api/services/launch/interview/port.ts` + a UI twin):
```ts
interface AppInterviewExtension {
  emptyState(): unknown
  turn(i: { state: unknown; answer: string | null; ctx: InterviewContext; signal: AbortSignal },
       hooks: { onDone(next: unknown): Promise<void>; onSettled(): Promise<void> }): Response // SSE
  infer(i: { state: unknown; ctx: InterviewContext }): Promise<{ inferred: unknown; readiness: unknown }>
  Pane: React.ComponentType<{ turnUrl: string; draftId: string; onTurnDone(): void }> // UI half
}
// InterviewContext is injected: a model factory per role (from services/ai/resolve), the plugin
// catalogue, the module descriptions. The extension never imports the host.
```
- The host owns persistence, the turn claim, auth and the route.
- It validates `infer` output with `appBriefSchema.partial()` / `readinessSchema`, so a bad
  extension cannot write junk.
- Tests use a fake extension registered through the same port.

**Private repo `mirevue/launch-interview`** (new, private, no license):
- Depends on `interviewkit` via `github:mirevue/interviewkit#v0.1.0`.
- tsup bundles interviewkit inside (`noExternal`). Peers come from Launch's own deps: `zod`, `react`,
  `@anthropic-ai/sdk` (already `^0.122.0` in `apps/web`).
- Output is two ESM entries, `server.js` and `ui.js`, plus `styles.css`, attached to a private GitHub
  Release.
- It holds `defineInterview` (goal, coverage, output schema, `list_plugins`/`describe_modules` tools), the
  provider mapping, and the `Pane` built on `<InterviewConversation>` + `createSseTransport`.
- Its port types are copied structurally, since `@launch/shared` is private and not published. The
  host's zod validation is the real contract.
- It has its own tests using interviewkit's `testing` fake model.

## 4. Plugin catalogue
**rocketflare-plugins (PR, release 3.5.0):**
- Add `description` (one sentence) and `summary` (what it adds) to each `plugins/*/rocketflare-plugin.json`.
- Add `scripts/catalog.mjs`, which generates root `catalog.json`:
  `{ version, plugins: [{ id, label, description, summary, version, subdir, minKit, requires, vars, bindings }] }`.
  CI diff-checks the generated file.
- `example-feature` stays out, because it's vendored in the kit.

**Launch:** new `apps/web/src/api/services/launch/rocketflare/plugin-catalogue.ts`.
- Read `catalog.json` at a pinned plugins ref through the existing GitHub client, cached in KV with a TTL.
- A bundled snapshot is the fallback when GitHub is unreachable.
- Mark the kit pin's `defaultPlugins` as `default: true`.
- Filter by `minKit` against the kit pin (`services/launch/kit-pin.ts`).
- Contract: `pluginCatalogueSchema` in `packages/shared/src/launch-app-brief.ts`.
- Route: `GET /api/apps/plugin-catalogue`, plus CLI `launch apps plugins`.

## 5. Contracts (`packages/shared/src/launch-app-brief.ts`)
`appBriefSchema`:
- `problem`
- `audience`
- `tenancy: 'single'|'multi'`
- `signupMode`
- `modules: { chat, knowledge, agents }`
- `plugins: string[]`
- `features: [{ title, detail }]`
- `suggestedName?`

`appDraftSchema`:
- basics: `displayName`, `slug`, `ownerGroupId`, `description`, `deployStaging`
- `agentChoice` (runtime + credential, the shape from `components/agentChoice.ts`)
- `inferred: Partial<Brief>`
- `pins: string[]` (field paths)
- `readiness`: `{ ready, coverage per topic }`, a safe derivation. The ledger is never sent.
- `status: draft|creating|created|abandoned`
- `appId?`

`resolveBrief(draft, catalogue)`:
- A pure function, used by the panel, by "create", and by the server.
- Applies the precedence above.
- Expands plugin `requires` (m365 → connectors).
- Enforces module dependencies (chat's knowledge tools ⇒ the knowledge note).
- Returns each field with its provenance: `kit default | interview | you`.

`createAppRequestSchema` (`launch-pipeline.ts:39`) gains optional `brief` and `draftId`. If they're absent, nothing changes.

## 6. Database (one new migration from `pnpm db:generate`)
New `apps/web/src/db/schema/app-drafts.ts`, table `app_drafts`:
- Columns:
  - `tenantId`, `createdBy`
  - the basics columns
  - `agentChoice` jsonb
  - `interviewState` jsonb (interviewkit `InterviewState`)
  - `inferred` jsonb, `pins` jsonb
  - `status`, `appId`
  - `turnClaimId` + `turnClaimedAt` (the per-draft turn lock: a DB claim, never a Map)
  - timestamps
- Calls `tenantIsolation()`.

`apps.brief` jsonb (nullable): the resolved brief the app was created from. It's shown in Settings → General
and reused by rescaffold.

## 7. Interview: open host side + private engine
**Open, in `apps/web/src/api/services/launch/interview/`:**
- `port.ts`, the extension loader (reads `extensions/generated.ts`), `context.ts` (builds `InterviewContext`
  from `resolveChat` with prompt key `launch.app_interview`, registered in `packages/shared/src/ai/prompts.ts`),
  and `turn.ts`.
- `turn.ts`: claim the turn row (409 `turn_in_progress` otherwise) → `ext.turn(...)`. Its `onDone` saves
  state and its `onSettled` releases the claim. Then it enqueues the `launch.draft.infer` job, which calls
  `ext.infer` and validates the output.

**Private, in `mirevue/launch-interview`** (everything below in this step moves there):
- **`spec.ts`:** `defineInterview` with:
  - A **goal** aimed at choosing the config: what problem, who uses it, does one organisation or many use it,
    what data and integrations, where AI helps, the first three things it must do.
  - **Coverage:** `presets.topics` for problem · people & sign-in · data & integrations · AI · first features.
  - **Output:** a zod schema mirroring `appBriefSchema`, with `.describe()` text that maps answers onto the enums.
    interviewkit never offers menus, so `distil` does the mapping.
  - **`context.tools`:** `list_plugins` (from the catalogue) and `describe_modules`, so the interviewer can ask
    about what actually exists.
  - Defined once at module load, so the prompt cache stays warm.
- **`model.ts`:** maps `resolveChat(..., promptKey 'launch.app_interview')` from `services/ai/resolve.ts` onto
  interviewkit providers.
  - Anthropic uses `anthropicClient`. OpenAI-compatible uses `openAICompatibleClient`.
  - Workers AI gets a small `messages.stream` adapter. If it proves weak, the interview pane says the interview needs
    a model key and the panel still works as a form.
  - Register the prompt key in `packages/shared/src/ai/prompts.ts` so `agent_models` can assign the three roles.
- **`turn`:** `ik.turn(spec, state, answer)` → `toSseResponse(..., { audience: 'respondent', onDone, onSettled })`,
  with the host's hooks passed straight through. The ledger never reaches the browser.
- **`infer`:** `ik.distil` with a fast model, plus `completionReadiness` → `{ inferred, readiness }`.
  - The host's panel refetches the draft after each turn, polling briefly while the infer job runs.

## 8. Routes, `apps/web/src/api/routes/app-drafts.ts` (mounted under `/api/app-drafts`)
| Route | CLI (`launch apps drafts …`) |
|---|---|
| `POST /` create a draft | `new [name]` |
| `GET /`, `GET /:id` | `ls`, `show <id>` |
| `PATCH /:id` (basics, pinned fields, unpin) | `set <id> --tenancy multi --plugin connectors --no-module agents …` |
| `POST /:id/turn` (SSE) | `say <id> "<answer>"` (streams the reply as text) |
| `POST /:id/create`: `resolveBrief` → `requestApp` with the brief, the same approval path as `POST /api/apps` | `create <id> [--follow]` |
| `DELETE /:id` (abandon) | `rm <id>` |

- `launch apps create` also gains `--tenancy`, `--plugin`, `--no-module` for scripted creates.
- Each route gets its one-line summary comment. Run `pnpm api:catalog`.
- Tenant-scoped; drafts are visible to their creator and admins (CASL).

## 9. Full-screen UI, route `/apps/new` (and `/apps/new/:draftId`)
- Added to `ui/App.tsx` without the normal Layout chrome. It has a slim top bar with Close / back to the catalogue.
  The "New app" buttons (`CataloguePage.tsx:322`, `AppsSection.tsx:160`) navigate there.
  `CreateAppModal` is retired and its fields are extracted.
- **Left: the conversation**, only when `capabilities.interview` is true.
  - It renders the extension's `Pane`, which is loaded lazily from `extensions/generated.ts` so the open
    bundle carries nothing.
  - It inherits DaisyUI theme variables through `--ik-*`.
  - The no-key state is an inline notice ("the interview needs an AI model"), not an error.
  - Without the extension, the panel is centred, full width, and the conversation column is absent.
- **Right: the "Your app" panel** (new `pages/apps/new/AppBriefPanel.tsx`). Formatted like the Settings sections
  (`SettingsTab.tsx`): plain sections and rows, no card-in-card, no badges.
  1. *Basics:* reuses the extracted `AppBasicsFields` (name, slug with `slugFromName` / `newAppSlugProblem` /
     `hostPreview`, team, description, deploy staging).
  2. *Who uses it:* tenancy and signup.
  3. *Core modules:* chat, knowledge and agents toggles, with the dependency note.
  4. *Plugins:* catalogue rows with descriptions; `requires` auto-selects.
  5. *First features:* an editable list.
  6. *Build with:* the agent picker from `StartSessionButton`/`agentChoice.ts`.
  - Each row shows its provenance in muted text ("kit default" / "from the interview" / "set by you", with an undo
    that unpins). A `CoverageStrip`-style line shows the interview topics.
- **Sticky footer:**
  - "Just create the app" is always enabled once the basics are valid.
  - It becomes the primary "Create app" when readiness is ready.
  - The existing 409/403/503/`launch_not_reachable` error mapping moves over from the modal.
  - On success it navigates to `/apps/:slug` (the existing PipelineProgress takeover).
- The catalogue shows "Drafts" (resume or discard) when you have any.

## 10. The scaffold applies tenancy and plugins
- `scaffoldPlanSchema` (`launch-pipeline.ts:560`) gains `plugins?: [{ id, repo, ref, subdir }]`, resolved from the
  brief and the catalogue.
- In `.launch/scaffold.mjs` (`rocketflare/scaffold-job.ts`, `installDefaultPlugins`), if `plan.plugins` is present it
  replaces the `default-plugins.mjs --tsv` entries. An empty list means none.
- `scaffold.verify` checks the installed set matches.
- `launchVars` (`rocketflare/toml.ts:450`) takes `tenancy` and `signupMode` from `apps.brief` instead of the
  constants. The default is still single/open.
- Rescaffold reads `apps.brief`.

## 11. The build session after live
- A new launch step `build_session` after `live` in `api/workflows/app-launch.ts`. It doesn't block, like `email`.
- It runs when the brief has features or disabled modules: `createSession(db, env, { firstMessage, runtime/credential
  from the draft, title: 'Build: <name>' })`, following `services/launch/upgrades.ts:320`.
- `interview/build-prompt.ts` renders the brief:
  - the problem and the audience
  - "remove these surfaces per `docs/ADAPTING.md` §2 / `.rocketflare.json` surfaces" (chat / knowledge / agents)
  - the features to build, in order
  - "run the gate; never commit — Launch ships"
- The `app.launched` notification links to the session.
- Add the step to `APP_LAUNCH_STEPS` so PipelineProgress shows it.

## 12. Open questions

1. **Will the interview ever ask the config questions directly?** interviewkit's interviewer rules forbid offering a menu ("single or multi-tenant?") and cannot be overridden. This design asks about the problem instead: `distil` maps the answers onto the enums, and the panel is where a person states a choice outright. Is that the experience we want, or should the extension ask a short, explicit closing question when a field is still at its default?
2. **The cost of inferring the config live.** The panel only fills in during the interview because `infer` runs `distil` after every turn: one extra model call per turn, on a fast model. The alternative is inferring only on demand ("Refresh") and at create time.
3. **Multi-tenancy behind Launch's OIDC.** Apps sign in only through Launch (`AUTH_OIDC_ONLY=true`). Before multi-tenant is offered, prove that creating and switching organisations works in an app whose only login is Launch's issuer.
4. **Module removal is done by the agent and nothing checks it.** The session deletes surfaces following the kit's `docs/ADAPTING.md` §2, and the pipeline does not verify the result. The longer-term fix is a kit change that turns the modules into config, for example a `MODULES_ENABLED` var with removal kept for a deliberate trim. Revisit after the first few apps.
5. **Is the extension seam interview-only or general?** As written, `LAUNCH_EXTENSIONS` / `extensions.mjs` take a list, but the only port is the interview. Generalise it only when a second private extension exists.
6. **The interview on Workers AI.** Without an Anthropic or OpenAI-compatible key, the interview runs on Workers AI behind a small adapter. Its quality there is unknown. The fallback is to hide the conversation and keep the panel.
7. **Drafts' lifetime.** How long an abandoned draft is kept, and whether a cron sweeps them.
8. **Catalogue against the kit pin.** `minKit` filtering uses Launch's kit pin. Should a plugin that needs a newer kit than the pin be shown greyed out with the reason, or hidden?

## 13. Docs, tests and gate
- **Docs:**
  - `docs/CONCEPTS.md` §18.5 gets a subsection "Creating an app by interview" with known gaps (Workers AI interview
    quality, the infer job costs one model call per turn, module removal is agent-done and not verified by the
    pipeline).
  - Update `spec/02-template-contract.md` (scaffold input gains plugins/tenancy) and `spec/06-registry-and-pipeline.md`.
  - Add a line under `CHANGELOG.md` `## Unreleased`.
  - Update `.claude/rules/cli.md` if command conventions shift.
  - `docs/DEPLOYMENT.md` explains `LAUNCH_EXTENSIONS` and the CI secret. It says private extensions exist,
    without describing the interview's internals.
- **Tests:**
  - `resolveBrief` precedence, requires-expansion and defaults (shared, table-driven).
  - Draft routes: tenant isolation, the claim → 409, create → `requestApp` carrying the brief.
  - The turn route and the infer job, using a **fake extension** through the port. That includes the case where
    the extension returns invalid output.
  - Capabilities: interview is true only when the bundle is present and the flag is on.
  - The public build has no interviewkit: a config test greps the built worker and UI for `interviewkit`, and
    `package.json`/`pnpm-lock.yaml` must not mention it.
  - `extensions.mjs`: the stub is written on a fresh clone, and a missing token skips cleanly.
  - `launchVars` tenancy.
  - The scaffold-plan plugin list (the scaffold-job unit tests).
  - `build_session` with `FakeSandbox`.
  - The catalogue fallback.
  - UI: pinning, unpin, and Just create.
  - The cli-parity and api-catalog tests are kept green.
- **Work in a worktree branch, not the live dev tree.** See the "Working rules learned" section of [README](README.md): never build in the checkout that runs `pnpm dev`.

## 14. Verification
1. Run `pnpm lint && pnpm typecheck && pnpm test && pnpm build` in the worktree.
2. Check the public path from a clean clone with no `LAUNCH_EXTENSIONS`: the gate passes, `/apps/new` shows the panel
   only, and the build grep finds no interviewkit.
3. In `mirevue/launch-interview`, run its tests, cut `v0.1.0`, and attach the bundle to a private release.
   Then run `LAUNCH_EXTENSIONS=interview pnpm extensions sync` in the worktree.
4. Locally, using `pnpm dev` in the worktree on its own ports/DB, drive it in the browser through chrome-devtools:
   - `/apps/new` → answer 4–5 turns → the panel fills in, showing "from the interview".
   - Pin tenancy=multi and untick agents → "Create app".
   - Check the app row's `brief`, the scaffold plan's plugins, and that the toml vars show `TENANCY_MODE=multi`.
5. Try "Just create the app" with no answers. The result should be the same as today's create.
6. The CLI path: `launch apps drafts new` → `say` → `set` → `create --follow`.
7. Check `build_session` against FakeSandbox in tests. The real end-to-end (GitHub runner + session) only happens on
   a deployed Launch.
