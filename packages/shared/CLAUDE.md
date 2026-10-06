# Shared Contracts (`packages/shared` — `@launch/shared`, private)

Zod schemas + inferred types used by BOTH the API and the UI (D13). Contracts first: a new or
changed API surface starts here, then the route `validate()`s with it, then the UI parses the
response with the same schema. `pnpm test:config` covers the pure parts.

## Naming

- `<thing>Schema` — a response / entity shape (`memberSchema`, `sessionResponseSchema`)
- `<thing>RequestSchema` — a request body (`inviteMemberRequestSchema`); `<thing>QuerySchema` — query params
- `type <Thing> = z.infer<typeof <thing>Schema>` exported next to it; never a hand-written duplicate
- Timestamps are `z.coerce.date()` (JSON carries strings); nullable columns are `.nullable()`, not `.optional()`
- jsonb columns are typed from here (`TenantSettingsJson`, `UserPreferences`, `NotificationData`, `ActivityMetadata`)

## Files

`auth.ts` session/login · `tenants.ts` roles, slugs, members, invitations · `access-requests.ts` ·
`permissions.ts` actions/subjects/`AppAbility`/packed rules (matrix lives in `apps/web/src/permissions/`) and
`canAdministerPlatform` + `PLATFORM_ADMIN_ROLES` — the pure platform-admin rule the server's
`platformAdminMiddleware` and the UI's `'platformAdmin'` nav guard both call ·
`api-keys.ts` · `tenant-settings.ts` · `user-settings.ts` · `notifications.ts` · `admin.ts` ·
`activity.ts` · `errors.ts` envelope + codes · `pagination.ts` ·
Launch (P1): `launch-apps.ts` (registry enums + environment jsonb shapes, spec/04 slug rules
`appSlugProblem`/`appSlugSchema`, `importAppRequestSchema`, the lenient `rocketflareManifestSchema`,
catalogue/detail/health/operations responses (the catalogue row is `appCatalogueItemSchema` — the summary plus `latestDeploy`), deploy progress (`DEPLOY_STEPS`, `DEPLOY_PHASES`, `deployProgressSchema`, `appDeployProgressResponseSchema` — derived from a deploy ticket server-side, here because `launch-pipeline.ts` imports this file), the OIDC client and its once-only
`appOidcClientSecretResponseSchema`, `appOidcConfigSnippet` — the one config text the API and UI
both show), `launch-oidc.ts` (access policy, signing-key and access-request statuses, redirect URIs,
public JWK, the key-admin responses and the `/api/app-access` request/policy/grant contracts), `launch-setup.ts`
(credential kinds, per-kind payloads, checks, the value-free `credentialStatusSchema`, setting
keys — the wizard's string `SETUP_SETTING_KEYS` plus P2's `template_pin` (a release tag, or with no `tag` an unreleased commit — `isCommitPin`, `templatePinLabel`, `templatePinRef`, and the Kit version card's `templatePinRequestSchema` / `templatePinStatusSchema` / `kitTagsResponseSchema`) / `app_create_role` with
their code defaults and `meetsAppCreateRole`), `launch-audit.ts` (audit event, `auditListQuerySchema` / `auditListResponseSchema`, cursor-paged) ·
Launch (P2): `launch-pipeline.ts` (`newAppSlugProblem` — the `launch-` rule on top of
`appSlugProblem` — `createAppRequestSchema`, `APP_LAUNCH_STEPS` / `APP_TEARDOWN_STEPS` (the
Workflow's steps) and the view's rows over them, `PIPELINE_VIEW_STEPS` (a CI job's start / wait /
check as one row) + the pure `mergePipelineParts`, the `pipelineViewSchema`, retry/teardown bodies, the Workflow params, deploy tickets and decisions, the
DEPLOYER.md v1 bodies behind `/ci/deploy`, the `/ci/scaffold` token and done bodies, and the event
types `SCAFFOLD_FINISHED_EVENT` / `DEPLOY_FINISHED_EVENT`, golden-tested against Cloudflare's
`/^[A-Za-z0-9_-]{1,100}$/`) ·
Launch (P3): `launch-sessions.ts` (coding sessions — `SESSION_KINDS`, `SESSION_STATUSES` with
`ACTIVE_SESSION_STATUSES` (the concurrency index's predicate is rendered from it) and
`TERMINAL_SESSION_STATUSES`, `SESSION_ACTIONS`, `SESSION_EVENT_TYPES` + `SESSION_EVENT_DATA` (the
agent-run payloads reused for `text`/`tool.*`/`step`/`status`/`error`; issue #8's
`sessionBootTimingDataSchema` over `BOOT_TIMING_PHASES`), `sessionPolicySchema` +
`DEFAULT_SESSION_POLICY` + `resolveSessionPolicy`, microcents helpers, the jsonb shapes
(`sessionDbSchema`, `appSessionDbSchema`, `prChecksSchema`), the request/response bodies of
`/api/sessions`, `/api/apps/:id/sessions` and `/api/admin/sessions` (`sessionSchema` carries no
token and no sealed column — a config test pins it), `sessionWorkflowParamsSchema`,
`SESSION_WAKE_EVENT` (golden-tested) and `SESSION_REALTIME_ENTITY`, and the preview-host grammar:
`newSessionShortId` / `newPreviewToken`, `previewLabel`, `previewUrl`, `parsePreviewHost`);
`launch-setup.ts` gained the `anthropic_api_key` kind and the `session_policy` / `sessions_paused`
settings · §18.22: `launch-agents.ts` (`AGENT_RUNTIMES` + labels, `SESSION_CREDENTIAL_MODES` /
`SESSION_CREDENTIAL_SOURCES`, the value-free `agentCredentialSchema`, `AGENT_LOGIN_STATUSES` with
`AGENT_LOGIN_ACTIVE_STATUSES` (the active-login index renders it), `agentLoginSchema`, the
start/code bodies, `AGENT_LOGIN_CODE_EVENT` (golden-tested), `AGENT_LOGIN_TTL_MS`,
`agentAccountsResponseSchema`, `agentPickerVisible`); `launch-sessions.ts` gained
`runtimePolicySchema` + `runtimePolicyOf` / `defaultRuntimeOf`, the policy's optional `runtime` /
`runtimes`, the create body's `runtime?` / `credential?` and the session's `runtime`,
`credentialSource`, `credentialOwnerUserId` (defaulted, so an older payload parses);
`launch-setup.ts` the `openai_api_key` kind; `ai/usage.ts` `AI_USAGE_BILLINGS`; then the Coding
agents setting (the runtimes moved from deployment vars to the policy): `launch-agents.ts`
`AGENT_RUNTIME_PROVIDERS`, `AGENT_RUNTIME_MODELS` (the offered, priced models) and
`isPricedRuntimeModel` (imports `ai/pricing`); `runtimePolicyOf` fails closed (no entry: Claude
Code on Launch's key, every other runtime off); `launch-setup.ts` `AGENT_RUNTIME_MIN_IMAGE`,
`AGENT_RUNTIME_PLATFORM_KEY`, `sessionAgentsUpdateSchema` (`PUT /session-agents`, an unpriced model
refused), `SESSION_AGENTS_NONE_ENABLED`, `sessionAgentStatusSchema` / `sessionAgentsStatusSchema`
and the overview's `sessionAgents` (`launch-setup.ts` imports `launch-agents` and
`launch-sessions`, never the reverse) ·
Launch (P4, `docs/plans/p4-approvals.md`): `launch-approvals.ts` (the approvals engine —
`APPROVAL_KINDS` (+ `BUILT_APPROVAL_KINDS`, the four with handlers), `APPROVAL_STATUSES`,
`APPROVAL_SUBJECT_TYPES`, `APPROVAL_POLICY_SCOPES`, `AUTO_APPROVE_ROLES` + `meetsAutoApproveRole`,
`approvalPolicySchema` + `DEFAULT_APPROVAL_POLICIES` (the plan's §1.7 table, with `app.access`
owners AND admins; the 0023 migration's policy literal plus 0024's widening is tested equal to
`app.access`'s), `approvalContextSchema` (discriminated by `kind`), the
request/detail/decision/list/count bodies of `/api/approvals` (the detail's optional `eligible`
names who a pending request waits on, capped at `APPROVAL_ELIGIBLE_MAX`), the policy bodies of
`/api/approval-policies`, `APPROVAL_WHY_NOT` / `APPROVAL_ERROR_CODES`, `APPROVAL_REALTIME_ENTITY`,
`APPROVAL_NOTIFICATION_TYPES` and `approvalPath`), `launch-releases.ts` (`RELEASE_STATUSES` — the
`release_status` pg enum — `bumpVersion` / `parseReleaseVersion` / `releaseTagRef`,
`releasePrSchema` (the `app_releases.prs` jsonb), `PROMOTABLE_RELEASE_STATUSES` /
`isPromotableRelease` (what the route and the Promote button both accept), the release, promote and
chain bodies, `RELEASE_REALTIME_ENTITY`) and `launch-promotion.ts` (`appPromotionSchema` — the app
page's pipeline strip, `GET /api/apps/:id/promotion`: the candidate release, each environment's
version and health, the PRs between with their sessions' titles, the pending `deploy.production`
request and who it waits on); `launch-audit.ts` gained `auditVerifySchema` and
`auditExportQuerySchema` / `auditExportRowSchema` (`seq`, `prevHash`, `hash`); `launch-pipeline.ts`
the `approval` decision source, `releaseId` / `approvalId` on a ticket and `approvalId` on the
create and production-deploy answers; `launch-sessions.ts` an optional `reason` on
`extendBudgetSchema` and `extendBudgetResponseSchema` (the session plus the `session.budget`
`approvalId`) ·
Launch (P5, `docs/plans/p5-grants.md`): `launch-grants.ts` (shared config and grants — the closed
sets `SHARED_RESOURCE_VALUE_STATUSES`, `GRANT_STATUSES` + `LIVE_GRANT_STATUSES`,
`GRANT_PUSH_REASONS`, `GRANT_PUSH_STATUSES` + `ACTIVE_GRANT_PUSH_STATUSES` (both index predicates
are rendered from these), `GRANT_PUSH_TARGET_STATUSES`, `GRANT_BACKENDS`; `sharedResourceItemSchema`
/ `sharedResourcePoliciesSchema` (the jsonb columns); the `/api/shared-resources` bodies and answers
— **values are write-only**: no response schema has a field for a secret, and `vars` only reaches
owners and admins; `appConfigSchema`, `requestGrantSchema`, `grantPushSchema`, `grantPushParamsSchema`;
the realtime entities `shared_resource` / `grant_push` / `app_config`, `GRANT_NOTIFICATION_TYPES`,
`GRANT_ERROR_CODES`, `SECRETS_PATH` / `sharedResourcePath` — the UI calls them Secrets, `/secrets/:id` —
/ `appConfigPath`); `launch-approvals.ts` built
`grant.request` (`BUILT_APPROVAL_KINDS` has five, `grant` subject, `grantRequestContextSchema`,
`GRANT_ITEM_KINDS`, the owner-group default); `launch-sessions.ts` the `ship.config_needs` event ·
Launch issue #5 (ship means live on staging, `docs/plans/i5-ship-to-staging.md` §2, the
contracts every slice built on): `launch-apps.ts` the app's ship settings
(`SESSION_SHIP_MODES` `staging | pr`, `SHIP_REVIEW_MODES` `none | app_owners | groups`,
`appShipSettingsSchema` — the `apps.ship_settings` jsonb — `DEFAULT_APP_SHIP_SETTINGS` (staging, no
review), `resolveAppShipSettings`, `putAppShipSettingsRequestSchema` (`groups` names ≥ 1 team)),
`appDetailSchema.shipSettings` / `shipReviewSetBy` (`app | policy`, both defaulted so an older answer
parses), `KIT_REQUIRED_CHECK` (`Gate`), `BRANCH_PROTECTION_STATES` and `appBranchProtectionSchema`;
`launch-sessions.ts` (imports the modes from `launch-apps`, never the reverse) the landing —
`SHIP_LANDING_STAGES` (+ `MOVING_LANDING_STAGES`), `SHIP_STALLED_REASONS`, `SHIP_REOPEN_REASONS`,
`LANDING_REVIEW_MODES` (the app's modes plus `policy`), `SHIP_CI_MAX_MINUTES` /
`SHIP_CI_NONE_GRACE_MINUTES`, `sessionLandingSchema` (the `sessions.landing` jsonb; timestamps are
ISO strings so the row round-trips), `sessionShipSummarySchema` (`sessions.ship_summary`, capped by
`SHIP_SUMMARY_{TITLE,BODY,DIFFSTAT}_MAX`), `sessionSchema.landing` / `shipSummary` (nullable,
default null), the six events `ship.ci` · `ship.review` · `ship.merged` · `ship.released` ·
`ship.staging` · `ship.reopened` (appended, each in `SESSION_EVENT_DATA`) and an optional `title` on
`ship.pr`; `PR_CHECK_STATES` moved above the events (`ship.ci` carries one — a zod module reads
its consts at evaluation, so order matters); issue #9 adds `gateTree` (nullable, default null) to
the landing and the ship summary, an optional `tree` on `ship.gate`, `LAUNCH_GATE_CHECK`
(`launch/gate`) / `launchGateExternalId` and `requiredCheckState` (the landing's verdict: `Gate`
alone, `launch/gate` never CI — it imports `KIT_REQUIRED_CHECK` from `launch-apps`);
`launch-approvals.ts` the built `session.merge`
(appended to both kind lists, `sessionMergeContextSchema`, `SESSION_MERGE_EXPIRY_HOURS` 48 and its
owners-only default); `launch-releases.ts` `RELEASE_ERROR_CODES` (`inProgress:
'release_in_progress'`; app page P2 adds `notRetryable`, `stageChanged`, `runInProgress`,
`githubFailed`, `notCancellable`), and (app page P2) `RELEASE_FAILED_STAGES` + the pure
`releaseFailedStage` (what `releaseSchema.failedStage` — nullable, default null — carries),
`RELEASE_STAGE_LABELS` / `RELEASE_RETRY_LABELS`, `retryReleaseSchema` /
`retryReleaseResponseSchema` and `cancelReleaseResponseSchema`; `launch-sessions.ts`'s
`createSessionRequestSchema` gained `fixRelease: { releaseId }`; `launch-promotion.ts` a change's `summary` (nullable, default null — an
older answer still parses) and `PROMOTION_SUMMARY_MAX` 600, and `candidateRunSchema` /
`candidateRun` (the candidate's tag deploy run on GitHub — status, conclusion, URL, current and
failed job; nullable, default null) with `CANDIDATE_RUN_FAILED_CONCLUSIONS` / `candidateRunFailed` ·
Launch P6 6c (kit upgrades, one app): `launch-upgrades.ts` — `UPGRADE_TARGET_KINDS`,
`APP_UPGRADE_STATUSES` + `OPEN_APP_UPGRADE_STATUSES` (the open index renders it) and their labels,
`UPGRADE_ERROR_CODES`, the semver helpers over `compareReleaseVersions` (`kitVersionOf`,
`kitVersionBehind`, `kitVersionReached`), `appUpgradeSchema`, `kitStatusSchema` (what
`appSummarySchema.kit` carries, defaulted null), `requiresUpgradeLabel`, `kitUpgradeNotesUrl`,
the start/list responses, and the upgrade session's `UPGRADE_RESULT_MARKER` + `upgradeResultOf`
and its `status` event (`UPGRADE_SESSION_REASONS`, `upgradeSessionStatusDataSchema`);
`launch-sessions.ts` gained the `upgrade` kind and `CODING_SESSION_KINDS`; `launch-apps.ts`
imports `launch-upgrades`, never the reverse ·
`features.ts` (D30) — the feature-flag registry (`CORE_FEATURE_FLAGS`, EMPTY — Launch ships no
flag yet — merged with each plugin's `SharedPlugin.features` into
`FEATURE_FLAGS`, keyed on `FEATURES`/`FeatureName` from `permissions.ts`, where `CORE_FEATURES` is
likewise empty; so `featureNameSchema` is a refined `z.string()` over the runtime list rather than a
`z.enum`, which needs a non-empty tuple), `featureBucket` (**a wire format — changing it reshuffles every live
rollout**), `evaluateFlag`/`evaluateFeatures` (the one implementation of the environment-then-rollout
precedence), and the admin contracts. A flag is CONFIGURATION, not a permission: nothing here
touches CASL · `groups.ts` (D29) — `groupTypeSchema`/`groupSchema` (with `typeName` and `memberCount`)/`groupDetailSchema`,
`groupRefSchema` (what the auth context, a member row and a restricted resource all carry),
`myGroupsSchema`, the create/update/`addGroupMembers`/`setMemberGroups` request schemas,
`resourceVisibilitySchema` (`tenant | groups`), `setVisibilityRequestSchema`, `resourceAccessSchema`
and `isPrivateSelection()` (a `groups` selection with nothing in it means owner-and-admins only — the
UI warns, it does not block) · Phase 2 (server ⇄ UI, no HTTP):
`realtime.ts` — `realtimeEventSchema` `{ type, tenantId, at, payload? }`, `realtimeEventTypeSchema`,
`REALTIME_INVALIDATIONS` (event type → TanStack query-key roots) + `invalidationsFor()` (D8; it is
one of the five composers — it unions each plugin's `realtimeRoots` into `access.changed`) ·
`plugins/types.ts` + `plugins/index.ts` (D31) — `SharedPlugin`, `PLUGIN_ID_RE`/`isPluginId`, the
`SHARED_PLUGINS` barrel one line per installed plugin is written into, and the per-plugin
derivations the composers read — `DeclaredBy<P, K>` first, which narrows the barrel union to the
plugins that actually DECLARE an optional field (indexing `as const` literals directly is a compile
error for a plugin that omits one, and `never` is exactly the empty contribution wanted), then
`JobTypeOf`, `AgentKeyOf`, `PromptKeyOf`, `SubjectOf`, `FeatureKeyOf` on top of it;
**no runtime import of a composer, see Rules**. A plugin's own contracts live in
`plugins/<id>/index.ts`, which is its ONE published shared surface — nothing outside the plugin may
import a deeper path, and `tests/config/plugins.test.ts` is the check ·
`jobs.ts` — per-type payload schemas and `CORE_JOB_VARIANTS`, the ONE list everything else is
DERIVED from (D31): `JOB_VARIANTS` = core + every plugin's, `jobInputSchema` (what `enqueueJob`
takes), `jobEnvelopeSchema` (`+ id, enqueuedAt, attempt?`, what the consumer parses), `JobType` /
`CoreJobType` / `JOB_TYPES`, `JobOf<T>` (D7) ·
`files.ts` — `FILE_SCOPES`/`fileScopeSchema`, `MAX_UPLOAD_BYTES`, `AVATAR_MIME_TYPES`/`isAvatarMimeType`,
`INLINE_MIME_TYPES`/`isInlineMimeType` (served `Content-Disposition: inline`) and
`EMBEDDABLE_MIME_TYPES`/`isEmbeddableMimeType` (may ALSO be framed) — two lists on purpose, because
inline and framable are different properties, `filePath(id)`, `fileSchema`/`uploadResponseSchema`,
`uploadQuerySchema` (D23) ·
`jobs.ts` also carries `document.index` (`{ tenantId, documentId }` — re-index a `documents` row, D18) ·
**`ai/`** (Phase 3, D17/D18/D32; barrel `ai/index.ts`, deep imports `@launch/shared/ai/<file>` equally valid):
`config.ts` — `AI_PROVIDERS`/`aiProviderSchema` (append LAST: the DB column is a text enum), `AI_SCOPES`
(`chat | embeddings`), `thinkingSchema` + `THINKING_*` bounds, `aiConfigSchema` (sanitised row:
`hasCredential`, never a key), `upsertAiConfigRequestSchema` (`apiKey` write-only), `testAiConfigRequest/ResponseSchema`,
`aiReadinessSchema`, `DEFAULT_MODELS`, `PROVIDER_PRESETS`/`presetsFor` (vendors are data, not enum values),
**`EMBEDDING_DIM = 1024`** (the `chunks.embedding` column width — a change is a migration) ·
`evals.ts` (D33) — `evalCaseSchema` (the dataset line: `id`, `input` string|object, `messages`,
`context` docs, `expected { output, rubric, tools, toolsMatch, contains }`, `tags`, `source` — a
promoted case names the message/run, never the tenant, `agentKey`), `EVAL_TRAJECTORY_MODES`,
feedback (`FEEDBACK_TARGETS` `message|agent_run`, `feedbackRatingSchema` `1|-1`,
`createFeedbackRequestSchema`, `feedbackSchema`, list/mine queries and responses,
`feedbackTargetParamSchema`) and `evalExportQuerySchema` (exactly one of `messageId`/`runId`) /
`evalExportResponseSchema` (`containsTenantData: true`) — `/api/feedback`, `/api/evals`, the CLI and
`apps/evals` ·
`traces.ts` (D32) — `TRACE_SPAN_KINDS` (`agent|llm|tool|retrieval|embedding|job|span`), `traceIdSchema` (32 hex), `traceSpanSchema`, `traceSummarySchema`, `traceListQuerySchema` / `traceListResponseSchema`, `traceDetailSchema`, `traceLookupParamSchema` (trace id OR uuid) — `GET /api/traces` and the CLI ·
`prompts.ts` — `promptKeySchema` (kebab-case), `PROMPT_MAX_LENGTH`, `promptDefinitionSchema`, `promptOverrideSchema`,
`updatePromptRequestSchema`, `promptWithResolvedSchema`, `interpolatePrompt()` (`{{var}}`, unknown left visible) ·
`chat.ts` — `conversationSchema`, `messageSchema`, `tokenUsageSchema`, `toolCallRecordSchema`, request bodies,
`MAX_MESSAGE_LENGTH`, `CONVERSATION_TITLE_LENGTH`, `CHAT_MAX_TOOL_TURNS`, and the history budget
(`CHAT_HISTORY_MAX_MESSAGES` backstop, `CHAT_SUMMARY_MAX_CHARS`, `CHAT_COMPACTION_MIN_CHARS`; the
real budget is the `CHAT_HISTORY_MAX_CHARS` var) — the DB-shaped half; the wire protocol is `agui.ts` ·
`agents.ts` — `CORE_AGENT_KEYS` (what you append to) leading `AGENT_KEYS` = core + every plugin's
`agentKeys`, and `agentKeySchema` over it (never empty — it is a `z.enum`, and CORE is what keeps it
non-empty), `AgentMeta<Input, Output>`
(the server attaches `run()`), `agentInfoSchema`, `agentRunStatusSchema` + `isRunActive`, `agentRunSchema`,
`createAgentRunRequest/ResponseSchema` (`deduplicated`), `agentRunListQuerySchema`, `AGENT_RUN_EVENT_TYPES`,
`agentRunEventSchema` + `AGENT_RUN_EVENT_DATA` (type → payload schema; `tool.*`/`text`/`status`/`error`
were conventional and are now contracts), `agentRunWithEventsSchema` (`+ interrupts[]`, `artifacts[]`),
`ACTIVE_RUN_STATUSES` vs `CLAIMABLE_RUN_STATUSES` (a parked run holds the exclusive slot but is NOT
claimable — the resolve route flips it back to `running` first), `AGENT_RESUME_EVENT` +
`WORKFLOW_EVENT_TYPE_PATTERN` (Workflows event names allow only letters, digits, `-`, `_`; a `.` is
`workflow.invalid_event_type`, which no Node test would catch), `MAX_INTERRUPT_ROUNDS`, the
`RUN_STREAM_*` cadence constants, the example's `summarizeTextInput/OutputSchema` ·
`interrupts.ts` — human-in-the-loop (issue #17): `AGENT_INTERRUPT_KINDS` (`approval · choice · input ·
form`, closed), `agentInterruptSpecSchema` (the TYPED `spec` column — an untyped jsonb blob called
`metadata` is where render bugs live), the four payload schemas + `interruptPayloadSchema(spec)` and
`formValuesSchemaFor(fields)` (the ONE validator the route and the UI both call),
`INTERRUPT_REJECTION`/`rejectionFor` (a declined APPROVAL stops the run; every other decline is an
answer the model is told), `AGUI_REASON_FOR_KIND`/`aguiReasonFor`, `agentRunInterruptSchema` (the row;
`key` is MANDATORY and `UNIQUE (run_id, key)` is what stops a re-entered step asking twice),
`resolveInterruptRequestSchema` (`status` + `payload`, AG-UI's own `ResumeEntry` vocabulary — there is
deliberately no second `approved` boolean), the inbox contracts, steering, and the `interrupt` /
`interrupt.resolved` event payloads. **It must not import `@ag-ui/core`** (that is `agui.ts` alone,
where `toAguiInterrupt` lives) **and must not import `./agents`**, which imports IT — two zod modules
in a cycle crash at module evaluation, not at compile time ·
`artifacts.ts` — what a run produces that a person opens: `AGENT_ARTIFACT_KINDS`,
`agentArtifactDataSchema` (`document`/`file` carry IDS, never content), `agentArtifactSchema` (`key`
is the upsert key), the thin `artifact` event payload. A table rather than an event type because an
artifact is mutable, queried across runs and outlives the run; size caps live here, not in the column ·
`agui.ts` — the AG-UI wire protocol (`@ag-ui/core` schemas, the ONE file allowed to import it):
`kitAguiEventSchema` (a discriminated union over exactly the events the kit emits, never the full
`@ag-ui/core` set), `KIT_AGUI_EVENT_TYPES`, `KIT_CUSTOM_EVENTS` + `kitCustomPayloadSchema` +
`parseKitCustom` (the `kit.` CUSTOM namespace where every kit-specific semantic lives, including
`kit.document` — a `documentCardSchema` for a document a knowledge tool surfaced),
`chatRunResultSchema` (`RUN_FINISHED.result` for a chat turn), `toAguiInterrupt(row)` (the kit row is
the truth, the protocol shape is a projection of it — and the HITL pause/answer need NO new event:
`RunFinishedEventSchema` already validates an `outcome` and `RunAgentInputSchema` already carries
`resume[]`), `kitRunAgentInputSchema` +
`readRunAgentTail` (`POST /api/agui/run`: the server is the transcript, the client supplies the tail) ·
`agent-models.ts` — `agentModelAssignmentSchema`, `upsertAgentModelRequestSchema` (at least one of
`aiConfigId`/`model`), `agentModelEntrySchema` (`effective.source: assignment | tenant | platform | none`) ·
`embeddings.ts` — `documentSchema` (never the text or vectors), `INGEST_TEXT_MAX_CHARS`, `ingestTextRequestSchema`,
`documentListQuerySchema`, `searchRequestSchema` (`SEARCH_MAX_LIMIT`), `searchHitSchema` (RRF `score`, `rank`,
`denseRank`/`lexicalRank`), `searchResponseSchema`, and the read side (D18): `documentContentSchema` + `documentContentQuerySchema`
(`DOCUMENT_WINDOW_CHARS` 20 000, `DOCUMENT_WINDOW_MAX_CHARS` 50 000) + `windowStart()` (snap an offset
down to a window boundary so a deep link and the reader's paging share one cache entry),
`documentPassageSchema`, `documentCardSchema` + `DOCUMENT_EXCERPT_CHARS` + `documentPath()` (the ONE
place the viewer route is written) + `documentCardFromDocument()`, and the pure
`documentCardsFromToolResult()` / `documentCardsFromToolCalls()` + `KNOWLEDGE_TOOLS` +
`documentExcerpt()` that the chat stream, the agent-run projection and the UI's persisted-message
rendering all share · `usage.ts` — `aiUsageSchema`, `aiUsageSummarySchema`,
`aiUsageSummaryQuerySchema` (`costMicrocents` nullable, `unpricedCalls`) · `pricing.ts` — `MODEL_PRICES`
(USD per million tokens, per provider, longest-prefix model match), `PRICES_UPDATED`, `priceFor`,
`estimateCostMicrocents`; the ONE place to correct rates, unknown model → null, never a guess. `errors.ts` codes added: `ai_not_configured`,
`agent_runs_not_configured`, `agent_run_active`; `permissions.ts` subjects added: `AiConfig`, `Prompt`,
`Conversation`, `AgentRun`, `Document` — plus whatever an installed PLUGIN declares in
`SharedPlugin.subjects` (the analytics plugin's `Dashboard` and `Analytics`, D19 + D31, which is
where its contracts live too: `@launch/shared/plugins/analytics/index`). Known gap:
`GET /api/ai/config/providers` has no schema here (the catalog is server data in
`apps/web/src/api/services/ai/providers.ts`; the UI keeps a permissive one).

Adding an interrupt kind: the literal in `AGENT_INTERRUPT_KINDS` + an ask variant in
`agentInterruptSpecSchema` + a payload schema + arms in `INTERRUPT_REJECTION`, `AGUI_REASON_FOR_KIND`
and `interruptPayloadSchema` (all four are exhaustive, so the compiler is the checklist) + one UI
branch. Adding a job type: a payload schema + ONE variant in `CORE_JOB_VARIANTS` (both unions and both
type lists follow from it) + an entry in `coreHandlers` (`apps/web/src/api/queues/jobs.ts`); there
is no `runHandler` switch to keep in step, because the handler table's mapped type is the check. Adding an
agent: the key in `CORE_AGENT_KEYS` + its input/output schemas in `ai/agents.ts` (then the prompt, the
definition and the `CORE_AGENTS` entry server-side — `docs/ADAPTING.md` §3). **Each of those is a
PLUGIN slot too** (D31): a job type is `SharedPlugin.jobs` + `ServerPlugin.jobHandlers`, an agent
`SharedPlugin.agentKeys` + `ServerPlugin.agents`, a flag `SharedPlugin.features`, a subject
`SharedPlugin.subjects` — declared in `packages/shared/src/plugins/<id>/index.ts` and merged in by
the composer, so a plugin never edits one of these literals. Adding an AI provider: the
value in `AI_PROVIDERS` + `DEFAULT_MODELS` (mirrored in `apps/web/src/db/schema/ai-configs.ts`); a
vendor on an existing wire format is a `PROVIDER_PRESETS` entry only. Adding a streamed event: an AG-UI type in
`kitAguiEventSchema` or a member of the kit CUSTOM namespace in `ai/agui.ts` — the UI drops frames it
cannot parse, so the server may lead. A breaking
payload change is a NEW type (`email.send.v2`) — the `type` string is the version seam. Adding a
realtime event type: the enum + its roots in `REALTIME_INVALIDATIONS` (a ui test checks every root
is a `queryKeys` family). Adding a file scope: `FILE_SCOPES` here AND the mirrored enum in
`apps/web/src/db/schema/files.ts`. Making a NEW resource restrictable (D29): add `visibility` +
`groups: z.array(groupRefSchema)` to its schema here, a `visibility` column plus a junction table
server-side, and a `visible<Resource>(scope)` predicate registered as a `VISIBILITY_RESOURCES`
entry in `api/services/access.ts` — never infer "restricted" from the presence of grant rows.

## Rules

- Imports: `zod`, sibling files, TYPE-only imports from `@casl/ability`, and **`@ag-ui/core`
  (pinned, zod-only, no platform APIs) in `src/ai/agui.ts` alone**. NEVER import from
  `apps/web/src/api`, `apps/web/src/db`, `apps/web/src/ui` or `apps/cli` — this package bundles into the browser and the CLI.
  `@ag-ui/core` is on the list because it satisfies that reason AND because AG-UI is a wire format:
  server and UI must parse the SAME runtime schema, so a loose mirror (the `analytics.ts` precedent,
  where nothing needs to validate a `DashboardConfig`) would mean two sources of truth. A fifth
  dependency needs the same written justification here and in the root `CLAUDE.md`;
  `apps/web/tests/config/shared-imports.test.ts` is the check
- **`plugins/**` never imports one of the five composers AT RUNTIME (D31).** The five are
  `ai/agents.ts`, `jobs.ts`, `permissions.ts`, `features.ts` and `realtime.ts`; each reads the
  plugin barrel to open a closed set (agent keys, job variants, subjects, feature keys, the
  `access.changed` roots), so a plugin module importing one back closes a cycle through
  `plugins/index.ts` — and two zod modules in a cycle crash at module evaluation, not at compile
  time. **A whole-declaration `import type { X } from` is fine**: it is erased before anything
  evaluates, and it is how `SharedPlugin.features` is typed against the one `FeatureDefinition`
  rather than a restatement that drifts. **`import { type X } from` is not** — eliding every
  specifier leaves an empty import clause, and whether that survives as a bare side-effect import is
  the bundler's decision rather than ours. `apps/web/tests/config/shared-imports.test.ts` checks all
  three spellings
- `tenantRoleSchema` (assignable) on every input; `membershipRoleSchema` (+`support`) on outputs only
- Server code imports via `@launch/shared/*`; UI too. Re-export every file from `index.ts`
