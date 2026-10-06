/**
 * The agent-runtime seam (§18.22, rocketflare-launch#13): everything a coding session needs to know
 * about the agent it runs, as one interface — so the turn runner (`turn.ts`), the boot steps
 * (`steps.ts`), the checkpoint (`checkpoint.ts`) and the login Workflow
 * (`workflows/agent-login.ts`) are written once, against `AgentRuntime`, and a runtime is one
 * directory under `runtimes/`.
 *
 * **`AgentRuntime` is "run a turn, hand me normalised output"** — it says nothing about HOW:
 *
 * | member            | what it is                                                       |
 * |-------------------|------------------------------------------------------------------|
 * | `placement`       | where the agent loop runs: in the session's container, or (#14) a Durable Object |
 * | `runTurn`         | one turn: `TurnContext` + `TurnInput` in, `RuntimeLineMapping`s into the `TurnSink`, a `RuntimeTurnOutcome` out |
 * | `cancel`          | stop a turn nobody is reading any more (the salvage's orphaned turn) |
 * | `workspaceFiles`  | files written into the checkout at clone (Claude's deny rules)    |
 * | `state`           | the conversation between turns: read for the checkpoint, put back by `transcript#K` (`RuntimeStateStore`) |
 * | `login`           | the relayed sign-in for a personal account (`LoginDriver`)        |
 * | `userLease`       | a personal account's credential for one turn (`TurnCredentialLease`) |
 *
 * Claude Code and Codex are ONE implementation of it: `processRuntime(cli)` (`process/`), the CLI
 * process in the container — start it, read its stdout, watch it, kill it — driven by a
 * `CliAdapter` (the CLI's command, environment, parser and files; the interface this seam was
 * before #13). A runtime that runs no CLI (Pi on a Durable Object, #14) implements `AgentRuntime`
 * directly.
 *
 * **No secret crosses this seam into an event, a step result or a log.** A lease's `env` and
 * `files` go into the turn and nowhere else; `turnEnv` is placeholders by construction.
 */

import type { AiProvider } from '@launch/shared/ai/config'
import type {
  AgentCredentialKind,
  AgentCredentialMetadata,
  AgentRuntimeId,
  AgentRuntimeState,
  SessionCredentialSource,
} from '@launch/shared/launch-agents'
import type { SessionAttachment, SessionEventInput } from '@launch/shared/launch-sessions'
import type { AppConfig } from '../../../../config'
import type { Database } from '../../../../db/client'
import type { SessionRow } from '../../../../db/schema'
import type { Logger } from '../../../utils/core/logger'
import type { StorageService } from '../../storage'
import type { ClaudeMessageUsage, ClaudeModelUsage, ClaudeTurnResult } from '../claude-stream'
import type { SessionEgressPort } from '../ports'
import type { SandboxPort } from '../sandbox-port'

// ---- one turn's output ---------------------------------------------------------------------------

/** An image the message carries, already in the container (`attachments.ts`'s `stageAttachments`). */
export interface RuntimeAttachment {
  path: string
  contentType: string
}

export interface RuntimeCommandInput {
  /** The person's message (or Launch's prompt), verbatim — the runtime quotes it. */
  message: string
  /**
   * The frozen `policy.model`: pinned, the only model the egress lets through; null, none is
   * passed and the agent runs its own default (the egress lets through any priced model).
   */
  model: string | null
  /** `resumeIdOf(row)` from the previous turn; absent on the first. */
  resumeId?: string | null
  /** The `session-system-note` prompt, filled in. */
  systemNote?: string | null
  /** The message's images, in order (none: the command is the text-only one). */
  attachments?: readonly RuntimeAttachment[]
}

/** A turn's final verdict, as every runtime reports it (Claude's `result` line is the shape). */
export type RuntimeTurnResult = ClaudeTurnResult

