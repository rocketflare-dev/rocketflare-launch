/**
 * The Pi session object's logic (rocketflare-launch#14), written against pi-durable alone so it
 * runs — and is tested — in plain Node: the Durable Object (`agent.ts`) is a thin shell that hands
 * it pi over the object's SQLite (through `agents`' `PiHarness`, which also wakes pi after an
 * eviction), and the tests hand it pi over `MemoryStorage` with pi-ai's faux provider standing in
 * for Workers AI (`tests/helpers/pi.ts`).
 *
 * - **A turn is one pi operation** (`startTurn`): the conversation is configured for it — the
 *   session's Workers AI model, the `session-system-note` as its instructions, the checkout as its
 *   `cwd` — and the message submitted under the turn's operation id, which pi deduplicates. A turn
 *   on a row with no resume id resets a conversation the object still holds.
 * - **The event log is pi's own transcript** (`drain`): entries pi commits are durable in the
 *   object's SQLite and numbered by strictly increasing ids, so they ARE the monotonic log the
 *   runtime drains by cursor — no second table, nothing lost to an eviction. The turn's record
 *   (its operation, the newest entry before it, where its container is) is the one thing kept
 *   beside them ({@link PiTurnStore}).
 * - **The transcript travels as JSON** (`exportTranscript` / `importTranscript`): the active
 *   context's entries, for the checkpoint's R2 copy, and put back only into an object that holds
 *   nothing (one that outlived the container keeps its own).
 */
import type {
  Conversation,
  EntryDraft,
  EntryRecord,
  Harness,
  Storage,
  SubmissionRecord,
} from '@earendil-works/pi-durable'
import { mapPiEntry } from './events'
import type {
  PiAgentPort,
  PiDrainItem,
  PiDrainResult,
  PiSettlement,
  PiTurnRequest,
  PiTurnStarted,
} from './protocol'

/** pi's invocation context (chord's `Context`, which pi-durable does not re-export). */
export type PiContext = Parameters<Harness['close']>[0]

/** A background context: no values, never cancelled (chord's `BACKGROUND_CONTEXT`). */
export const PI_BACKGROUND_CONTEXT = Object.freeze({
  abortSignal: undefined,
  value: () => undefined,
  toString: () => '[Context launch-pi]',
}) as unknown as PiContext
const BG = PI_BACKGROUND_CONTEXT

/** The pi-ai provider id of Workers AI under `agents/models/pi-ai`'s `createAI`. */
export const PI_WORKERS_AI_PROVIDER = 'cloudflare'

/**
 * pi's run policy for a session: one tool at a time (a `bash` never races the `write` before it),
 * and a rate-limited model retried for about 30 s (1, 2, 4, 8, 16 s) before the turn fails.
 */
export const PI_HARNESS_SETTINGS = {
  toolExecution: 'sequential',
  retry: { enabled: true, maxRetries: 5, baseDelayMs: 1_000 },
} as const satisfies NonNullable<Parameters<typeof Harness.open>[1]['settings']>

/** What the object remembers of the turn in progress (or the last one). */
export interface PiTurnRecord {
  sessionId: string
  turn: number
  operationId: string
  cwd: string
  sandboxHost: PiTurnRequest['sandboxHost']
  /** The newest entry id before the turn: everything after it is the turn's. */
  baseline: number
  /** It continued a conversation the object held. */
  resumed: boolean
}

/** Where the turn record lives: the object's synchronous KV, or memory in tests. */
export interface PiTurnStore {
  get(): PiTurnRecord | null
  put(record: PiTurnRecord): void
}

export function memoryTurnStore(): PiTurnStore {
  let record: PiTurnRecord | null = null
  return {
    get: () => record,
    put: next => {
      record = next
    },
  }
}

/**
 * How the core reaches pi: the opened Harness and its Storage, and the two calls that must go
 * through the host (the Durable Object's `PiHarness` schedules its wake job around them).
 */
