/**
 * The agent-runtime CONTRACT (rocketflare-launch#13): what every `AgentRuntime` must do, whatever
 * runs its agent loop — a CLI process in the container (`processRuntime`: Claude Code, Codex) or,
 * later, something else (Pi on a Durable Object, #14). `describeRuntimeContract(harness)` is the
 * suite; a runtime joins it with a {@link RuntimeHarness} that knows how to script ITS agent (a
 * process's stdout, a fake model) and how its container answers its own lookups.
 *
 * It drives `runtime.runTurn` directly — no database, no Workflow — with a recording sink, and
 * pins only what `turn.ts` relies on: the normalised output reaches the sink, a resume that cannot
 * work is forgotten rather than failing, and every way a turn can end (a result, a Stop, the
 * timeout, a replaced container, a start that fails) is an OUTCOME, never a throw.
 */
import { describe, expect, it } from 'vitest'
import { PLATFORM_CREDENTIALS } from '@/api/services/sessions/credentials/lease'
import { PROXIED_EGRESS, SandboxInterruptedError } from '@/api/services/sessions/ports'
import { SESSION_HOME, SESSION_WORKSPACE } from '@/api/services/sessions/rocketflare-dev'
import { runtimeFor } from '@/api/services/sessions/runtimes'
import type {
  AgentRuntime,
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
  /** A conversation id this runtime accepts as a resume id. */
  resumeId: string
  /** Make `sandbox` answer this runtime's own lookups the way its container would. */
  container(sandbox: FakeSandbox): void
  /** Script the agent's next turn: it names `resumeId`, says `text`, and ends with a result. */
  scriptTurn(sandbox: FakeSandbox, turn: ScriptedTurn): void
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
  const container = () => {
    const sandbox = new FakeSandbox()
    harness.container(sandbox)
    return sandbox
  }

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
      const sandbox = container()
      const session = sessionRow(runtime, harness.resumeId)
      const content = '{"type":"conversation"}\n'
      expect(await runtime.state.restore({ session, sandbox }, content)).toBe(true)
      expect(
        await runtime.state.read(
          { session, sandbox },
          { cwd: SESSION_WORKSPACE, home: SESSION_HOME }
        )
      ).toBe(content)
    })

    it('reads nothing when there is no conversation', async () => {
      const sandbox = container()
      expect(
        await runtime.state.read(
          { session: sessionRow(runtime, null), sandbox },
          { cwd: SESSION_WORKSPACE, home: SESSION_HOME }
        )
      ).toBeNull()
    })

    it('runs a turn: its output reaches the sink, normalised, and it ends with a result', async () => {
      const sandbox = container()
      harness.scriptTurn(sandbox, { resumeId: harness.resumeId, text: 'Added the button.' })
      const sink = recordingSink()
      const outcome = await runtime.runTurn(
        turnContext(sessionRow(runtime, null), sandbox),
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
      const sandbox = container()
      const session = sessionRow(runtime, harness.resumeId)
      await runtime.state.restore({ session, sandbox }, '{"type":"conversation"}\n')
      harness.scriptTurn(sandbox, { resumeId: harness.resumeId, text: 'Again.' })
      const sink = recordingSink()
      const outcome = await runtime.runTurn(turnContext(session, sandbox), input(), sink)
      expect(outcome.result?.text).toBe('Again.')
      expect(sink.forgotten).toBe(0)
    })

    it('forgets a conversation it cannot resume, and runs the turn as a new one', async () => {
      const sandbox = container()
      harness.scriptTurn(sandbox, { resumeId: harness.resumeId, text: 'Fresh.' })
      const sink = recordingSink()
      const outcome = await runtime.runTurn(
        turnContext(sessionRow(runtime, harness.resumeId), sandbox),
        input(),
        sink
      )
      expect(sink.forgotten).toBe(1)
      expect(outcome).toMatchObject({ stop: null, failure: null })
      expect(outcome.result?.text).toBe('Fresh.')
    })

    it('stops on a Stop: `cancelled`, no throw', async () => {
      const sandbox = container()
      harness.scriptTurn(sandbox, { resumeId: harness.resumeId, text: 'Working…', hang: true })
      let asked = 0
      const outcome = await runtime.runTurn(
        turnContext(sessionRow(runtime, null), sandbox, {
          cancelRequested: async () => ++asked >= 2,
        }),
        input(),
        recordingSink()
      )
      expect(outcome.stop).toBe('cancelled')
    })

    it('stops at its timeout: `timeout`, no throw', async () => {
      const sandbox = container()
      harness.scriptTurn(sandbox, { resumeId: harness.resumeId, text: 'Working…', hang: true })
      const outcome = await runtime.runTurn(
        turnContext(sessionRow(runtime, null), sandbox, { timeoutMs: 20 }),
        input(),
        recordingSink()
      )
      expect(outcome.stop).toBe('timeout')
    })

    it('reports a replaced container as `rollout`, no throw', async () => {
      const sandbox = container()
      sandbox.failNext('startProcess', new SandboxInterruptedError())
      const outcome = await runtime.runTurn(
        turnContext(sessionRow(runtime, null), sandbox),
        input(),
        recordingSink()
      )
      expect(outcome).toMatchObject({ stop: 'rollout', result: null })
    })

    it('fails a turn that cannot start with a sentence naming the agent, no throw', async () => {
      const sandbox = container()
      sandbox.failNext('startProcess', new Error('boom'))
      const outcome = await runtime.runTurn(
        turnContext(sessionRow(runtime, null), sandbox),
        input(),
        recordingSink()
      )
      expect(outcome).toMatchObject({ stop: null, result: null, output: false })
      expect(outcome.failure).toContain(runtime.label)
    })

    it('cancels a turn nobody reads — and resolves when there is none', async () => {
      const sandbox = container()
      await expect(
        runtime.cancel({ session: sessionRow(runtime, null), sandbox })
      ).resolves.toBeUndefined()
    })
  })
}
