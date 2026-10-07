/**
 * The agent-runtime CONTRACT (rocketflare-launch#13): what every `AgentRuntime` must do, whatever
 * runs its agent loop — a CLI process in the container (`processRuntime`: Claude Code, Codex) or
 * a Durable Object (Pi, #14). `describeRuntimeContract(harness)` is the suite; a runtime joins it
 * with a {@link RuntimeHarness} that knows how to script ITS agent (a process's stdout, a fake
 * model), how its container answers its own lookups, and — for a runtime that is not a process —
 * what it is handed besides the container (`context`) and how its start or its output stream
 * fails (`failNextStart`, `dropOutputNext`). Tests only a container process can have (a dropped log
 * stream, the SDK's rollout error on start) run `runIf(placement === 'container')`; their
 * Durable Object equivalents (the object's drain failing and coming back, the container replaced
 * under a turn) run for `durable-object`.
 *
 * It drives `runtime.runTurn` directly — no database, no Workflow — with a recording sink, and
 * pins only what `turn.ts` relies on: the normalised output reaches the sink, a resume that cannot
 * work is forgotten rather than failing, a dropped log stream loses and repeats nothing, and every
 * way a turn can end (a result, a Stop, the timeout, a replaced container, a start that fails) is
 * an OUTCOME, never a throw.
 */
import { describe, expect, it } from 'vitest'
import { SESSION_BOOT_MARKER } from '@/api/services/sessions/boot-marker'
import { PLATFORM_CREDENTIALS } from '@/api/services/sessions/credentials/lease'
import { PROXIED_EGRESS, SandboxInterruptedError } from '@/api/services/sessions/ports'
import { SESSION_HOME, SESSION_WORKSPACE } from '@/api/services/sessions/rocketflare-dev'
import { runtimeFor } from '@/api/services/sessions/runtimes'
import type {
  AgentRuntime,
  RuntimeContext,
  RuntimeLineMapping,
  TurnContext,
  TurnInput,
  TurnSink,
} from '@/api/services/sessions/runtimes/types'
import type { Database } from '@/db/client'
import type { SessionRow } from '@/db/schema'
import { FakeSandbox } from './fake-sandbox'

export interface ScriptedTurn {
  /** The conversation id the agent names (the next turn resumes it). */
  resumeId: string
  /** The agent's final answer. */
  text: string
  /** Keep running after its output until stopped (a cancel, the timeout). */
  hang?: boolean
}

export interface RuntimeHarness {
  runtime: AgentRuntime
  /** A conversation id this runtime accepts as a resume id (for the contract's session row). */
  resumeId: string
  /**
   * Make `sandbox` answer this runtime's own lookups the way its container would — and, for a
   * runtime that is not a process, set up whatever it runs in beside it (Pi: its object).
   */
  container(sandbox: FakeSandbox): void | Promise<void>
  /** Script the agent's next turn: it names `resumeId`, says `text`, and ends with a result. */
  scriptTurn(sandbox: FakeSandbox, turn: ScriptedTurn): void
  /** What every runtime call is handed besides the session and the container (Pi: its object). */
  context?(sandbox: FakeSandbox): Partial<RuntimeContext>
  /** A conversation in this runtime's own format (default: one JSONL line). */
  conversation?: string
  /** Make the turn's next START fail with `error` (default: the container's `startProcess`). */
  failNextStart?(sandbox: FakeSandbox, error: Error): void
  /** Make the turn's output stream drop `count` times, then come back (`durable-object` only). */
  dropOutputNext?(sandbox: FakeSandbox, count: number): void
}

/** What a recording sink saw. */
export interface RecordedSink extends TurnSink {
  mappings: RuntimeLineMapping[]
  appended: unknown[]
  flushed: number
  forgotten: number
}