/** What one line of the CLI's output became. */
export interface RuntimeLineMapping {
  events: SessionEventInput[]
  /** The conversation id to resume next turn, when this line named one. */
  resumeId: string | null
  /** Set by the turn's last line: the turn is over. */
  result: RuntimeTurnResult | null
  /** Per-response usage (`host` egress mode meters the turn itself, `turn-meter.ts`). */
  messageUsage?: ClaudeMessageUsage
  /** The turn's usage per model, from its last line. */
  turnUsage?: ClaudeModelUsage[]
  /**
   * The new `sessions.runtime_state`, when this line changed it (Codex: the thread's running usage
   * total, which the next turn's usage is measured from). The turn writes it at once.
   */
  runtimeState?: AgentRuntimeState
}

/** What a parser is handed besides the turn number. */
export interface RuntimeParserContext {
  /** `sessions.runtime_state` as the turn read it. */
  runtimeState?: AgentRuntimeState | null
}

/** Raw process output in (chunks may split a line anywhere), mappings out. */
export interface RuntimeStreamParser {
  push(chunk: string): RuntimeLineMapping[]
  end(): RuntimeLineMapping[]
}

/** What `resumeRefused` reads of a finished stream. */
export interface RuntimeRunSummary {
  stop: string | null
  /** The CLI said or did something (text, a tool call). */
  output: boolean
  result: RuntimeTurnResult | null
}

/** A file the runtime writes into the container. */
export interface RuntimeFile {
  path: string
  content: string
}

// ---- conversation state --------------------------------------------------------------------------

/**
 * Where a CLI's conversation lives as a FILE in the container — what `processRuntime` turns into
 * the runtime's `RuntimeStateStore` (read for the checkpoint, written back by `transcript#K`), and
 * what its turn checks before it resumes.
 */
export interface RuntimeStateFiles {
  /** The R2 key the checkpoint stores it under. */
  key(sessionId: string): string
  contentType: string
  /**
   * The container path of the conversation behind `resumeIdOf(row)` for the checkpoint to read,
   * or null when there is none (no resume id, or one that is not a safe path segment).
   */
  locate(
    sandbox: SandboxPort,
    row: SessionRow,
    opts: { cwd: string; home: string }
  ): Promise<string | null>
  /** Where a restore writes it back (and the turn checks it exists); null = cannot restore. */
  restorePath(row: SessionRow): string | null
  /** A command that exits 1 when `path` is missing or empty. */
  checkCommand(path: string): string
}

// ---- credentials ---------------------------------------------------------------------------------

/**
 * One turn's credential (§18.22). `platform`: nothing — the egress swaps Launch's key in for the
 * placeholder. `user`: whatever the runtime's CLI needs for the person's own account (Codex's
 * `auth.json` in `files`, a claim held until `release`) — but never a secret in `env` the egress
 * could have swapped in instead (Claude's token stays outside the container).
 */
export interface TurnCredentialLease {
  source: SessionCredentialSource
  /** Merged into the turn process's environment, after `turnEnv`. */
  env: Record<string, string>
  /** Written into the container before the turn starts. */
  files: RuntimeFile[]
  /** Called in the turn's `finally`, whatever happened: write back, remove, release the claim. */
  release(): Promise<void>
}

/** What a runtime's `userLease` is handed. */
export interface UserLeaseContext {
  db: Database
  cfg: AppConfig
  session: SessionRow
  sandbox: SandboxPort
  now: () => Date
}

/** Leases a session's credential for one turn — `ports.credentials(db)`. */
export interface SessionCredentialPort {
  lease(
    session: SessionRow,
    sandbox: SandboxPort,
    runtime: AgentRuntime
  ): Promise<TurnCredentialLease>
}

// ---- login ---------------------------------------------------------------------------------------

/** What a login step hands the runtime's driver. */
export interface LoginContext {
  sandbox: SandboxPort
  loginId: string
}

/** What the person needs to finish the provider's flow. Neither field is a credential. */
export interface LoginPrompt {
  verificationUrl: string
  /** Codex's device code (typed AT the provider); null for Claude. */
  userCode: string | null
}

