/**
 * The agent-runtime seam (§18.22): everything a coding session needs to know about the CLI it runs
 * — Claude Code today, Codex next — as one interface, so the turn runner (`turn.ts`), the boot
 * steps (`steps.ts`), the checkpoint (`checkpoint.ts`) and the login Workflow
 * (`workflows/agent-login.ts`) are written once, against `AgentRuntime`, and a runtime is one
 * directory under `runtimes/`.
 *
 * | member            | what it is                                                       |
 * |-------------------|------------------------------------------------------------------|
 * | `buildCommand`    | the shell command for one turn (the message, the model, the resume id, the system note, the images) |
 * | `turnInputCommand`| a command run before the turn that writes what its command reads (Claude: the images' stream-json input) |
 * | `turnEnv`         | the turn process's NON-secret environment (placeholders only)    |
 * | `createParser`    | the CLI's stdout → `session_events` rows, the resume id, the result |
 * | `resumeRefused`   | "the CLI would not resume that conversation" — the turn retries once without it |
 * | `workspaceFiles`  | files written into the checkout at clone (Claude's deny rules)    |
 * | `beforeTurnFiles` | files written before every turn (Codex's config, Stream B)       |
 * | `state`           | where the conversation lives in the container, and in R2         |
 * | `login`           | the relayed sign-in for a personal account (`LoginDriver`)        |
 * | `userLease`       | a personal account's credential for one turn (`TurnCredentialLease`) |
 *
 * **No secret crosses this seam into an event, a step result or a log.** A lease's `env` and
 * `files` go into the turn process and nowhere else; `turnEnv` is placeholders by construction.
 */

import type { AiProvider } from '@launch/shared/ai/config'
import type {
  AgentCredentialKind,
  AgentCredentialMetadata,
  AgentRuntimeId,
  AgentRuntimeState,
  SessionCredentialSource,
} from '@launch/shared/launch-agents'
import type { SessionEventInput } from '@launch/shared/launch-sessions'
import type { AppConfig } from '../../../../config'
import type { Database } from '../../../../db/client'
import type { SessionRow } from '../../../../db/schema'
import type { ClaudeMessageUsage, ClaudeModelUsage, ClaudeTurnResult } from '../claude-stream'
import type { SandboxPort } from '../sandbox-port'

// ---- one turn ------------------------------------------------------------------------------------

/** An image the message carries, already in the container (`attachments.ts`'s `stageAttachments`). */
export interface RuntimeAttachment {
  path: string
  contentType: string
}

export interface RuntimeCommandInput {
  /** The person's message (or Launch's prompt), verbatim — the runtime quotes it. */
  message: string
  /** The frozen `policy.model`: the only model the egress lets through. */
  model: string
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
 * Where a runtime's conversation lives — what the checkpoint copies to R2 after a turn and the
 * `transcript#K` step puts back before the next one.
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

// ---- the runtime ---------------------------------------------------------------------------------

export interface AgentRuntime {
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
  turnEnv(input: { model: string; source: SessionCredentialSource }): Record<string, string>
  createParser(turn: number, ctx?: RuntimeParserContext): RuntimeStreamParser
  resumeRefused(run: RuntimeRunSummary): boolean
  workspaceFiles(): RuntimeFile[]
  beforeTurnFiles?(input: {
    model: string
    systemNote: string | null
    source: SessionCredentialSource
  }): RuntimeFile[]
  state: RuntimeStateFiles
  login?: LoginDriver
  /** A personal account's credential for one turn. Absent: the runtime has no personal accounts. */
  userLease?(ctx: UserLeaseContext): Promise<TurnCredentialLease>
}