export function recordingSink(): RecordedSink {
  let buffered = 0
  const sink: RecordedSink = {
    mappings: [],
    appended: [],
    flushed: 0,
    forgotten: 0,
    async apply(mapping) {
      sink.mappings.push(mapping)
      buffered += mapping.events.length
    },
    append(...events) {
      sink.appended.push(...events)
      buffered += events.length
    },
    get pending() {
      return buffered
    },
    async flush() {
      sink.flushed += 1
      buffered = 0
    },
    async forgetConversation() {
      sink.forgotten += 1
    },
  }
  return sink
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

function sessionRow(runtime: AgentRuntime, resumeId: string | null): SessionRow {
  return {
    id: `contract-${runtime.id}`,
    tenantId: 'tenant-contract',
    runtime: runtime.id,
    credentialSource: 'platform',
    claudeSessionId: resumeId,
    runtimeState: null,
    costMicrocents: 0,
  } as unknown as SessionRow
}

function turnContext(
  session: SessionRow,
  sandbox: FakeSandbox,
  over: Partial<TurnContext> = {}
): TurnContext {
  return {
    // A platform turn on the proxied egress never reaches the database.
    db: {} as Database,
    session,
    sandbox,
    turn: 1,
    egress: PROXIED_EGRESS,
    credentials: PLATFORM_CREDENTIALS,
    storage: null,
    now: () => Date.now(),
    sleep,
    timeoutMs: 60_000,
    flushMs: 5,
    flushEvery: 20,
    cancelPollMs: 5,
    heartbeatMs: 60_000,
    bootId: null,
    probeMs: 60_000,
    probeCallMs: 1_000,
    probeFailures: 4,
    heartbeat: async () => {},
    cancelRequested: async () => false,
    ...over,
  }
}

const input = (message = 'Add a button'): TurnInput => ({
  message,
  model: null,
  attachments: [],
  systemNote: async () => 'You are in a Launch session.',
})

export function describeRuntimeContract(harness: RuntimeHarness): void {
  const { runtime } = harness
  const container = async () => {
    const sandbox = new FakeSandbox()
    await harness.container(sandbox)
    return sandbox
  }
  const extra = (sandbox: FakeSandbox) => harness.context?.(sandbox) ?? {}
  const runtimeCtx = (session: SessionRow, sandbox: FakeSandbox): RuntimeContext => ({
    session,
    sandbox,
    ...extra(sandbox),
  })
  const turnCtx = (session: SessionRow, sandbox: FakeSandbox, over: Partial<TurnContext> = {}) =>
    turnContext(session, sandbox, { ...extra(sandbox), ...over })
  const failNextStart = (sandbox: FakeSandbox, error: Error) =>
    harness.failNextStart
      ? harness.failNextStart(sandbox, error)
      : sandbox.failNext('startProcess', error)
  const conversation = harness.conversation ?? '{"type":"conversation"}\n'

  describe(`the runtime contract: ${runtime.label}`, () => {
    it('is the registry’s runtime for its id, with a label, a provider and a placement', () => {
      expect(runtimeFor(runtime.id)).toBe(runtime)
      expect(runtime.label).toMatch(/\S/)
      expect(runtime.provider).toMatch(/\S/)
      expect(['container', 'durable-object']).toContain(runtime.placement)
    })

    it('writes its workspace files at absolute paths', () => {
      for (const file of runtime.workspaceFiles()) expect(file.path.startsWith('/')).toBe(true)
    })

    it('keeps each session’s conversation under its own key', () => {
      expect(runtime.state.key('s1')).toContain('s1')
      expect(runtime.state.key('s1')).not.toBe(runtime.state.key('s2'))
      expect(runtime.state.contentType).toMatch(/\S/)
    })

    it('restores only a conversation it can name', () => {
      expect(runtime.state.restorable(sessionRow(runtime, null))).toBe(false)
      expect(runtime.state.restorable(sessionRow(runtime, '../x; rm -rf /'))).toBe(false)
      expect(runtime.state.restorable(sessionRow(runtime, harness.resumeId))).toBe(true)
    })

    it('reads back the conversation it restored (the checkpoint after a cold resume)', async () => {
      const sandbox = await container()
      const session = sessionRow(runtime, harness.resumeId)
      expect(await runtime.state.restore(runtimeCtx(session, sandbox), conversation)).toBe(true)
      expect(
        await runtime.state.read(runtimeCtx(session, sandbox), {
          cwd: SESSION_WORKSPACE,
          home: SESSION_HOME,
        })
      ).toBe(conversation)
    })

    it('reads nothing when there is no conversation', async () => {
      const sandbox = await container()
      expect(
        await runtime.state.read(runtimeCtx(sessionRow(runtime, null), sandbox), {
          cwd: SESSION_WORKSPACE,
          home: SESSION_HOME,
        })
      ).toBeNull()
    })

    it('runs a turn: its output reaches the sink, normalised, and it ends with a result', async () => {
      const sandbox = await container()
      harness.scriptTurn(sandbox, { resumeId: harness.resumeId, text: 'Added the button.' })
      const sink = recordingSink()
      const outcome = await runtime.runTurn(
        turnCtx(sessionRow(runtime, null), sandbox),
        input(),
        sink
      )
      expect(outcome).toMatchObject({ stop: null, failure: null, output: true })
      expect(outcome.result).toMatchObject({ isError: false, text: 'Added the button.' })
      expect(outcome.firstOutputAt).toEqual(expect.any(Number))
      expect(sink.mappings.some(m => m.resumeId === harness.resumeId)).toBe(true)
      const events = sink.mappings.flatMap(m => m.events)
      expect(events.some(e => e.type === 'text' && e.turn === 1)).toBe(true)
      expect(sink.forgotten).toBe(0)
    })

    it('resumes a conversation it holds without forgetting it', async () => {
      const sandbox = await container()
      const session = sessionRow(runtime, harness.resumeId)
      await runtime.state.restore(runtimeCtx(session, sandbox), conversation)
      harness.scriptTurn(sandbox, { resumeId: harness.resumeId, text: 'Again.' })
      const sink = recordingSink()
      const outcome = await runtime.runTurn(turnCtx(session, sandbox), input(), sink)
      expect(outcome.result?.text).toBe('Again.')
      expect(sink.forgotten).toBe(0)
    })

    it('forgets a conversation it cannot resume, and runs the turn as a new one', async () => {
      const sandbox = await container()
      harness.scriptTurn(sandbox, { resumeId: harness.resumeId, text: 'Fresh.' })
      const sink = recordingSink()
      const outcome = await runtime.runTurn(
        turnCtx(sessionRow(runtime, harness.resumeId), sandbox),
        input(),
        sink
      )
      expect(sink.forgotten).toBe(1)
      expect(outcome).toMatchObject({ stop: null, failure: null })
      expect(outcome.result?.text).toBe('Fresh.')
    })

    // A runtime whose agent prints to a log stream (a container process).
    it.runIf(runtime.placement === 'container')(
      'outlives a dropped log stream: the same output, each mapping once',
      async () => {
        const run = async (drop: boolean) => {
          const sandbox = await container()
          harness.scriptTurn(sandbox, { resumeId: harness.resumeId, text: 'Added the button.' })
          if (drop) sandbox.dropStreamNext({ after: 1 }).dropStreamNext({ after: 2 })
          const sink = recordingSink()
          const outcome = await runtime.runTurn(
            // The re-attach's backoff, shortened.
            turnCtx(sessionRow(runtime, null), sandbox, { sleep: () => sleep(1) }),
            input(),
            sink
          )
          return { sandbox, sink, outcome }
        }
        const clean = await run(false)
        const dropped = await run(true)
        expect(dropped.sandbox.streamDrops).toBe(2)
        expect(dropped.outcome).toMatchObject({ stop: null, failure: null, logReattaches: 2 })
        expect(dropped.outcome.result?.text).toBe('Added the button.')
        const shape = (sink: RecordedSink) =>
          sink.mappings.map(m => ({ resumeId: m.resumeId, events: m.events.map(e => e.type) }))
        expect(shape(dropped.sink)).toEqual(shape(clean.sink))
      }
    )

    // A runtime whose agent runs in a Durable Object: its output is drained from the object.
    it.runIf(runtime.placement === 'durable-object')(
      'outlives its object restarting under a turn: the same output, each mapping once',
      async () => {
        const run = async (drop: boolean) => {
          const sandbox = await container()
          harness.scriptTurn(sandbox, { resumeId: harness.resumeId, text: 'Added the button.' })
          if (drop) harness.dropOutputNext?.(sandbox, 3)
          const sink = recordingSink()
          const outcome = await runtime.runTurn(
            turnCtx(sessionRow(runtime, null), sandbox),
            input(),
            sink
          )
          return { sink, outcome }
        }
        const clean = await run(false)
        const dropped = await run(true)
        expect(dropped.outcome).toMatchObject({ stop: null, failure: null })
        expect(dropped.outcome.result?.text).toBe('Added the button.')
        const shape = (sink: RecordedSink) =>
          sink.mappings
            .map(m => ({ resumeId: m.resumeId, events: m.events.map(e => e.type) }))
            .filter(m => m.resumeId || m.events.length > 0)
        expect(shape(dropped.sink)).toEqual(shape(clean.sink))
      }
    )

    it.runIf(runtime.placement === 'durable-object')(
      'notices its container replaced under a turn: `container_lost`, no throw',
      async () => {
        const sandbox = await container()
        sandbox.files.set(SESSION_BOOT_MARKER, 'boot-1')
        harness.scriptTurn(sandbox, { resumeId: harness.resumeId, text: 'Working…', hang: true })
        setTimeout(() => sandbox.recreate(), 20)
        const outcome = await runtime.runTurn(
          turnCtx(sessionRow(runtime, null), sandbox, { bootId: 'boot-1', probeMs: 5 }),
          input(),
          recordingSink()
        )
        expect(outcome).toMatchObject({ stop: 'container_lost', result: null })
      }
    )

    it('stops on a Stop: `cancelled`, no throw', async () => {
      const sandbox = await container()
      harness.scriptTurn(sandbox, { resumeId: harness.resumeId, text: 'Working…', hang: true })
      let asked = 0
      const outcome = await runtime.runTurn(
        turnCtx(sessionRow(runtime, null), sandbox, {
          cancelRequested: async () => ++asked >= 2,
        }),
        input(),
        recordingSink()
      )
      expect(outcome.stop).toBe('cancelled')
    })

    it('stops at its timeout: `timeout`, no throw', async () => {
      const sandbox = await container()
      harness.scriptTurn(sandbox, { resumeId: harness.resumeId, text: 'Working…', hang: true })
      const outcome = await runtime.runTurn(
        turnCtx(sessionRow(runtime, null), sandbox, { timeoutMs: 20 }),
        input(),
        recordingSink()
      )
      expect(outcome.stop).toBe('timeout')
    })

    // The SDK's own "replaced while a command was running", thrown at the process's start.
    it.runIf(runtime.placement === 'container')(
      'reports a replaced container as `rollout`, no throw',
      async () => {
        const sandbox = await container()
        failNextStart(sandbox, new SandboxInterruptedError())
        const outcome = await runtime.runTurn(
          turnCtx(sessionRow(runtime, null), sandbox),
          input(),
          recordingSink()
        )
        expect(outcome).toMatchObject({ stop: 'rollout', result: null })
      }
    )

    it('fails a turn that cannot start with a sentence naming the agent, no throw', async () => {
      const sandbox = await container()
      failNextStart(sandbox, new Error('boom'))
      const outcome = await runtime.runTurn(
        turnCtx(sessionRow(runtime, null), sandbox),
        input(),
        recordingSink()
      )
      expect(outcome).toMatchObject({ stop: null, result: null, output: false })
      expect(outcome.failure).toContain(runtime.label)
    })

    it('cancels a turn nobody reads — and resolves when there is none', async () => {
      const sandbox = await container()
      await expect(
        runtime.cancel(runtimeCtx(sessionRow(runtime, null), sandbox))
      ).resolves.toBeUndefined()
    })
  })
}
