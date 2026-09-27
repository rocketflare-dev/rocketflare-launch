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
                         │  • proxies/meters model calls
                         ▼
                      Cloudflare Sandbox (container)
                         • git clone <app repo> (1-hour, single-repo token)
                         • template devBootstrap → e.g. `pnpm bootstrap --yes --no-dev && pnpm dev`
                         • exposed port :3000 → live preview URL
                         • Claude Agent SDK / Claude Code headless (streaming mode)
                           working in the checkout, on branch session/<id>
```

- **Container image**: Node 24, pnpm 10, Postgres 17 + pgvector (started in the container, so the
  template's local database needs no Docker), git, and Claude Code / the Agent SDK. The image is
  one per template and adapter version, built and versioned by Launch.
- **Why this works well with Rocketflare apps**: the agent inherits the repo's own `CLAUDE.md`,
  `.claude/rules`, per-directory `CLAUDE.md` files and `rf-*` skills. The kit was designed so an
  agent can copy it and get going; Launch sessions are exactly that case. The zero-credential dev
  mode means the sandbox needs no Cloudflare, Neon or Resend credentials to run the app.
- **Streaming**: the SDK's streaming output, including partial messages, is relayed by the
  SessionDO to the browser. Events are mapped onto AG-UI types (text, tool call start and end,
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

The sandbox exposes the dev server's port as a preview URL. Preferred: a custom hostname under
`preview.apps.example.com`, gated by the viewer's Launch session, so previews are private to the
company. Needs checking: Sandbox preview URLs on a custom domain, and how auth sits in front of
them.

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

## Known gaps

- The Sandbox SDK 1.0 (`@next`) preview or the stable package: we need to pick one at build time.
  Cloudflare recommends 1.0 for new projects.
- Cold start: time from starting a session to a ready preview (clone, install, Postgres, first
  build). This is the key feasibility metric for P3; target under 90 seconds with a warm image and
  a pnpm store cache.
- No multiplayer (two people in one session) in the first version.
