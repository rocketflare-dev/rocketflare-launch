# UI (React SPA)

React 18 + Vite + React Router 6 + TanStack Query 5 + zustand; DaisyUI 5 on Tailwind v4. Dev: Vite on
:3000 proxies `/api`,`/auth`,`/ws` (+ an installed plugin's own prefixes) → :3001 (`DEV_UI_PORT` / `DEV_API_PORT` move them, `scripts/lib/dev-ports.mjs`). Prod: `dist/ui` via the `ASSETS` binding.

## Layout

- `App.tsx` — providers (ErrorBoundary → QueryClient → Auth → Ability → WebSocket → Router), the
  header `<WebSocketStatus />` dot and `<ConnectionBanner />` above the routed page, and the route
  table in three tiers: public (`/login`, `/magic-link/sent`, `/invite/:token`), signed-in-without-
  tenant (`/select-tenant`, `/pending`, `/no-access` — `ProtectedRoute requireTenant={false}`), and
  the shell (`/*` — `ProtectedRoute`, `Layout` mounted ONCE, nested `<Routes>` beneath it).
- `index.css` — the design system: themes `launch-light`/`launch-dark`, semantic tokens (`--surface-*`,
  `--border-*`, `--text-*`, `--tone-*`), primitives (`.surface-panel`, `.data-table`,
  `.status-badge`, `.nav-item`). Rebrand instructions are in its header comment.
- `components/` — shell: `Layout` (slots `headerStart`=`OrgSwitcher`, `headerEnd`=`NotificationsBell`
  + `UserMenu`, `sidebarFooter`), `SideNav` (config-driven, `guard` flags), `AuthCard` (public-page
  card; `background` swaps the starfield for a decorative, `aria-hidden` layer — the sign-in pages'
  `RocketBackground`: a canvas night sky, dark in BOTH themes, from the `--night-*` / `--rocket-*`
  colours in `index.css` `:root`, static under `prefers-reduced-motion`), `PendingInvitationsBanner`, `RoleBadge`, `EnvironmentBadge`, `ThemeToggle`, `ErrorBoundary`.
  Guards: `ProtectedRoute` (session + tenant → `noTenantRoute`; a global admin with NO tenant is
  let through to `/settings/*` and the old `/admin/*` only — `isAdminPath`), `RequireGuard` (any
  `NavGuard`, incl. `'platformAdmin'` = `canAdministerPlatform` from `@launch/shared/permissions`
  and `{ anyOf }` = OR), `Moved` (a redirect that keeps `?query#hash`; `to` may be a function of
  the old route's params — `/shared-config[/:id]` → `/secrets[/:id]`, and every old settings
  address in `SettingsRoutes`), `SettingsRoutes` (`settingsRoutes()`: the guarded `/settings/*`
  plus the redirect table from `/settings/platform/*`, `/admin/*`, `/audit`, `/activity`),
  `TenantFooter` (the sidebar's organisation + role; a global admin reads "Global admin"),
  `AdminRoute`/`GlobalAdminRoute` (sugar over it). `components/permissions/` — `AbilityProvider`
  (unpacks `session.permissions`), `Can`, `IfCan`/`IfCannot`. Realtime (D8): `WebSocketProvider`
  (connects the singleton once authenticated with a tenant, `useQueryClient()` →
  `invalidateQueries` per root from `invalidationsFor(event)`, toasts `notification.created`),
  `WebSocketStatus` (header dot), `ConnectionBanner` (after 5 s away from `open`).
  `components/shared/` — generic primitives only (Toast, Modal, SectionPanel, PaginationControls,
  FieldError…) plus the D29 visibility trio (`AccessPicker`, `AccessBadge`, `VisibilityModal`) —
  markdown-free by construction, which is what lets them sit in the eager barrel. `components/ai/` (D17) — `Markdown` (react-markdown + GFM, `skipHtml`, links
  `noopener`) and `ChatBubble`; deliberately NOT in the shared barrel so the markdown dependency
  ships only in the lazy chat chunk.
- `hooks/` — `useAuth` (session, `status`, `selectTenant`, `logout`, `applySession`,
  `useTenancyMode`), `usePermissions` (`can/cannot/isOwnerLevel/isAdminLevel/isGlobalAdmin`),
  `useNavGuard` (the ONE place nav and route guards are decided), one file per resource
  (`useMembers`, `useInvitations`, `useApiKeys`, `useNotifications`, `useTenant`, `useProfile`,
  `useAccessRequests`, `useAdminAccessRequests`, `useAdminTenants`, `useAdminUsers`,
  `useAuthMethods`) exporting `xQueryOptions()` + `useX()` + mutation hooks; `useProfile` also
  holds the avatar upload (`useUploadAvatar`, `validateAvatarFile`, `AVATAR_ACCEPT` — D23);
  `useAppInfo`, `useDebounce`, `useModalState`, `useLocalStoragePreference`;
  `useGroups` (D29: `useGroupTypes`, `useGroups(typeId?)`, `useGroup(id)`, `useMyGroups` — the only
  one a plain member may call — the type/group/member mutations, `useSetMemberGroups`,
  `useSetDocumentVisibility`, `useSetPageVisibility`; one `['groups']` family so a single
  invalidation covers it, which is also the root the server's `entity.changed` and `access.changed`
  nudges name). AI (D17/D18):
  `useAiConfig` (`useAiConfigs/useAiProviders/useAiReadiness`, `useUpsertAiConfig`,
  `useDeleteAiConfig`, `useTestAiConfig`; `providersForScope`, `configsForScope`), `usePrompts`
  (`usePrompts`, `useUpdatePrompt`, `useClearPrompt`), `useAiUsage` (`useAiUsageSummary(days)`,
  keyed on the PRESET, window derived in `queryFn`), `useChat` (`useConversations` paginated,
  `useConversation(id)`, `useCreateConversation`, `useDeleteConversation`, `useSendMessage`).
  Phase 3b (D7/D18) + issue #17: `useAgents` (`useAgentList`, `useAgentRuns` paginated + filters,
  `useAgentRun(id)` and `useAgentRunRow(id)` polling `RUN_POLL_MS` while `runOwesAnswer`,
  `useCreateAgentRun`, `useCancelAgentRun`, `useResolveInterrupt(runId)`, `useSendSteering(runId)`,
  `useAwaitingInterruptCount`, `isAgentRunsNotConfigured`, `isInterruptNotPending`,
  `runOwesAnswer`, `runPollInterval`), `useNavBadges` (the SideNav counts), `useAgentModels`
  (`useAgentModels`, `useUpsertAgentModel`, `useDeleteAgentModel`), `useDocuments` (`useDocuments`
  polling while any row is `pending`, `useDocument`, `useIngestText`, `useDeleteDocument`,
  `useSearch` — mutation-style, hits are its `data`).
  Launch P2 (create an app): `usePipeline` (`usePipeline(appId, kind, { appBusy, expectUntil })`
  keyed `[...apps.pipeline(appId), kind]`, polling `PIPELINE_POLL_MS` only while
  `pipelinePollInterval` says a run is owed — `running`, an app row `requested`/`provisioning`, or
  the grace window after this tab started a retry/teardown; a status transition refreshes the rest
  of the `apps` family once — plus `useCreateApp`, `useRetryPipeline`, `useTeardownApp` and
  `useAppsDomain`, which reads the catalogue's `appsDomain` and otherwise infers the domain from
  a created app's staging URL, else null) and `useDeploys` (`useDeploys` polling while a ticket is
  in flight — `approved`/`uploaded`, never `pending`, which waits on a person — `useDecideDeploy`,
  `useDeployProduction`; and `useDeployProgress(appId)` — the app Overview's in-flight lines and the release page's milestones, each environment's latest deploy and phase, polled every `DEPLOY_PROGRESS_POLL_MS` while `deployProgressPollInterval` says one runs and does not wait on a person (the catalogue's `useApps` polls on the same decision over `latestDeploy`), refreshing the rest of the `apps` family once when it settles; what the stepper and the catalogue line SAY is `pages/apps/components/deployProgressModel.ts`).
  Launch P3 (coding sessions): `useSessions` (`useSession(id)` / `useAppSessions(appId, scope)` /
  `useAdminSessions(scope)` polling `SESSION_POLL_MS` only while `sessionOwesAnswer` — `ready`,
  `blocked` and `suspended` wait on a person; the 202 mutations `useStartSession` (the app page's Start / Build it go through
  `useWarmStartSession`: `warm: true`, once per press — issue #17), `useSendTurn`,
  `useCancelTurn`, `useShipSession`, `useEndSession`, `useResumeSession`, `useExtendBudget` write
  the returned row into the cache; `usePreviewGrant` is a mutation — every iframe load mints a fresh
  grant, with the page the preview bridge last reported as `path`; `useSessionPr`, `useDrainSessions`/`useUndrainSessions`) and `useSessionStream(session)`:
  the ONLY writer of `['session-agui', id]`, holding the DURABLE `session_events` rows
  (`GET /events?afterSeq=`), topped up (merged, coalesced) when the read-stream
  (`lib/sessionAguiStream.ts`, a permissive cadence-only parser — it reads nothing but `id:`)
  reports a seq past the cursor, when the row changes, or on a poll after the stream gives up —
  RunPage's `useLiveRun` pattern. `pages/sessions/` is the lazy page (it carries `Markdown`); every
  panel is a selector in the pure `sessionChatModel.ts` (`buildSessionChat`, `toolSummary`,
  `bootSteps`, `latestPreviewChangeSeq`, `shipGates` (verdicts), `shipGateRunning` (the step that
  started and has no verdict yet), `openTurn` (the turn under way, a fix turn's included), and issue #5's `landingTimeline(events,
  landing, status)` — the ship's walk after the PR up to live on staging, a reopen or a stall; an
  End that abandoned the landing reads as the plain PR view —
  `tests/config/session-chat-model.test.ts`). Issue #22: the ship panel is the plain-language
  timeline of `pages/sessions/shipTimelineModel.ts` (`shipTimeline` over those selectors, worded
  by `@launch/shared/launch-ship-progress`, `tests/config/ship-timeline-model.test.ts`); while
  `shipInProgress(session)` it REPLACES the preview pane (a "Show preview" link brings the preview
  back, and it returns by itself when the ship ends); Needs you is its one loud block with one
  action, and every engineer's fact is under its one Details disclosure. The app page's lists
  print a ship in flight with `ShippingLine` (`pages/sessions/components/ShippingLine.tsx`, a
  minute tick) and the chip's word from `shippingChipText`. A landing still moving keeps the row polled at
  `SESSION_LANDING_POLL_MS`, `shipped` included (`sessionOwesAnswer`); one in `approval` waits on a
  person and is not polled. The app page's `ShipSettingsCard` reads `useBranchProtection` (never
  polled) and saves through `useUpdateShipSettings` (`useApps`). The next message's images are
  `SessionPage`'s (`pages/sessions/useComposerAttachments.ts`, handed to the composer — paste, drop,
  paperclip — and to anything else that adds one): each is shrunk by `lib/images.ts`
  (`downscaleImage`, 1568 px long edge; the policy pure) and uploaded at once through the plain
  `uploadSessionAttachment` (`useSessions`, `api.upload`); a chip is `uploading` / `ready` /
  `error`, and Send waits on the first and the last. `ChatBubble` takes a `media` slot (the
  message's thumbnails, `sessionAttachmentPath`, same-origin cookie). `PreviewFrame`'s camera
  (shown only when the last grant said `screenshots`) hands `onScreenshot` the bridge's page and
  the frame's size (`screenshotViewport`); the page turns it into a chip through `addPending` +
  `takePreviewScreenshot` (`useSessions`: the 202, then `api.head` on the image every
  `SCREENSHOT_POLL_MS` for up to `SCREENSHOT_WAIT_MS` — one bounded wait for one job, not a
  query). The picker names models with `sessionModelLabel` (null = "Default (Claude Code's
  choice)", the agent's own) and "Switched to …" with `agentModelLabel`
  (`@launch/shared/launch-agents`).
  Launch P4 (approvals and shipping): `useApprovals` (`useApprovalCount` — the nav badge, never
  polled; `useApprovals(filters)` for the inbox; `useApproval(id)` polling `APPROVAL_APPLY_POLL_MS`
  only while `approvalOwesAnswer` — approved, `applyAfter` not yet landed nor failed; a `pending`
  request waits on a PERSON; `useDecideApproval` / `useCancelApproval` with no optimistic write
  and no error toast — `isApprovalConflict` is the 409-as-information test), `useApprovalPolicies`
  (list + defaults, `usePutApprovalPolicy`, `useDeleteApprovalPolicy`), `useReleases`
  (`useReleases(appId)` polling while `releaseInFlight` — `tagged`/`staging`/`promoting`;
  `useReleaseChain` read only when opened; `useCreateRelease`, `usePromoteRelease`,
  `releaseOfApproval`), `useAudit`'s `useAuditVerify` (on demand) / `auditExportUrl`, and in
  `useSessions` `useExtendBudget` (answers `{ session, approvalId? }`) + `usePendingBudgetApproval`.
  All sit under the `approval` / `release` roots the server nudges.
  Launch P6 6c (kit upgrades): `useUpgrades` (`useAppUpgrades(appId)` — the history, never polled;
  `useStartUpgrade(appId)` — the 202 answers the session, which the caller opens), keyed
  `queryKeys.apps.upgrades` under the `apps` root the server's `entity.changed { entity: 'apps' }`
  names whenever an upgrade moves. The Overview's Kit section is `pages/apps/app/UpgradeCard.tsx`
  (shown only while `kit.behind` or an upgrade is open; Upgrade for `viewerCanDeploy` +
  `useCanStartSession`); the catalogue and Settings print `requiresUpgradeLabel` in plain text.
  An installed PLUGIN's hooks live in its own tree (`src/plugins/<id>/ui/hooks/`) and read its own
  query keys directly rather than the merged `queryKeys` — a plugin must work the same whether it is
  the only one installed or the fifth. The analytics plugin's are `useAnalyticsPages`, `useCubeMeta`
  and `useDashboardDateFilter` (D19, D31).
- `lib/` — `api-client` (fetch wrapper, `ApiError`, `setUnauthorizedHandler`, `api.upload` for
  multipart — no JSON content-type), `queryClient` (module-level, 401 → handler), `query-keys`
  (factory + `cleanFilters`/`toSearchParams`; the family roots — `['invitations']`,
  `['pending-invitations']`, `['members']`, `['tenant']`… — are what `REALTIME_INVALIDATIONS` in
  `@launch/shared/realtime` names; `agentRuns.all` is `['agent-run']` because that is the `entity`
  the server's `entity.changed` nudge carries — see "Agents" below), `websocketClient`
  (singleton: `/ws?tenantId=`, jittered backoff 1 s → 30 s, 100 ms fast path on close 1001/1012
  or an "upgraded" reason, 30 s ping;
  `setFactory()` is the test seam), `navigation` (`NavigationBridge`, `navigateTo`, `hardNavigate`,
  `loginUrl`, `safeReturnUrl`), `format` (date-fns helpers), `environment`, `sse`
  (`readSse(response, parse, onEvent, { signal })` — a frame splitter that survives split chunks
  and validates each `data` with the parser the CALLER passes, so this module imports no schema and
  the shell never carries one; `SseFrameBuffer`, `parseSseFrame`), `aguiStream`
  (`runChatTurn({ conversationId, content, onEvent, signal })` POSTs and streams **AG-UI**, parsing
  with `kitAguiEventSchema`; a pre-stream 503 `ai_not_configured` throws `AiNotConfiguredError`;
  `isAiNotConfigured()`),
  An installed plugin may need an alias in `vite.config.ts` pointing at a file in ITS tree (the
  analytics plugin's `@nivo/heatmap` stub) — one of the core lines its install prints, since a
  plugin edits no core file (D31).
- `stores/websocketStore.ts` — the one zustand store: `status | connectedAt | disconnectedAt |
  attempt | lastEvent`; written only by `websocketClient`, read by the status dot and the banner.
- `pages/` — route-level components, lazy in `App.tsx` except Login/NotFound. `Home.tsx` is the
  overview (below, "Home"), lazy since it reuses the app page's and the inbox's models. `Login.tsx`:
  `GET /auth/methods` drives the buttons; `?as=<email>` (what `pnpm bootstrap` opens) calls
  `POST /auth/dev-login` once on mount, ONLY when `methods.devLogin` is true AND the email is in
  `DEV_ACCOUNTS` (the allow-list; an arbitrary address does nothing). With `methods.oidcOnly` it
  hard-navigates to `/auth/oidc?returnUrl=` once, EXCEPT on `?signedOut=1`, `?error=` or `?as=`
  (each would loop through the issuer) — then it shows the one SSO button; other methods are
  hidden, not disabled. `useAuth().logout` follows a `200 { endSessionUrl }` with `hardNavigate`,
  else lands on `/login?signedOut=1`. `settings/SettingsLayout.tsx`
  is EVERY setting (`/settings/*`, see "Settings" below); `admin/` (Users, Feature flags, All
  sessions, Organisations) and `platform/` (Platform via `Connection.tsx` + `setup/` cards, Kit,
  Coding agents, the issuer keys in `Identity.tsx`, Access requests) are the pages it mounts —
  they keep their directories, no longer their own layouts; `chat/ChatPage.tsx` is
  `/chat/:conversationId?` (D17, guard `read Conversation`, lazy — its chunk carries the markdown
  renderer). `agents/` — `/agents` (`AgentsPage`, the roster + runs table) and `/agents/runs/:runId`
  (`RunPage`, its OWN lazy chunk), both `read AgentRun`; `documents/DocumentsPage.tsx` —
  `/documents` (D18, guard `read Document`, nav label "Knowledge"). An installed plugin's pages are
  NOT here — they are `src/plugins/<id>/ui/pages/`, reached through `UiPlugin.routes` as
  `lazy(() => import(...))` (the analytics plugin's `/analytics`, `/analytics/explore`,
  `/analytics/:pageId`). `public/` — static assets copied as-is.
- An installed PLUGIN's components live in its own tree too (`src/plugins/<id>/ui/components/`), and
  the same bundle rule applies as to `components/ai/`: they are never exported from the shared
  barrel, so their dependencies ship only in the plugin's lazy chunk. The plugin's `ui/index.ts` is
  the exception that proves it — that file IS in the main bundle, which is why every page in it is
  `lazy(() => import(...))` and `tests/config/plugins.test.ts` reads its source to check.
- Imports: `@/ui/...` and `@launch/shared/...`; never import from `src/api`, `src/db` or
  `src/permissions` (the ability MATRIX is server code; the UI only unpacks rules).
- Server data lives ONLY in the query cache: `useQuery` + a key from `query-keys.ts` + a
  `@launch/shared` zod `schema` on `api.get`. Mutations live in the resource hook, `invalidateQueries`
  through `queryKeys`, and toast via `showSuccessToast`/`successMessage`.
- zustand is for UI state only (toasts, connection state, tab-lifetime flags). Realtime events
  never become state: the provider invalidates query roots and the hooks re-fetch ("DB is the
  truth, WebSocket is a nudge"). A new server event type gets its roots in
  `packages/shared/src/realtime.ts`, not in a component.
- Uploads: `api.upload('/api/files?scope=…', formData, { schema: uploadResponseSchema })`; check
  type/size with `@launch/shared/files` before sending; `<img>` avatars need an `onError` fallback
  (the object is tenant-scoped, `avatarUrl` is not).
- Tokens, not raw colours: `text-muted`, `surface-panel`, `badge-warning` — never `bg-blue-50`.
  Classes built from props are safelisted with `@source inline(...)` in `index.css`; classes
  built from data are forbidden. Heroicons only (provider marks in `components/icons` are
  `currentColor`); `<details>/<summary>` dropdowns; `<dialog>` `Modal` (column layout, `max-h-[85vh]`: the BODY
  scrolls, title and actions stay — never let a modal grow past the viewport).
- Forms: controlled inputs + the same `@launch/shared` schema the server validates with; `FieldError`.
  Every list renders `PaginationControls` (it hides itself at one page).
- Tests in `tests/ui/` (jsdom + Testing Library, `fetch` via `stubFetch()` route tables, no MSW);
  wrap with `renderWithProviders(ui, { session })` — `makeSession()` builds a post-parse session
  whose `permissions` come from the real matrix via `packRules(buildAbility(...))`.

## Identity flow (Phase 1)

- `useAuth` runs ONE query, `GET /auth/session`; a 401 resolves to `null` (logged out) so the
  query is never removed. Identity changes (`selectTenant`, invite accept, logout, global 401) go
  through `replaceSession()`: `setQueryData` on the session, then `resetQueries`/`removeQueries`
  on everything tenant-scoped. Never `queryClient.clear()` while observers are mounted.
- Global 401 (D20): the handler only acts when a session WAS cached, drops it, and `navigateTo`s
  `/login?returnUrl=` unless already on a public path. OAuth/dev-login/logout are full-page
  (`hardNavigate`) so the cookie round-trips cleanly.
- No active tenant → `noTenantRoute(session)`: access request → `/pending`; memberships →
  `/select-tenant`; `signupMode === 'approval'` → `/pending`; else `/no-access`. Exception: a
  global admin opens `/settings/*` (and the old `/admin/*`) with no membership (the bootstrap admin
  must be able to approve the first request and finish the Platform settings), and `/pending` /
  `/no-access` show them an "Open Settings" link. In that state `useNavGuard` allows ONLY
  `'globalAdmin'` and `'platformAdmin'` guards (every tenant page and Settings section hides),
  `OrgSwitcher` reads "No organisation", `NotificationsBell` and the Profile / Notifications
  menu links render nothing, and `WebSocketProvider` never connects (it needs a tenant id).
- Single-tenant mode (D25) hides: `OrgSwitcher`, `/select-tenant` (redirects home), org
  create/delete and the slug field, the `new_org` approve branch, and Settings → Organisations (the
  old `/admin/tenants[/:id]` lands on Settings → General). It is "Organisation" everywhere, never
  "Workspace". Read it via `useTenancyMode()`.
- Coarse guards are role flags (`'admin'` = owner/admin/support/globalAdmin, `'globalAdmin'`);
  fine gates are abilities (`{ action, subject }`, `<IfCan>`). Owner-ONLY actions (delete org,
  assign/strip owner) check `tenant.role === 'owner'` explicitly — `manage Tenant` is also held
  by support and global admins.

## AI surface (Phase 3a, D17/D18)

- **Streaming is the one exception to "server data lives only in the cache".** `useSendMessage`
  appends the user bubble optimistically (`setQueryData` on `chat.conversations.detail(id)` with a
  real `Date`; `CUSTOM kit.chat.ids` then swaps its id for the persisted one), accumulates the
  assistant reply in LOCAL state from `TEXT_MESSAGE_CONTENT` deltas — across EVERY message id the
  run opens, since each model turn gets its own — (it is not truth until `RUN_FINISHED`), captures
  `usage` from `CUSTOM kit.usage`, and on `RUN_FINISHED` writes the finished message into the cache
  (the server persisted it BEFORE that frame) then invalidates the whole `chat.conversations`
  family (list re-sorts, auto-title arrives). Stop = `AbortController.abort()`: a cancelled run
  emits NO terminal event, which is the protocol's way of saying the client went away — a normal
  end (no toast, no error bubble); a pre-stream failure takes the optimistic bubble back. A
  `RUN_ERROR` leaves the turn in `error` status until the next send. Tool calls render as ONE row each (`ToolStep { id, label, done }`): `TOOL_CALL_START` opens it with
a spinner and `TOOL_CALL_RESULT` completes it in place with a tick, matched by `toolCallId` — never
a second "Done" line, and never an index key. `toolLabel(name)` is where the wording lives.
A `CUSTOM kit.notice` renders
  as a quiet italic line above the reply (`NOTICE_TEXT` in `ChatPage` is the one place its wording
  lives) — it is information, not a failure, so it never takes the error styling.
- SSE never goes through `api-client`'s `request()` (JSON only); `lib/aguiStream.ts` does its own
  `fetch` with `credentials: 'include'` + `X-Requested-With` and reuses the exported
  `parseErrorBody` for the envelope. `EventSource` is not used (GET-only).
- `ai_not_configured` (503) — from `POST /api/chat/conversations` (`ApiError`, toast suppressed in
  the hook) or from the send (`AiNotConfiguredError`) — or readiness `chat.ready === false` →
  `ChatPage` renders the `EmptyState` with a "Configure AI" link to `/settings/ai` for
  `manage AiConfig`, "ask an administrator" otherwise.
- Settings → AI & models → Providers: the providers catalog (`GET /api/ai/config/providers`) has NO shared schema (it
  is `services/ai/providers.ts` data), so `useAiConfig.ts` carries a permissive `passthrough`
  one. `PROVIDER_PRESETS`/`presetsFor`, `DEFAULT_MODELS`, `THINKING_*` come from
  `@launch/shared/ai/config`. The label is the upsert key `(tenant, scope, label)` — read-only on
  edit (renaming would create a second row). `apiKey` is write-only: blank on edit keeps the stored
  key (`hasCredential`); switching provider on edit requires a new key. `serviceTier: ''` clears.
  "Set default" re-posts the row with `isDefault: true` and no `apiKey`.
- The AI and Prompts sections are behind `guard="admin"`, so the member (`read AiConfig` /
  `read Prompt`) read-only rendering of them is exercised component-level in tests only; a member
  has no nav path to it.
- Tests: `tests/ui/helpers/sse.ts` builds fake `text/event-stream` `Response`s (`sseResponse`,
  `streamResponse` for arbitrary chunking, `hangingSseResponse` for Stop). Bubbles remount when an
  optimistic id becomes the persisted one, so assert with `waitFor(() => getByText…)`, not `findBy`.

## Agents, agent models, knowledge base (Phase 3b, D7/D18)

- **Runs are durable rows, never client state.** `POST /api/agents/runs` answers 202 with the row
  and the page navigates to `/agents/runs/:id`; `RunPage` renders `GET /runs/:id` (row + `events` +
  `interrupts` + `artifacts`, reconciled server-side). A `deduplicated: true` 202 is a SUCCESS
  (an exclusive agent already had an active run — toast, open that run); 503
  `agent_runs_not_configured` is the modal's business (`isAgentRunsNotConfigured` → `EmptyState`
  naming `AGENT_RUN_WORKFLOW`, no toast); everything else re-toasts. The UI never sends `?strict=1`.
- **Freshness = nudge + poll.** The runs family root is `['agent-run']` (`queryKeys.agentRuns`),
  the `entity` string in the server's `entity.changed { entity: 'agent-run', id }` nudge, so the
  generic `WebSocketProvider` invalidation already covers it — no hook watches the socket or the
  store. Belt and braces: `useAgentRun` polls every `RUN_POLL_MS` (3 s) while **`runOwesAnswer`**,
  and `useAgentRuns` while any listed row does. `runPollInterval(status)` is the pure decision
  (unit-tested); don't fight `refetchInterval` with fake timers.
  **`runOwesAnswer` (`queued || running`) is NOT `isRunActive`** (issue #17): `isRunActive` includes
  `awaiting_input`, because the exclusive index and "is this agent busy?" genuinely do — but a run
  parked on a person changes only when somebody answers, and the server nudges that. Point a poll or
  a pulse at `isRunActive` and a parked run is re-fetched every three seconds, and announced by
  `RunStatusBadge`'s `aria-live`, for the length of `AGENT_INTERRUPT_TIMEOUT`. `isRunActive` drives
  exclusivity copy and "can this still be cancelled/steered"; `runOwesAnswer` drives freshness.
- **The run workspace is `pages/agents/RunPage.tsx` + `run/**`, and everything it decides is decided
  in `run/timeline/timelineModel.ts`, which is pure** (`tests/config/run-timeline.test.ts`).
  `buildTimeline(events)` → rows, `groupTimeline(rows)` → stage groups, then the selectors
  (`selectArtifacts`, `selectPendingInterrupts`, `selectWorkStats`, `defaultExpanded`,
  `windowGroups`). **Everything the right pane shows that is not `run.output` is a selector over
  those same rows — never a second fetch.** Three properties are load-bearing: `at` is the tool
  call's START (`endedAt`/`durationMs` are separate — overwriting `at` with the answer is why a
  per-call duration used to be impossible); the reducer is **idempotent under duplicated events**
  (deduplicated by `event.id`, because a stream and a fetch can both deliver the same row); and a
  step row carries `endedSeq`, because a `done` merges into the row its `running` wrote, so without
  it a settled run's trailing rows get swallowed by the last stage. Grouping: a `running` step opens,
  non-step rows attach, its `done` closes, a different key implicitly closes (an unclosed step is a
  real state, shown spinning); `__preamble__` and `__tail__` hold the loose stretches. Expansion is
  `defaultExpanded` XOR the reader's toggles, keyed by `headerId`, so a live run never reopens a
  group somebody closed. Long runs **window (40 groups from the end), never virtualise** — row
  heights vary wildly and a virtualiser needs measurement, which fights auto-scroll and collapsing.
  `useStickToBottom` fires only when the reader is at the bottom AND the last row id changed — and
  it needs a REAL scroll container to do it: from `lg` up the list is `overflow-y-auto` under a
  viewport-relative `max-h`, without which the `<ol>` grew unbounded, the panel grew with it, and
  `scrollIntoView` moved the page instead of the list. Below `lg` the bound is dropped on purpose
  (the columns stack, and a fixed-height inner scroller on a phone is worse than the page
  scrolling), and the "Jump to latest" pill is absolutely positioned over the scroller so it lands
  in the same place either way.
- **The column split is `runLayout(status, override)`, pure and beside the rest of the model** —
  timeline-major while the run is active (progress is the story, the output pane is an empty
  state), output-major once it settles, **and the reader's override wins permanently**. Same shape
  as `defaultExpanded` XOR the toggles: the default is a guess, and a run settling mid-read must
  never swap the columns under somebody. The chevron that flips it is a CHILD of the timeline panel
  riding that panel's own right edge — never absolutely positioned over the grid at a percentage,
  which ignores the gutter (`3fr/2fr` + `gap-8` puts the real border at `3/5 × (W − gap)`) and drifts
  further every time the gap widens. The minor column stays narrow but readable, never
  collapsed to a rail — a settled run's timeline is where you check HOW it got there.
- **Do not write tool-result parsers.** `documentCardsFromToolResult(name, result)` in
  `@launch/shared/ai/embeddings` is the one mapper (four callers: the chat stream, the AG-UI
  projection, a persisted message and now `run/timeline/toolResults.tsx`) — the rendering is a
  `DocumentLink` ONE-LINER there, not a card strip: in a timeline row four cards bury the stage that
  comes next. Every other tool keeps
  `<details><pre>` truncated at `TOOL_RESULT_MAX_CHARS` — a 200 KB result in the DOM is a real hang.
  An agent should not emit tool frames for its TERMINAL tool: that "call" is the answer, which the
  Output tab already renders. `text` renders via `components/ai/Markdown`, which is why
  `pages/agents/**` is a lazy chunk like `ChatPage` — Vite emits `Markdown-*.js` once, shared by
  both, and `RunPage-*.js` is its own chunk. Keep every Markdown importer under
  `pages/agents|chat/` or `components/ai/`; `components/ai/StatRows.tsx` (`Row`, `Section`,
  `formatCost`, shared with the chat inspector) lives there for the same reason.
- **The action panel is the reason the page exists** (`run/ActionRequiredPanel.tsx`,
  `run/interrupts/*`). Pinned ABOVE the timeline and unmounted the moment the run leaves
  `awaiting_input`; kind dispatch is an exhaustive `switch` over the shared union, so a fifth kind is
  a type error until it has a branch. Four rules: **409 is information** (`isInterruptNotPending` →
  `alert-info`, "Someone else answered this", refetch — no toast, no red); **expiry ticks at a rate
  `expiryState` chooses** (1 s / 60 s / `null` past a day — a naive countdown on a seven-day park is
  ~600 000 re-renders); **a non-approver sees one sentence, not disabled buttons**; and **focus lands
  on the heading, never Approve** (an autofocused destructive button plus a stray Enter is how 412
  subscribers get an email). No optimistic write — this is a decision with a side effect. Validation
  is `interruptPayloadSchema(spec)`, the same function the route applies, and the answer is
  `status: 'resolved' | 'cancelled'` — **there is no `approved` boolean anywhere**.
- **The input is ONE block above both columns, not a tab** (`run/RunInputSummary.tsx` over the pure
  `run/inputSummary.ts`): labelled values read from the agent's `inputJsonSchema` through the SAME
  `fieldsFromJsonSchema`, with a per-value "Show more" for the long one (`research-topic`'s
  question). It falls back to the JSON **whole** — never per field — both when the schema is outside
  the closed set and when the input carries a key the schema never declared, because labelling the
  rest would silently hide it. "What was it asked?" is the first question about a run you did not
  start, and two homes for one fact is the trap the rest of this feature avoids.
- **The right pane is `URLTabs` (`?tab=output|artifacts|usage`), and `run.error` is above it,
  always — a failure is not a tab.** `outputs/` mirrors `forms/`: `outputFor(agentKey) → { schema,
  Component, artifacts? }`, so **an agent is one shared input schema + one `forms/` entry + one
  `outputs/` entry** and no component branches on an agent key. Artifacts come from the table,
  ordered by their event rows, with `outputFor().artifacts?.()` as the fallback for an agent that
  declares none. Usage reports what the ROWS know — including the run's timestamps (requested, by
  whom, started, finished), which used to be four rows of chrome in the header; only DURATION
  stayed, because it is the one a person glances at — and **says in words** that model cost is not
  attributed per run in this deployment, rather than rendering a `$0.00`.
- **One field renderer, two callers.** `fields/schemaFields.ts` is pure: `fieldsFromJsonSchema`
  supports a flat object of string / number / boolean / enum and **returns `null` for `$ref`,
  `allOf`/`anyOf`/`oneOf`, nested objects and arrays — the caller then falls back to the JSON
  textarea WHOLE, never per field**, because a form that silently drops a required field is
  invisible until the run 400s. `fields/FieldInput.tsx` + `FieldSet.tsx` serve both the `form`
  interrupt kind and `formFor`'s middle rung, `schemaForm(agent.inputJsonSchema)`.
  `submittableValues` drops empty optionals: `formValuesSchemaFor` is `.strict()`.
- **Live run progress (issue #7) is ADDITIVE.** `lib/runAguiStream.ts` (`streamRunAgui` — GET
  `/api/agents/runs/:id/agui/stream`, `{ lastSeq, received, terminal, aborted }`; **reconnect lives
  in the hook, not the transport**) and `hooks/useRunStream.ts` (`useRunStream(runId, { enabled })`
  → `{ events, isLoading, connected, fallback, lastSeq, terminal }`, plus `streamEnabled(status)` —
  false for `awaiting_input`, which the server answers and closes at once). The run page is built
  against the poll path, so deleting the hook must leave a working page. **The cache rule, flatly:
  the stream is the ONLY writer of `['agent-run-agui', id]`, appends with `setQueryData`, never
  touches the run row, and invalidates `queryKeys.agentRuns.all` exactly once on a terminal
  frame** — a terminal status is never synthesised client-side. The cursor moves only on a frame
  that carries an `id:` (the last of a row's group), so a mid-group drop replays the group whole.
  After `RUN_STREAM_FALLBACK_ATTEMPTS` connections that delivered nothing it stops and gives the
  key a `RUN_POLL_MS` `refetchInterval` — today's behaviour against a different URL.
  **`['agent-run-agui']` must stay out of `REALTIME_INVALIDATIONS`**: the runtime nudges
  `entity: 'agent-run'` on every row it writes, so parking the accumulated list under that root
  would make each nudge discard what the stream just built — a more expensive poll.
- **Forms come from `pages/agents/forms/`**: `formFor(agentKey)` → `{ initial, schema, Component }`.
  `summarize-text` ships its own (textarea counted against `SUMMARIZE_TEXT_MAX_CHARS`, style,
  "index the result" toggle), parsed with the SAME `summarizeTextInputSchema` the route applies
  (trimmed, defaults filled); `research-topic` ships a single question textarea counted against
  `RESEARCH_TOPIC_MAX_CHARS`. **`formFor` is three rungs**: a registered form → `schemaForm` built
  from the agent's own `inputJsonSchema` → `jsonForm` (a JSON textarea; the server's 400 `details`
  issues map back onto the fields through the one `pages/agents/issues.ts`).
- **Leaving the page never touches the run**; Cancel is the explicit button (`POST …/cancel`, shown
  while `isRunActive`). Once `cancelRequestedAt` is set it stays ENABLED as "Force cancel" — the
  second press makes the server terminate the Workflow instance and settle the row, so a run that
  stopped polling never strands the user (and never blocks an exclusive agent). `SteerComposer`
  posts `POST …/steering` while the run is active; the note is an event row, so the timeline shows
  it where it happened and the runtime delivers it once. Requested-by is "You" / short id / "system"
  — the row carries only a user id (resolving names is on the to-document list).
- **Finding what is waiting** (issue #17): the runs table's filters live in `useSearchParams`, so
  `/agents?awaiting=1` is a URL and there is a chip for it, and every row is a real `<Link>` (so
  middle-click and open-in-new-tab work — half the point of a run being a page). The SideNav badge is
  `NavItem.badgeKey`/`badgeTone` resolved by `useNavBadges()` inside `SideNav`: **`navigationConfig`
  stays plain data consumed by the pure, tested `filterNavConfig` — do not make it a hook.** It is
  fed by `GET /interrupts?status=pending&pageSize=1` under `['agent-run','awaiting']` (both server
  nudges cover it), **never polled**, and **renders a DOT on the icon when the nav is collapsed** —
  without that the feature is invisible to everyone who collapsed the sidebar.
  `lib/notificationLink.ts` maps a notification's `type` + `data` to a path (unknown → `null`) and
  is used by BOTH `NotificationsBell` and `/notifications`, so a parked run's bell entry opens the
  run rather than a list of notifications about it.
- **Settings → AI & models → Agent models** (`pages/settings/AgentModels.tsx`, `/settings/ai/agent-models`, `manage
  AiConfig`): `GET /api/ai/agent-models` is the whole truth (every prompt key, its assignment, and
  the effective provider/model/source the server's planner computed — the page never re-derives
  it). Override modal = pick a chat `ai_configs` row (`configsForScope(configs, 'chat')`; blank =
  keep the default config) and/or type a model; validated with `upsertAgentModelRequestSchema` (at
  least one) and `PUT` sends ONLY the set fields (the PUT replaces the row, so a blank model
  clears it). "Use default" is `DELETE` — absence is the default. Source badges: `agent`
  (assignment), `tenant`, `platform`, `none` (→ EmptyState linking `/settings/ai`).
- **Knowledge (`/documents`)**: the paginated documents table first, then `URLTabs` (`?tab=text|file`) to add. Paste text posts
  `ingestTextRequestSchema` output (blank source omitted; the server defaults it to `upload`);
  Upload file checks the pick with `validateDocumentUpload` (the shared allowlist
  `DOCUMENT_UPLOAD_ACCEPT` + `MAX_UPLOAD_BYTES`) before any request, then `useUploadDocument()`
  posts multipart `file` (+ optional `title`/`source`) to `/api/ai/documents/upload`. Both toast
  `indexed (n chunks)` / `queued for …` and invalidate `documents`; the list polls every 5 s while a
  row is `pending` (there is no document nudge yet). Rows show `documentTypeLabel(contentType)`
  under the title and a download link (`filePath(fileId)`) when there is an uploaded original; every
  title is a `<Link to={documentPath(doc.id)}>`, pending and failed rows included.
- **The viewer (`/documents/:documentId`, guard `read Document`, no SideNav entry)**:
  `pages/documents/DocumentViewPage.tsx`, lazy, tabs `?tab=document|details`. It dispatches on
  `fileId`, the upload kind and the status: a PDF embeds its original with `<object>` — **never try
  to detect failure, the CHILDREN are the fallback** — while the header always carries Download
  original and a Converted text toggle; everything else renders its text (markdown through
  `components/ai/Markdown`, plain types in a `<pre>`). Deep links: `?offset=` is snapped by
  `windowStart()` so a link and the reader's paging share one cache entry, `?chunk=` is the fallback
  when `charOffset` is null, `?q=` highlights through `lib/highlight.ts` as `<mark>` NODES
  (never `dangerouslySetInnerHTML` over uploaded text). Markdown still renders AS markdown; the
  Plain toggle is where highlighting and the passage anchor live, because `<mark>` cannot be
  threaded through react-markdown's AST. Hooks: `useDocumentContent(id, offset)`,
  `useDocumentPassages(id, filters)`, `useDocumentCard(id)`, all under the `['documents']` root so
  one invalidation still covers the family; `documentPollInterval(status)` is the pure decision.
- **`DocumentCard`** (`components/shared/DocumentCard.tsx`) is the compact citation form and is
  **markdown-free by construction** — that is what lets it sit in the eager barrel and be used from
  Search and from inside `Markdown` itself (an anchor whose href matches `/documents/<uuid>` renders
  as a card). Its `excerpt` is the head of the text, not a summary, and there is no thumbnail.
  **`DocumentLink` beside it is the same document on ONE LINE** (icon, title, passage count) for
  dense lists — the run timeline's tool results and `research-topic`'s Sources both use it, through
  `documentLinkProps(card)` where they hold a card, so the two cannot drift. Same markdown-free
  rule, same barrel. A card is right where the document IS the content; a link is right where it is
  a reference inside something else.
- **Search (`/search`, nav "Search", guard `read Document`)**: its own page (`pages/documents/SearchPage.tsx`). The Knowledge header states that everything indexed is also available to agents (`search_knowledge` / `get_document`, `services/agents/tools/`). Delete shows only for own rows unless `delete Document` (admin+) — the route
  enforces. Search is `useSearch()` (mutation): `{ query, limit: 10, documentId? }` → hits with
  `rank`, `passage n of m` (where the passage sits in its document), RRF `score`, `dense #n` /
  `lexical #n` badges and the snippet, GROUPED under a `DocumentCard` header built client-side with
  `documentCardFromDocument` from the `useDocuments({ pageSize: 100 })` list the page ALREADY fetches
  for its filter select — no request per hit. A hit's "passage n of m" is a `<Link>` to
  `documentPath(documentId, { offset: charOffset, chunk: chunkId, q })`; restricting the search to
  one document survives as a separate funnel button on the card, so "read it" and "search only it"
  are no longer the same click. `?documentId=` preselects the per-document filter; `?q=` prefills the box and runs the search on mount (once — a `lastRun`
  ref stops StrictMode and the URL write from repeating it), and every submitted search sets `?q=`
  with `replace`; an empty knowledge base shows an EmptyState linking to `/documents`.
- Tests: `agents-page`, `run-page` (mounts `RunPage` on the real `/agents/runs/:runId` route, inside
  `WebSocketProvider` with the `FakeSocket` from `websocket-provider.test.tsx`, to prove the nudge
  refetches AND leaves `['agent-run-agui']` alone), `run-stream`, `sidenav` (the badge and its
  collapsed dot), `agent-models-settings`, `documents-page`, `search-page`, `document-view`,
  `document-card`. The pure halves live in the `config` project:
  `tests/config/run-timeline.test.ts` (the reducer, grouping, `runLayout`, `summariseInput`,
  `expiryState`, `fieldsFromJsonSchema`)
  and `tests/config/document-helpers.test.ts`. Mount `AgentsPage` inside the same `<Routes>` pair
  App.tsx uses so `navigate('/agents/runs/:id')` really lands on `RunPage`.

## Approvals and releases (Launch P4)

- **`/approvals` and `/approvals/:id` are pages** (`pages/approvals/`, lazy). The inbox's boxes are
  `URLTabs` with `param="box"` (All only for `isAdminLevel`), filters are `?kind=` / `?status=`.
  **Everything the surfaces SAY is `approvalModel.ts`** — `approvalSummary` (an exhaustive switch
  over the context union), `requesterName`, `whyNotSentence` / `waitingOn` (who a pending request
  waits on, by name, from the server's `eligible`), `approversSentence`, `progressLabel` — pure and
  tested in `tests/config/approval-model.test.ts`, so a row, a heading and a panel can
  never describe one request three ways.
- **`ApprovalPanel` follows `ActionRequiredPanel`'s rules**: heading focus, one sentence for
  somebody who may not decide (a 403 `self_approval` / `not_an_approver` at decide time becomes the
  same sentence), 409 → `alert-info` + a refetch, no toast, no optimistic write, and the expiry
  through `useExpiry` → `expiryState` (a second / a minute / no timer). Settled → `ApprovalOutcome`
  (including approved-but-applying and `applyError`). `ApprovalContext` renders the per-kind
  context; a deploy of a release adds `pages/apps/components/ReleaseChain` (windowed, never
  virtualised). Group names come from `useGroupNames` — every group for `manage Group`, otherwise
  the reader's own, and the rest are COUNTED in words rather than fetched.
- **Settings → Approval policies** (`settings/ApprovalPolicies.tsx` + `ApprovalPolicyModal.tsx`): the
  organisation row or the SERVER-reported default per kind, then team/app overrides; the modal
  validates with `putApprovalPolicySchema` and refuses a policy with no approver and no
  auto-approve. Issue #22: each kind's organisation row has an explicit Approval: Required / Not
  required choice (`approvalRequirement`, `requirementSentence`) — for `session.merge` Not
  required is no row (each app's Ship settings decide), for every other kind it is
  `autoApproveRole: 'member'`; loosening is confirmed first. `autoApproveLabel` says "Always (every
  request is approved at once)" for `member`, never "When a member asks"; `APPROVAL_POLICIES_PATH`
  is the one spelling of a link to the page (the Ship settings card's notice uses it).
- **The app page** (`pages/apps/AppPage.tsx` + `pages/apps/app/`, `docs/DESIGN.md` first): an
  Overview and tabs as nested routes under `AppLayout` (`/apps/:slug/*` — Overview, `sessions`,
  `releases` + `releases/:version`, `activity`, `settings/:section?`; the old `config` and
  `access` redirect into Settings with `Moved`; `/apps/:slug/sessions/:id` is ranked above the
  splat in `App.tsx` and keeps its own chunk). `AppLayout` owns the create/teardown
  `usePipeline` queries and hands the tabs `useAppPage()` (Outlet context); until the first build
  is live the Overview is the takeover and Sessions / Releases are disabled with the reason.
  Everything the page SAYS is the pure `app/appPageModel.ts` (`appStage`, `stagingInFlight` /
  `liveInFlight` — the ONE line under an environment row, `needsYou`, `releaseRows` /
  `releaseCell`, the ticket badges; `tests/config/app-page-model.test.ts`) over
  `promotionModel.ts` (`promotionState` over `useAppPromotion`, `['release','promotion',appId]`,
  polled only while the candidate deploys; `progress: 'moving' | 'failed'` sorts a candidate into
  the Staging row's line or Needs you). Ship (`ShipDialog`) stays on the Overview — the Live row
  then names who the request waits on — and a Releases row's `ShipButton` goes to the approval it
  opened; a 409 is shown in the dialog. `releaseModel.ts` keeps the lifecycle badges,
  `nextVersion` and `chainEntry`. A pending production ticket with an `approvalId` is a Needs-you
  link to the request; one without is still decided in place (heading focus, 409 as information).
  A `requested` app asks `usePendingApproval({ kind: 'app.create', appId, box })` (`all` for
  admins, else `requested`): while one is pending the Overview shows it instead of the launch
  panel and the pipeline is not polled — it waits on a person. `CreateAppModal` words the toast
  by the 202's `approvalId`.
- **Session budget**: `budgetAccess(session, canExtend, pendingId)` decides once whether the reader
  extends (owners/admins — their click also approves), asks (the creator), or reads; header and
  banner take the same object.
- **Settings → Audit is the one log** (`pages/Audit.tsx` at `/settings/audit`, the Activity group;
  the kit's Activity page and its `useActivity` hook are gone, and `/audit` and `/activity` are
  `Moved` to it). Kit activity
  events arrive there with their type as the action (`member.role_changed`), so the action filter's
  prefixes are `member`, `invitation`, `api_key`, `group`, `tenant` as well as `oidc`, `app` ….
  What a row SAYS is the pure `pages/auditModel.ts` (`auditSummaryText` — `key: before → after`
  when both halves carry a key, ids shortened, lists joined; `auditActionLabel` for the code's
  `title`; `tests/config/audit-model.test.ts`).
- Tests: `approvals-inbox`, `approval-policies`, `release-chain`, `app-overview`, `audit-integrity`, the P4 cases
  in `session-page` and `apps-create`; fixtures in `tests/ui/helpers/approvals.ts`.

## Settings

- **One nav item, one layout.** The nav is Home, Apps, Secrets, Approvals (+ the analytics
  plugin's Analytics) and Settings, whose guard is `SETTINGS_GUARD` = `{ anyOf: ['admin',
  'platformAdmin'] }` — in multi mode an organisation owner is not a platform admin and a global
  admin with no membership is not an organisation admin, and both have sections to open. It sits in
  a core group labelled "Settings" (the plugins' `DEFAULT_NAV_ANCHOR`); `showsGroupLabel` hides a
  heading that only repeats its one item.
- **`pages/settings/SettingsLayout.tsx`** renders "Settings" (the page's `h1`), a grouped menu and
  the active section beneath its own `<Routes>`. What exists and who sees it is the pure
  `settingsModel.ts` (`settingsGroups({ single, pluginTabs })` → `visibleSettingsGroups(groups,
  canAccess)` → `firstSettingsPath`; `tests/config/settings-model.test.ts`); every path is in
  `lib/settings-paths.ts` (eager-safe — links import it, never a lazy page):
  - **Organisation** — General (`admin`), People (`{ anyOf }` of its three tabs: Members `admin`,
    Groups `admin` + `manage Group`, Access requests `platformAdmin`, with the pending count),
    Approval policies (`admin` + `manage ApprovalPolicy`), API keys (`admin`)
  - **Building apps** — Coding agents (`platformAdmin`), AI & models (`admin`; tabs Providers and
    Agent models, `+ manage AiConfig`), Prompts (`admin`), Kit version (`platformAdmin`)
  - **Platform** (`platformAdmin`) — Domain, Cloudflare, Neon, GitHub, Email, Sign-in, Public URL:
    one `platform/Connection.tsx` told its `step`, reusing the `setup/` cards; Sign-in is the
    upstream `IdentityCard` plus `Identity.tsx`'s issuer keys. The menu shows each one's `StatusDot`
    from `useSetupOverview` (fetched only for a platform admin)
  - **Activity** — Audit (`admin`), Usage (`admin` + `manage AiConfig`)
  - **Operator** (`globalAdmin`) — Users, Feature flags, All sessions, and Organisations in multi
    mode only (its API is multi-only; the list now says when a load FAILED rather than reading an
    error as "No organisations match")
  - **Plugins** — each `UiPlugin.settingsTabs` tab, `admin`
  Each section's route is wrapped in `RequireGuard` with its own guard (redirecting to `/settings`,
  which lands on the reader's first section); a group the guards empty is not rendered. Sections
  that are pages of their own (Audit, a user, an organisation) title themselves with
  `SectionHeader` (an `h2`), never a second `PageHeader`. Below `lg` the menu is one `<select>` of
  the same groups; from `lg` it is a `nav aria-label="Settings"` of `ul`s labelled by their group,
  the active section (longest path prefix) `aria-current="page"`.
- **Old addresses are forever** (`components/SettingsRoutes.tsx`): `/settings?tab=<id>` (resolved
  by `legacyTabPath`, plugin tab ids included), `/settings/platform/*`, the wizard's
  `#setup-<step>` anchors (`legacySetupPath`), `/admin/*`, `/audit` and `/activity` all `Moved`
  to their section, query and hash kept (`tests/ui/settings-layout.test.tsx` walks every one).

## Home

- **Coding-agent accounts are onboarding, so they are on Home** (§18.22,
  `home/CodingAgentsSection.tsx` over the pure `agent-accounts/agentAccountsModel.ts`
  `agentOnboarding`): nothing usable connected → "Connect your coding agent" first on the page, one
  row per account the policy allows with its Connect button; one connected → one quiet line, still
  first; no runtime allows personal accounts → nothing. The sign-in modal and the per-runtime
  bodies are `agent-accounts/useAgentConnect.tsx` and `agent-accounts/logins/`. Profile no longer
  carries them.
- **`/` is an overview built from small section components** (`pages/home/`), each behind the same
  guard as the page it summarises, so a richer widget is one more section. The page spans the
  whole main area (no max-width). Each section is `HomeSection` — an `h2` (`text-xl`), a muted
  tabular count and its actions on the right — over content that brings its OWN surface, so there
  is one level only: `ApprovalsWaitingSection` (`useApprovals({ box: 'mine', limit: 5 })` — the
  inbox's "Waiting on me", the set the nav badge counts — "Waiting on you" + count, rows worded by
  `approvalSummary` / `requesterName` on one `surface-panel`; none waiting is ONE compact panel,
  "Nothing waiting on you." + "All approvals →", no heading) and `AppsSection` (`useApps()` only —
  never a request per app; a grid of large cards, 1 → `sm` 2 → `lg` 3 → `2xl` 4 columns, each card
  a `surface-panel` that is ONE `<Link>` to `appPath`, named by the app (`aria-labelledby`, the rest
  is its `aria-describedby`): `AppThumbnail size="fill"` (`pages/apps/components/AppThumbnail.tsx`,
  also the catalogue's and the app header's — the screenshot or the app's initial at 16:10; `fill`
  is the container's width, a large initial, only a bottom edge, and a slight scale on the card's
  hover/focus), the name, one attention word in its state colour, then Live's `HealthDot` +
  version and Staging's version in a small `dl`; capped at 8 (two rows of four) with
  "All N apps →"; "New app" opens `CreateAppModal` for `manage App`, as a plain button — Home has no
  hero). No panel wraps the cards — they are the surface. What a card SAYS is the pure
  `home/homeModel.ts` (`appAttention`, `runningVersion`,
  `homeAppRows`; `tests/config/home-model.test.ts`) over `appPageModel`'s `ENV_LABEL` /
  `notDeployedYet` and `promotionModel`'s `v`. The version is what the environment's health probe
  last reported (`healthVersion`) — the catalogue row carries no `lastDeployVersion` and no
  releases, so a release that failed before any deploy shows on the app page, not here.
  `UiPlugin.homeLinks` render last as one line of links. Tests: `home`, `app-thumbnails`.
- **"Finish setting up Launch"** (`home/SetupChecklistSection.tsx`, `platformAdmin`) leads the page
  while any connection is not ready, as one compact panel: the heading, a 7-segment bar in the
  Platform menu's order (state colours, `aria-hidden`; "n of 7 ready" is spelled out beside it),
  then a row ONLY for each connection not ready — dot, name, what is wrong in its worst probe's
  words, one "Fix" link to its Settings page — from `setupChecklist(steps, connectionChecks(…))` in
  `homeModel.ts`. Only `ok` is ready: a choice or an untestable fact is `ok` with a note, so a
  `warning` is always something to do. Renders nothing while loading, on an error, or once all
  seven are ready. It replaced the setup wizard page.

## Shared config and grants (Launch P5) — "Secrets" in the UI

- **The UI says "Secrets"** (nav, pages, the `grant.request` kind label "Secret access") at
  `/secrets` and `/secrets/:id` (`SECRETS_PATH` / `sharedResourcePath` in
  `@launch/shared/launch-grants`; SideNav spells the literal so the eager shell does not load that
  module). `/shared-config[/:id]` redirect through `Moved`. The code, the API, CASL
  (`SharedResource`) and the `pages/shared-config/` directory keep the old name.
- **Values are write-only in the UI too.** `ValuesModal` never pre-fills an input: a key the active
  version carries reads "Set — hidden" with Replace, secrets are `type=password`, a blank keeps the
  current value (the server merges), and the modal unmounts on close so nothing typed survives.
  Var values render only from the detail's `vars`, which the server sends to owners and admins.
- **`holders` present = the reader is the owner team or an admin** — the page's one signal for the
  holders table, the var values and the push history (`useGrantPushes` is not even called for a
  member: the route 404s them).
- Everything the pages SAY is `shared-config/sharedConfigModel.ts` (`valueLine`, `missingKeys`,
  `pushProgress`, `holderBehind`, the badge maps) and `apps/components/configModel.ts`
  (`envGrantState` — held / pushing / push_failed / requested / revoking / missing —
  `missingEnvironments`, `declaredByPlugin`); `MatchList` / `ScanLine` / `RescanButton`
  (`components/ConfigMatches.tsx`) build the app page's Settings → Config & secrets
  (`app/ConfigSection.tsx`), and the Overview's Needs you reads the same model for what is
  missing. `RequestGrantModal` pre-selects only the
  missing environments and renders refusals as sentences.
- Hooks: `useSharedResources` (`useSharedResource`, create/patch/values, `useGrantPushes`,
  `useGrantPush`, `useRetryGrantPush`; `grantPushPollInterval` polls only while `queued`/`running`)
  and `useAppConfig` (request, `useRevokeGrant()` — the app id travels with the call — re-push,
  re-scan; `appConfigPollInterval` polls only while a push is landing on a grant, never while one
  is `requested`, which waits on a person). Roots `shared_resource`, `grant_push`, `app_config`.
- A `grant.request` is decided by the resource's owner team (`eligibleExtra`), which no policy list
  names: `extraApprovers(kind, ownerTeam)` in `approvalModel.ts` leads `approversSentence` /
  `policySentence` / the `waitingOn` fallback, and `ApprovalPage` reads the team's name from the
  resource. Tests: `shared-config`, `app-config`, the grant case in `approvals-inbox`.

## Feature flags (D30)

- `lib/feature-guards.ts` is the client-side spelling: one `NavGuard` const per feature plus
  `featureGuard(feature, guard)` to compose the flag with a permission. Launch's own is `kit-ai`
  (`CHAT_GUARD`, `AGENTS_GUARD`, `KNOWLEDGE_GUARD`): Chat, Agents (and its badge's count query),
  Knowledge and Search — nav item AND route — are hidden until a deployment lists the key in
  `FEATURES_ENABLED` (`tests/ui/kit-ai-flag.test.tsx`). `useNavGuard` gains a
  `{ feature }` form (answered from `session.features`, checked BEFORE the tenant check — a feature
  that is off is off for everyone) and a LIST form meaning AND. `useFeature('x')` is the hook.
- **Never gate on `{ action: 'access', subject: 'Feature:x' }`.** A global admin's `manage all`
  satisfies it, so they would see a nav item whose routes the server 404s — and the app this rule
  came from shipped exactly that. The flag is configuration; only `session.features` answers it.
- Settings → Feature flags (`/settings/feature-flags`, `pages/admin/FeatureFlags.tsx` +
  `FlagOverrides.tsx`, the `globalAdmin` guard of the whole Operator group) separates the two layers visually:
  `availableInEnvironment` is config a redeploy moves, everything else is a click. Overrides offer
  three states — On / Off / Default — because deleting the row (follow the platform state) is a real
  third answer a checkbox cannot express; the section is absent in single mode, matching the routes.
- A plugin's nav items and pages arrive through `UiPlugin.routes` / `UiPlugin.nav` and live in
  `src/plugins/<id>/ui/`, not in the shell. Remove a plugin with `pnpm plugin remove <id>` rather
  than editing the shell.

## Groups and visibility (D29)

- **Settings → People → Groups** (`pages/settings/Groups.tsx`, `/settings/people/groups`, `manage Group`): group TYPES on
  the left, that type's groups on the right, `GroupMembersModal` for who is in one. The tab does not
  render at all without the ability — a picker or a table you cannot save from is worse than no tab,
  which is the same rule `agent-models` follows.
- **Deleting quotes the 409.** `DELETE /api/groups/:id` answers `group_in_use` with
  `{ documents, dashboards }` while the group still controls access; the confirm dialog shows the
  counts, says the affected content narrows to its owner and administrators (never opens), and only
  then offers "Delete anyway" (`?force=1`).
- **`AccessPicker` is the ONE wording of "who can see this"** — a radio for the organisation or a
  set of groups, chips grouped by type, and a warning (never a block) when the selection is empty,
  because "only me and admins" is a real answer and the state a deleted group leaves behind.
  `useShareableGroups()` in `DocumentsPage` is the rule it is fed: every group for `manage Group`,
  `useMyGroups()` otherwise — exactly what `resolveRequestedVisibility` accepts, so the picker can
  never offer what the save would refuse. `VisibilityModal` wraps it for a list row / a header;
  `AccessBadge` is the read-only lock + names.
- **Where they appear**: both Knowledge add forms, a Visibility action per Knowledge row (owner or
  `manage Document`), the dashboard header's ⋯ menu (`manage Dashboard`), badges on the Knowledge
  rows and the dashboard cards, a Groups column + Edit groups on Settings → People, and a read-only
  "Your groups" on the profile (hidden when you are in none).
- **Freshness is the generic nudge again**: the family root is `['groups']`, which the server's
  `entity.changed { entity: 'groups' }` names, and `access.changed` (sent to the affected people
  only) invalidates `['auth'] ['documents'] ['groups']` plus every installed plugin's
  `realtimeRoots` (the analytics plugin's `['analytics:dashboards']`) — so somebody who loses a
  group watches the content disappear instead of clicking into a 404. No hook here touches the
  socket.
- Tests: `tests/ui/groups.test.tsx` (the tab's list/create flows, the 409 confirm, and the
  `AccessPicker` empty-selection warning).

## Plugins (D31)

- **An installed plugin contributes UI through `UiPlugin`** (`apps/web/src/plugins/types.ts`), one
  line in `src/plugins/ui.ts`, and its own entry `src/plugins/<id>/ui/index.ts`. `App.tsx` maps
  `UI_PLUGINS.flatMap(p => p.routes)` per tier (`shell | noTenant | public`) inside the existing
  `Suspense`; `SideNav`'s `navigationConfig` is `composeNav(CORE_NAVIGATION, …)` (an UNLABELLED
  plugin group landing right after an unlabelled group is merged into it, so the analytics item
  sits in the first group; `filterNavConfig` drops a group its guards empty);
  `SettingsLayout` lists `settingsTabs(ctx)` under its "Plugins" group at
  `/settings/plugins/<tab id>`; `queryKeys` is `CORE_QUERY_KEYS` spread with every
  plugin's families; `pages/agents/forms/index.ts` is `CORE_AGENT_FORMS` plus every plugin's.
  **Nothing in the shell names a plugin** — that is what makes install and remove a handful of
  barrel lines, and reversible by deleting a directory.
- **The UI entry ships in the MAIN bundle**, because the shell imports the barrel that imports it.
  So it wires and nothing else: pages are `lazy(() => import(...))`, and its runtime imports are
  limited to `react`, `@heroicons/react/24/outline`, `@launch/shared/*`, `@/plugins/types`,
  `@/plugins/api/ui-wiring` (the WIRING half of the UI kit — its COMPONENTS half,
  `@/plugins/api/ui`, is for a lazy PAGE and is deliberately absent from this list),
  `@/ui/components/SideNav`, `@/ui/hooks/useNavGuard` and `@/ui/lib/feature-guards` (type-only
  imports are free — they are erased). `tests/config/plugins.test.ts` reads the SOURCE and enforces
  both rules; a statically imported page is the mistake it exists to catch, and it is exactly the
  same rule the `components/ai` / analytics chunk isolation already follows.
- Query-key roots are `<id>:…`, and **the root is the same string the server's `entity.changed`
  nudge carries**, declared once (the plugin's `shared.ts`), so the socket wiring is free. A
  plugin's own hooks read its `query-keys.ts` directly; the merge into `queryKeys` is for the host.
- A route's guard and its nav item's guard are ONE const declared beside them —
  `EXAMPLE_FEATURE_GUARD` — so a link can never point at a page its reader cannot open.