export interface PiDriver {
  harness(): Promise<Harness>
  storage(): Promise<Storage>
  /** Durably submit user input under `operationId` (pi's request id: a repeat is a no-op). */
  submit(message: string, operationId: string): Promise<void>
  /** Abort everything in the root conversation; resolves once it is idle. */
  abort(): Promise<void>
}

/** What the core is built with. */
export interface PiSessionCoreOptions {
  driver: PiDriver
  store: PiTurnStore
  /** The pi-ai provider id models are resolved under (Workers AI: `cloudflare`). */
  provider?: string
  /** Called when a turn starts: the tools' readiness check starts over. */
  onTurnStart?(record: PiTurnRecord): void
  /** Test hooks for `drain`'s wait: default real time. */
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

/** How often a waiting `drain` looks at the object's own SQLite again (local reads, no I/O out). */
export const PI_DRAIN_RECHECK_MS = 250

/** The exported transcript's envelope. */
export const PI_TRANSCRIPT_FORMAT = 'launch-pi-transcript'

interface PiTranscript {
  format: typeof PI_TRANSCRIPT_FORMAT
  version: 1
  entries: EntryDraft[]
}

/** The final assistant text of an entry. */
function assistantText(entry: EntryRecord | undefined): string {
  const message = entry?.model?.[0]
  if (message?.role !== 'assistant') return ''
  return message.content.map(part => (part.type === 'text' ? part.text : '')).join('')
}

/** An entry as a draft another conversation can append. */
function toDraft(entry: EntryRecord): EntryDraft {
  const { id: _id, conversationId: _c, byTaskId: _t, head: _h, ...draft } = entry
  return draft as EntryDraft
}

/** A parsed transcript, or null when `text` is not one this writes. */
export function parsePiTranscript(text: string): EntryDraft[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  const t = parsed as Partial<PiTranscript> | null
  if (!t || t.format !== PI_TRANSCRIPT_FORMAT || t.version !== 1 || !Array.isArray(t.entries)) {
    return null
  }
  const ok = t.entries.every(
    e => e && typeof e === 'object' && typeof (e as { kind?: unknown }).kind === 'string'
  )
  return ok ? t.entries : null
}

export class PiSessionCore implements PiAgentPort {
  readonly #driver: PiDriver
  readonly #store: PiTurnStore
  readonly #provider: string
  readonly #onTurnStart?: (record: PiTurnRecord) => void
  readonly #now: () => number
  readonly #sleep: (ms: number) => Promise<void>

  constructor(options: PiSessionCoreOptions) {
    this.#driver = options.driver
    this.#store = options.store
    this.#provider = options.provider ?? PI_WORKERS_AI_PROVIDER
    this.#onTurnStart = options.onTurnStart
    this.#now = options.now ?? (() => Date.now())
    this.#sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  }

  /** The turn in progress (or the last one) — what the tools find their container through. */
  currentTurn(): PiTurnRecord | null {
    return this.#store.get()
  }

  async #root(): Promise<Conversation> {
    return (await this.#driver.harness()).root(BG)
  }

  /** The newest entry id in the conversation's history, or 0. */
  async #newestEntryId(conversation: Conversation): Promise<number> {
    const page = await conversation.entries({}, 1, undefined, BG)
    return page.items[0]?.id ?? 0
  }