/** Has the CLI finished? */
export type LoginProgress = { state: 'running' } | { state: 'exited'; exitCode: number | null }

/** The credential the CLI wrote — sealed by the caller at once, never returned from a step. */
export interface LoginCapture {
  kind: AgentCredentialKind
  secret: string
  expiresAt: Date | null
  metadata: AgentCredentialMetadata
}

/**
 * The relayed sign-in for one runtime: the provider's CLI, unmodified, in a throwaway sandbox.
 * Launch never runs the OAuth exchange; it relays the URL out and (Claude) the pasted code in.
 */
export interface LoginDriver {
  /** Hosts the login sandbox must reach (added to its allow-list). */
  readonly hosts: readonly string[]
  /** The person pastes a code back (`AGENT_LOGIN_NEEDS_CODE`). */
  readonly needsCode: boolean
  /** Write whatever the CLI needs and start it. */
  start(ctx: LoginContext): Promise<void>
  /** The URL (and code) the CLI printed, or null when it has not printed them yet. */
  readPrompt(ctx: LoginContext): Promise<LoginPrompt | null>
  /** Hand the CLI the code the person pasted (only when `needsCode`). */
  submitCode?(ctx: LoginContext, code: string): Promise<void>
  poll(ctx: LoginContext): Promise<LoginProgress>
  /**
   * The credential the CLI wrote; throws (with the CLI's own reason) when there is none. Reads
   * only: the `capture` step is retried, and a retry must find what the first attempt saw — a
   * capture that deleted on failure hid the reason and, after a failed write, the token itself.
   */
  capture(ctx: LoginContext): Promise<LoginCapture>
  /**
   * Remove the CLI's files (the credential among them) once the credential is sealed. Belt and
   * braces: `cleanup` destroys the whole login sandbox on every path.
   */
  discard(ctx: LoginContext): Promise<void>
}

// ---- the CLI adapter (process runtimes) --------------------------------------------------------

/**
 * A CLI that runs one turn as one process in the session's container — what `processRuntime(cli)`
 * (`process/`) drives. Claude Code and Codex are the two.
 *
 * | member            | what it is                                                       |
 * |-------------------|------------------------------------------------------------------|
 * | `buildCommand`    | the shell command for one turn (the message, the model, the resume id, the system note, the images) |
 * | `turnInputCommand`| a command run before the turn that writes what its command reads (Claude: the images' stream-json input) |
 * | `turnEnv`         | the turn process's NON-secret environment (placeholders only)    |
 * | `createParser`    | the CLI's stdout → `session_events` rows, the resume id, the result |
 * | `resumeRefused`   | "the CLI would not resume that conversation" — the turn retries once without it |
 * | `selfMetered`     | its turns reach the provider past every proxy, so they meter themselves |
 * | `workspaceFiles`  | files written into the checkout at clone (Claude's deny rules)    |
 * | `beforeTurnFiles` | files written before every turn (Codex's config, Stream B)       |
 * | `state`           | where the conversation lives in the container, and in R2 (`RuntimeStateFiles`) |
 * | `login`           | the relayed sign-in for a personal account (`LoginDriver`)        |
 * | `userLease`       | a personal account's credential for one turn (`TurnCredentialLease`) |
 */
