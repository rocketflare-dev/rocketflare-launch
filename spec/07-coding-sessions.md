# 7. Coding sessions

Status: spec, not built.

## Goal

Open an app in Launch, then "Start session". You get a chat with a coding agent that works on the
app's real repo, and a **live preview** of the running app beside it. When the session ends, it
leaves a pull request that goes through the app's normal CI and review. This is the Lovable loop,
built on the company's own repo, CI and approvals.

## Decision: the Claude Agent SDK on Cloudflare Sandbox

```
browser ◄─WebSocket─► SessionDO (one per session; Launch Worker)
                         │  • owns the Sandbox handle, the GitHub token refresh, budgets
                         │  • persists every event → session_events (Postgres)
                         │  • keys and meters model calls (outbound handler, in the Worker)
                         ▼
                      Cloudflare Sandbox (container, egress allowlisted)
                         • git clone <app repo> (1-hour, single-repo token)
                         • its own Neon branch, copied from the app's prepared `dev` branch
                         • template devBootstrap → install, .dev.vars, migrate, dev servers
                         • dev UI port → preview, fronted by Launch (containerFetch)
                         • Claude Code headless, one streamed turn per message (--resume)
                           working in the checkout, on branch session/<id>
```

- **Container image**: the stable Sandbox image, plus Node 24 (first on `PATH`: the base image's
  Node 22 comes first otherwise), pnpm 10, Claude Code, and a **pnpm store pre-fetched for the
  pinned kit tag** (~12 s saved per session). There is **no Postgres** in the image. The image is
  one per template and adapter version, built and versioned by Launch.
- **Database: a Neon branch per session**, copied from the app's `dev` branch, which Launch keeps
  migrated and seeded (never production data). Branching takes ~1 s; a prepared `dev` saves ~45 s
  of migrate and seed per session. The branch is deleted with the session. Neon caps branches per
  project (10 on Launch, 25 on Scale), which caps concurrent sessions per app.
- **Why this works well with Rocketflare apps**: the agent inherits the repo's own `CLAUDE.md`,
  `.claude/rules`, per-directory `CLAUDE.md` files and `rf-*` skills. The kit was designed so an
  agent can copy it and get going; Launch sessions are exactly that case. The zero-credential dev
  mode means the sandbox needs no Cloudflare or Resend credentials to run the app. Its only
  database credential is for its own throwaway branch.
- **The chat loop** ([S7](../spikes/s7-sandbox/RESULT.md)): each user message is one Claude Code turn,
  `claude -p … --resume <session> --output-format stream-json`, run with the Sandbox's streaming
  `exec`. The SessionDO relays each event to the browser as it arrives. In the spike, a second
  turn resumed the first and answered from its context.
- **Streaming**: the stream-json output, including partial messages, is relayed by the SessionDO
  to the browser. Events are mapped onto AG-UI types (text, tool call start and end,
  run finished), so the transcript renders with standard components and can be replayed from
  `session_events`.
- **Human in the loop**: the agent's permission prompts (for example, running a migration
  command) come up in the UI as approve or deny. Policy can pre-approve safe tool classes.

## Session lifecycle

1. **Start**: create a `sessions` row → SessionDO → Sandbox → clone → create branch
   `session/<id>` from `main` → bootstrap → preview ready → agent ready.
2. **Work**: the user chats and the agent edits, runs the template's tests or gate, and commits
   to the branch as it goes. The branch is pushed regularly, because it is the durable state.
3. **Idle**: the container sleeps after N minutes. Resuming restores it from the branch, or from
   a Sandbox backup if we adopt one.
4. **Finish**: the agent runs the template's gate (Rocketflare: lint, typecheck, test, build),
   pushes, and Launch opens a PR with a generated summary and a link to the transcript. The
   sandbox is destroyed.
5. **Review and ship**: continues in [08](08-approvals-audit-ship.md).

Several sessions can run against one app, each on its own branch. Conflicts are resolved in the
PR as usual.

## Live preview

The sandbox exposes the dev server's port as a preview URL,
`<port>-<sandbox>-<token>.company-launch.com`. It is served by a wildcard route on Launch's own
domain, so the zone's wildcard certificate covers it ([04](04-hostnames-and-dns.md)). Launch gates it with the viewer's Launch session, so
previews are private to the company. Needs checking (spike S7): the preview on this hostname, and
how the session check sits in front of the Sandbox's own token.

## Budgets and cost

- A token and wall-clock cap per session, a monthly cap per team, and a hard stop with a
  `session.budget` approval to extend ([08](08-approvals-audit-ship.md)).
- Model calls are metered in the SessionDO: model, tokens, cost and session are recorded, and the
  totals show per app and per team ([10](10-fleet-operations.md)).
- Container time is metered from Sandbox lifecycle events.

## Security

- Sandbox credentials are limited to [03](03-trust-and-credentials.md): a single-repo GitHub
  token and a metered model path. It has nothing else.
- Egress is allowlisted: Anthropic, GitHub, the npm registry and template-declared hosts.
- The agent cannot push to `main`: branch protection applies, and the token can only reach
  `session/*` branches if rulesets allow that level of restriction.
- The full transcript is stored and is auditable.

## Rejected and deferred

- **Claude Managed Agents** (Anthropic-hosted session loop, with a Cloudflare self-hosted sandbox
  template). Less code, but it is in beta and not eligible for Zero Data Retention or a HIPAA BAA,
  which is a blocker for many enterprise buyers. **Deferred**, not dismissed: the SessionDO
  interface is a session runner that could be backed by it later.
- **The kit's own agent runtime** (Rocketflare's `runToolLoop` on Workflows). It is a good
  pattern for business agents inside apps, but it isn't a coding agent and has no filesystem or
  shell.

## Measured (S7)

From nothing to a live, gated preview: **24 s** with a prepared `dev` branch and the warm pnpm
store, 38 s with an empty store, and 57 s when migrating and seeding a fresh branch. The first
container start after a deploy took 36 s; after that 2–4 s ([S7](../spikes/s7-sandbox/RESULT.md)).

## Known gaps

- **Deploys interrupt live sessions.** Changing the session image or config rolls out by replacing
  instances, and cut off a running command in S7. Launch has to drain or checkpoint sessions first.
- Sandboxes must be destroyed when a session fails, not only when it ends: leftovers count against
  `max_instances`, which is also the cap on concurrent sessions per class.
- Permission prompts in the UI (the Agent SDK's permission callback, or
  `--permission-prompt-tool`) and cancelling a turn: not yet spiked; S7 used `acceptEdits`.
- Vite HMR over a WebSocket through `containerFetch`: not yet tested.
- No multiplayer (two people in one session) in the first version.
