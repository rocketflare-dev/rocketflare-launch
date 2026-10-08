/**
 * The Pi runtime's wire (rocketflare-launch#14): what `piRuntime` (`index.ts`, in the session's
 * Workflow step) asks of the session's `PiSessionAgent` Durable Object (`agent.ts`) — the
 * {@link PiAgentPort} — and what comes back. Plain JSON both ways: it crosses a Durable Object RPC
 * in production and a direct call in tests (the in-process core, `core.ts`).
 *
 * A turn is ONE pi operation, addressed by `operationId` (`<sessionId>:<turn>`). `startTurn` is
 * idempotent on it (pi's own request id), so a retried call never submits the message twice.
 * `drain(operationId, afterSeq)` is the cursor pi does not have: every transcript entry pi
 * committed since the turn started, mapped to `session_events`, numbered by pi's own entry id —
 * which is strictly increasing and durable in the object's SQLite, so a drain after an eviction
 * resumes exactly where the last one stopped.
 */
import type { SessionSandboxHost } from '@launch/shared/launch-setup'
import type { RuntimeLineMapping } from '../types'

/** The `PiSessionAgent` instance of a session: `idFromName(sessionId)`. */
export const piAgentName = (sessionId: string) => sessionId

/** A turn's operation id — pi's request id, the idempotency key of `startTurn`. */
export const piOperationId = (sessionId: string, turn: number) => `${sessionId}:${turn}`

/** What `startTurn` is handed: everything the object needs to run the turn, and to recover it. */
export interface PiTurnRequest {
  sessionId: string
  turn: number
  operationId: string
  /** The person's message (or Launch's prompt), verbatim. */
  message: string
  /** The Workers AI model (`@cf/…`) — the session's pinned one, else Pi's default. */
  model: string
  /** The `session-system-note` prompt, filled in: the conversation's instructions from now on. */
  systemNote: string | null
  /** The checkout the tools run in. */
  cwd: string
  /** Where the session's container runs (frozen on the row) — how the object reaches it. */
  sandboxHost: SessionSandboxHost
  /**
   * The row has no resume id (the first turn, or a conversation Launch forgot): a conversation
   * the object still holds is reset first, so the turn starts fresh — as Claude's would.
   */
  fresh: boolean
}

/** What `startTurn` answers. */
export interface PiTurnStarted {
  /** False when this operation was already submitted (a retried call). */
  accepted: boolean
  /**
   * The turn continues a conversation the object held (not `fresh`, and it had entries before
   * the turn). False on a non-fresh turn: the conversation the row names is gone, and the turn
   * runs as a new one — the runtime says so (`forgetConversation`).
   */
  resumed: boolean
}

/** How pi settled the turn's operation. */
export interface PiSettlement {
  /** `done`: answered. `unanswered`: failed, aborted or withdrawn. */
  status: 'done' | 'unanswered'
  /** Why it went unanswered, in pi's words. */
  reason?: string
  /** The final assistant text, when answered. */
  text?: string
}

/** One drained mapping and its cursor. */
export interface PiDrainItem {
  /** pi's entry id: strictly increasing, the next `afterSeq`. */
  seq: number
  mapping: RuntimeLineMapping
}

export interface PiDrainResult {
  items: PiDrainItem[]
  /** Set once pi settled the operation — read BEFORE the entries, so `items` is then complete. */
  settled: PiSettlement | null
}

/** The session's `PiSessionAgent`, as the runtime reaches it (`ports.piAgent(sessionId)`). */
export interface PiAgentPort {
  /** Submit the turn (idempotent on `operationId`); resolves once pi holds it durably. */
  startTurn(request: PiTurnRequest): Promise<PiTurnStarted>
  /**
   * What the turn produced after `afterSeq`, and whether it is over. `waitMs`: with nothing new,
   * wait up to that long for something (a long poll); absent or 0, answer at once.
   */
  drain(operationId: string, afterSeq: number, waitMs?: number): Promise<PiDrainResult>
  /** Stop whatever runs in the conversation (withdraws queued input too). Idempotent. */
  abort(): Promise<void>
  /** The conversation (the active transcript's entries) as JSON — the checkpoint's copy; null: none. */
  exportTranscript(): Promise<string | null>
  /**
   * Put an exported conversation back. A conversation the object still holds wins (true without
   * importing — the object outlived the container); false when `text` is not one this can read.
   */
  importTranscript(text: string): Promise<boolean>
}