export interface CliAdapter {
  id: AgentRuntimeId
  /** What a person reads: `Claude Code`, `Codex` — and every turn message names it. */
  label: string
  /** Whose API the platform key is for (`ai_usage.provider`). */
  provider: AiProvider
  buildCommand(input: RuntimeCommandInput): string
  /**
   * Run with `exec` before the turn's process starts, when the command reads something it does
   * not carry itself; null (or absent) when it needs nothing. Must exit 0.
   */
  turnInputCommand?(input: RuntimeCommandInput): string | null
  turnEnv(input: { model: string | null; source: SessionCredentialSource }): Record<string, string>
  createParser(turn: number, ctx?: RuntimeParserContext): RuntimeStreamParser
  resumeRefused(run: RuntimeRunSummary): boolean
  /**
   * Under the `proxied` egress, does a turn on `source` reach its provider where no proxy sees it,
   * so it must meter itself from its own output (`turn-meter.ts`)? Absent: never. Codex on a
   * person's ChatGPT plan: yes — ChatGPT blocks the Workers runtime (`egress/registry.ts`).
   */
  selfMetered?(source: SessionCredentialSource): boolean
  workspaceFiles(): RuntimeFile[]
  beforeTurnFiles?(input: {
    model: string | null
    systemNote: string | null
    source: SessionCredentialSource
  }): RuntimeFile[]
  state: RuntimeStateFiles
  login?: LoginDriver
  /** A personal account's credential for one turn. Absent: the runtime has no personal accounts. */
  userLease?(ctx: UserLeaseContext): Promise<TurnCredentialLease>
}

// ---- the runtime ---------------------------------------------------------------------------------

/**
 * Where a runtime's agent loop runs. `container`: a process in the session's container (every
 * runtime today — `processRuntime`). `durable-object`: in Launch's own Workers, reaching the
 * checkout through the sandbox (Pi, #14) — designed for, not built.
 */
export type RuntimePlacement = 'container' | 'durable-object'

/** What every runtime call is handed: the session, its container, a logger. */
export interface RuntimeContext {
  session: SessionRow
  /** The session's container (`ports.sandbox(session.id)`). */
  sandbox: SandboxPort
  logger?: Logger
}

/**
 * One turn's context (`turn.ts` builds it). `session` is the CLAIMED row — its `turn_count` is
 * `turn`, its resume id the conversation to continue. The clocks and intervals are the turn's
 * (`RunTurnOptions`, defaulted); the two callbacks are the only way a runtime touches the row.
 */
export interface TurnContext extends RuntimeContext {
  /** The step's own client — for the runtime's own services (budget headroom, usage). */
  db: Database
  turn: number
  /** How the container reaches the provider and GitHub (`proxied` unless the sandbox is remote). */
  egress: SessionEgressPort
  /** §18.22: the turn's credential lease (platform: nothing). */
  credentials: SessionCredentialPort
  /** R2 — where a message's images are; null: a message with images fails its turn, saying so. */
  storage: StorageService | null
  /** The checkout the turn runs in; absent: the runtime's default. */
  cwd?: string
  now: () => number
  /** MUST yield to the event loop (a timer), or the watch loops starve the stream. */
  sleep: (ms: number) => Promise<void>
  /** The turn's own timeout (`policy.maxTurnMinutes` unless overridden) → `stop: 'timeout'`. */
  timeoutMs: number
  flushMs: number
  flushEvery: number
  /** How often to ask {@link TurnContext.cancelRequested} (and check the timeout). */
  cancelPollMs: number
  /** How often to call {@link TurnContext.heartbeat}. */
  heartbeatMs: number
  /** The boot's id — the marker a liveness probe expects (`boot-marker.ts`); null = no probe. */
  bootId: string | null
  probeMs: number
  probeCallMs: number
  probeFailures: number
  /** Write "this turn is alive" (`last_activity_at`, while `working`) as of `at`. Never throws. */
  heartbeat(at: number): Promise<void>
  /** Has a Stop been asked for (`cancel_requested_at`)? → `stop: 'cancelled'`. */
  cancelRequested(): Promise<boolean>
}

/** What one turn is asked to do. */
export interface TurnInput {
  /** The message (or Launch's prompt), exactly as the agent should read it. */
  message: string
  /** The frozen `policy.model` (null: the agent's own default). */
  model: string | null
  /** The message's images, still in R2 (none for Launch's own prompts). */
  attachments: readonly SessionAttachment[]
  /** The `session-system-note` prompt, filled in — read when (and each time) it is needed. */
  systemNote(): Promise<string>
}