  async startTurn(request: PiTurnRequest): Promise<PiTurnStarted> {
    const current = this.#store.get()
    const repeat = current?.operationId === request.operationId
    let resumed = current?.resumed ?? false
    if (!repeat) {
      const conversation = await this.#root()
      const held = (await this.#newestEntryId(conversation)) > 0
      if (request.fresh && held) await conversation.reset(undefined, BG)
      resumed = !request.fresh && held
      await conversation.configure(
        {
          model: { provider: this.#provider, modelId: request.model },
          instructions: request.systemNote?.trim() ? request.systemNote : null,
          cwd: request.cwd,
        },
        BG
      )
      const record: PiTurnRecord = {
        sessionId: request.sessionId,
        turn: request.turn,
        operationId: request.operationId,
        cwd: request.cwd,
        sandboxHost: request.sandboxHost,
        baseline: await this.#newestEntryId(conversation),
        resumed,
      }
      this.#store.put(record)
      this.#onTurnStart?.(record)
    }
    // pi deduplicates by request id: a repeated call (a retried RPC) submits nothing new.
    const already = repeat ? await this.#submission(request.operationId) : undefined
    if (!already) await this.#driver.submit(request.message, request.operationId)
    return { accepted: !already, resumed }
  }

  async #submission(operationId: string): Promise<SubmissionRecord | undefined> {
    const conversation = await this.#root()
    return (await this.#driver.storage()).submissionByRequest(conversation.id, operationId, BG)
  }

  /** pi's verdict on the operation, or null while it runs. */
  async #settlement(operationId: string): Promise<PiSettlement | null> {
    const record = await this.#submission(operationId)
    if (!record) return { status: 'unanswered', reason: 'not_found' }
    if (record.status === 'unanswered') return { status: 'unanswered', reason: record.reason }
    if (record.status !== 'done') return null
    if (record.type !== 'input') return { status: 'done' }
    const answer = await (await this.#driver.storage()).entry(record.answer, BG)
    return { status: 'done', text: assistantText(answer?.entry) }
  }

  /**
   * `waitMs` (a long poll): with nothing new yet, keep looking — at the object's own SQLite, every
   * {@link PI_DRAIN_RECHECK_MS} — until something is, the turn settles or the wait is up. The
   * caller (a Workflow step) then makes one call per few seconds while the model thinks, not four
   * a second: every call is a subrequest and CPU on the step's budget (rocketflare-launch#14).
   */
  async drain(operationId: string, afterSeq: number, waitMs = 0): Promise<PiDrainResult> {
    const until = this.#now() + Math.max(0, waitMs)
    for (;;) {
      const result = await this.#drainNow(operationId, afterSeq)
      if (result.items.length > 0 || result.settled || this.#now() >= until) return result
      await this.#sleep(Math.min(PI_DRAIN_RECHECK_MS, Math.max(0, until - this.#now())))
    }
  }

  async #drainNow(operationId: string, afterSeq: number): Promise<PiDrainResult> {
    const record = this.#store.get()
    if (record?.operationId !== operationId) {
      return { items: [], settled: { status: 'unanswered', reason: 'not_found' } }
    }
    // The verdict FIRST: pi commits a turn's entries before it settles it, so a settled read here
    // means the entries read next are all of them.
    const settled = await this.#settlement(operationId)
    const conversation = await this.#root()
    const from = Math.max(record.baseline, afterSeq) + 1
    const entries: EntryRecord[] = []
    let cursor: Parameters<Conversation['entries']>[2]
    do {
      const page = await conversation.entries({ minEntryId: from as never }, 100, cursor, BG)
      entries.push(...page.items)
      cursor = page.next
    } while (cursor)
    const items: PiDrainItem[] = entries
      .sort((a, b) => a.id - b.id)
      .map(entry => ({ seq: entry.id, mapping: mapPiEntry(entry, record.turn) }))
    return { items, settled }
  }

  async abort(): Promise<void> {
    await this.#driver.abort()
  }

  async exportTranscript(): Promise<string | null> {
    const conversation = await this.#root()
    const view = await conversation.context(BG)
    if (view.entries.length === 0) return null
    const transcript: PiTranscript = {
      format: PI_TRANSCRIPT_FORMAT,
      version: 1,
      entries: view.entries.map(toDraft),
    }
    return JSON.stringify(transcript)
  }

  async importTranscript(text: string): Promise<boolean> {
    const conversation = await this.#root()
    // An object that outlived the container holds the conversation itself: it wins.
    if ((await this.#newestEntryId(conversation)) > 0) return true
    const entries = parsePiTranscript(text)
    if (!entries) return false
    if (entries.length === 0) return true
    await conversation.commit(async tx => {
      for (const entry of entries) await tx.appendEntry(conversation.id, entry)
    }, BG)
    return true
  }
}