/**
 * Where a turn's normalised output goes (`turn.ts` implements it): `session_events`, the resume
 * id and `runtime_state` — and, from the events, the AG-UI projection on read.
 */
export interface TurnSink {
  /**
   * One mapping, in order: its resume id (when new) and runtime state are written at once — a
   * turn that fails later must still be resumable — and its events buffered.
   */
  apply(mapping: RuntimeLineMapping): Promise<void>
  /** An event of the runtime's own (`budget.reached`), buffered. */
  append(...events: SessionEventInput[]): void
  /** Events buffered and not yet written. */
  readonly pending: number
  flush(): Promise<void>
  /**
   * The conversation this turn would resume cannot be: clear the resume id (the turn goes on as a
   * new conversation) and say so in an `error` event.
   */
  forgetConversation(): Promise<void>
}

/**
 * `rollout` — the platform replaced the container under a call; `container_lost` — it died and
 * came back empty; `cancelled` — a Stop; `timeout` — the turn's own timeout.
 */
export type RuntimeTurnStop = 'rollout' | 'container_lost' | 'cancelled' | 'timeout'

/**
 * How a turn ended, before any closing event is written (`turn.ts` writes exactly one from it):
 * a `stop` → `turn.interrupted`; a `result` and no `failure` → `turn.end`; else `turn.failed`.
 */
export interface RuntimeTurnOutcome {
  result: RuntimeTurnResult | null
  /** Why the turn stopped before its end, if it did. */
  stop: RuntimeTurnStop | null
  /** A human sentence for `turn.failed` — redacted and clipped. */
  failure: string | null
  /** The agent said or did something (a text, a tool call). */
  output: boolean
  /** Issue #8: when (`now()`) it first did — the turn's `firstTokenMs`. */
  firstOutputAt?: number
  /** How many times the turn re-attached to its agent's output after the stream dropped. */
  logReattaches?: number
}

/**
 * A runtime's conversation between turns: what the checkpoint copies to R2 after a turn (`key`,
 * `contentType`, `read`) and the `transcript#K` step puts back before the next (`restorable`,
 * `restore`).
 */
export interface RuntimeStateStore {
  /** The R2 key the checkpoint stores it under. */
  key(sessionId: string): string
  contentType: string
  /**
   * The conversation behind `resumeIdOf(ctx.session)`, from wherever the runtime keeps it; null
   * when there is none to read.
   */
  read(ctx: RuntimeContext, opts: { cwd: string; home: string }): Promise<string | null>
  /** Could a stored conversation be put back for this row at all (a resume id it can name)? */
  restorable(row: SessionRow): boolean
  /** Put `content` back; true when the runtime holds it afterwards. */
  restore(ctx: RuntimeContext, content: string): Promise<boolean>
}

export interface AgentRuntime {
  id: AgentRuntimeId
  /** What a person reads: `Claude Code`, `Codex` — and every turn message names it. */
  label: string
  /** Whose API the platform key is for (`ai_usage.provider`). */
  provider: AiProvider
  placement: RuntimePlacement
  workspaceFiles(): RuntimeFile[]
  /**
   * Run one turn to its end. Never throws for anything the TURN did (a failed start, a lost
   * container, a cancel, a timeout are outcomes); only when the database does.
   */
  runTurn(ctx: TurnContext, input: TurnInput, sink: TurnSink): Promise<RuntimeTurnOutcome>
  /**
   * Stop whatever is left of a turn nobody reads any more (the salvage's orphaned turn). Resolves
   * when nothing of it is left, or there was nothing to stop; throws when it could not be asked.
   */
  cancel(ctx: RuntimeContext): Promise<void>
  state: RuntimeStateStore
  login?: LoginDriver
  /** A personal account's credential for one turn. Absent: the runtime has no personal accounts. */
  userLease?(ctx: UserLeaseContext): Promise<TurnCredentialLease>
}
