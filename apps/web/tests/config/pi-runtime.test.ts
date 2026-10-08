/**
 * The Pi runtime's own rules (rocketflare-launch#14) beyond the shared contract
 * (`agent-runtime-contract.test.ts`): the transcript → `session_events` mapping, metering every
 * turn under `workers_ai` and stopping at the budget exactly as a self-metered CLI turn does, the
 * refusals before anything starts, and the `launch-workspace` tools over a `FakeSandbox`.
 */
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PLATFORM_CREDENTIALS } from '@/api/services/sessions/credentials/lease'
import { MODEL_KEY_PLACEHOLDER } from '@/api/services/sessions/model-key'
import { PROXIED_EGRESS, type SessionEgressPort } from '@/api/services/sessions/ports'
import { runtimeFor } from '@/api/services/sessions/runtimes'
import {
  PI_NO_IMAGES_MESSAGE,
  PI_NOT_BOUND_MESSAGE,
  piResumeId,
  piRuntime,
} from '@/api/services/sessions/runtimes/pi'
import { mapPiEntry } from '@/api/services/sessions/runtimes/pi/events'
import {
  createWorkspaceGate,
  launchWorkspaceTools,
  WORKSPACE_POLL_MS,
} from '@/api/services/sessions/runtimes/pi/workspace'
import type { TurnContext, TurnInput } from '@/api/services/sessions/runtimes/types'
import type { Database } from '@/db/client'
import type { SessionRow } from '@/db/schema'
import { FakeSandbox } from '../helpers/fake-sandbox'
import { checkoutReady, createFakePi, type FakePi, hangUntilAborted } from '../helpers/pi'
import { recordingSink } from '../helpers/runtime-contract'

const ledger = vi.hoisted(() => ({
  headroom: Number.POSITIVE_INFINITY,
  recorded: [] as { model: string; usage: unknown; opts: unknown }[],
}))

vi.mock('@/api/services/sessions/budget', async importOriginal => ({
  ...(await importOriginal<typeof import('@/api/services/sessions/budget')>()),
  budgetHeadroom: async () => ({
    microcents: ledger.headroom,
    scope: 'session',
    spentMicrocents: 1_000,
    capMicrocents: 1_000 + ledger.headroom,
  }),
}))
vi.mock('@/api/services/sessions/egress/anthropic', async importOriginal => ({
  ...(await importOriginal<typeof import('@/api/services/sessions/egress/anthropic')>()),
  recordSessionUsage: async (
    _db: unknown,
    _s: unknown,
    model: string,
    usage: unknown,
    opts: unknown
  ) => {
    ledger.recorded.push({ model, usage, opts })
  },
}))

const open: FakePi[] = []
beforeEach(() => {
  ledger.headroom = Number.POSITIVE_INFINITY
  ledger.recorded = []
})
afterEach(async () => {
  for (const pi of open.splice(0)) await pi.close()
})

async function setup() {
  const sandbox = new FakeSandbox({ name: 'pi-runtime' })
  checkoutReady(sandbox)
  const pi = await createFakePi({ sandbox: () => sandbox })
  open.push(pi)
  return { sandbox, pi }
}

const row = (over: Partial<SessionRow> = {}) =>
  ({
    id: 'pi-runtime',
    tenantId: 'tenant-pi',
    appId: 'app-pi',
    createdByUserId: 'user-pi',
    runtime: 'pi',
    credentialSource: 'platform',
    claudeSessionId: null,
    runtimeState: null,
    costMicrocents: 0,
    sandboxHost: 'local',
    ...over,
  }) as unknown as SessionRow

function ctx(
  sandbox: FakeSandbox,
  pi: FakePi | null,
  over: Partial<TurnContext> = {}
): TurnContext {
  return {
    db: {} as Database,
    session: row(),
    sandbox,
    piAgent: pi?.port ?? null,
    turn: 1,
    egress: PROXIED_EGRESS,
    credentials: PLATFORM_CREDENTIALS,
    storage: null,
    now: () => Date.now(),
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    timeoutMs: 60_000,
    flushMs: 2,
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

const input = (over: Partial<TurnInput> = {}): TurnInput => ({
  message: 'Read the README',
  model: null,
  attachments: [],
  systemNote: async () => 'You are in a Launch session.',
  ...over,
})

describe('the transcript mapping', () => {
  it('maps an assistant entry to text, tool.start and its usage — Claude Code’s tool names', () => {
    const mapping = mapPiEntry(
      {
        id: 7,
        kind: 'pi.assistant',
        model: [
          {
            role: 'assistant',
            model: '@cf/moonshotai/kimi-k2.7-code',
            content: [
              { type: 'thinking', thinking: 'hmm' },
              { type: 'text', text: `key ${MODEL_KEY_PLACEHOLDER}` },
              { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'ls' } },
            ],
            usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 0 },
            stopReason: 'toolUse',
          },
        ],
      },
      3
    )
    expect(mapping.events).toEqual([
      { type: 'text', turn: 3, data: { text: 'key [redacted]' } },
      {
        type: 'tool.start',
        turn: 3,
        data: { name: 'Bash', input: { command: 'ls' }, toolCallId: 'c1' },
      },
    ])
    expect(mapping.messageUsage).toEqual({
      id: 'pi:7',
      model: '@cf/moonshotai/kimi-k2.7-code',
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 0 },
    })
    expect(mapping.result).toBeNull()
  })

  it('maps a tool result to tool.end, a provider error to an error event, the rest to nothing', () => {
    expect(
      mapPiEntry(
        {
          id: 8,
          kind: 'pi.tool-result',
          model: [
            {
              role: 'toolResult',
              toolCallId: 'c1',
              toolName: 'grep',
              content: [{ type: 'text', text: 'a.ts:1:x' }],
              isError: true,
            },
          ],
        },
        1
      ).events
    ).toEqual([
      {
        type: 'tool.end',
        turn: 1,
        data: { name: 'Grep', result: 'a.ts:1:x', isError: true, toolCallId: 'c1' },
      },
    ])
    expect(
      mapPiEntry(
        {
          id: 9,
          kind: 'pi.assistant',
          model: [
            {
              role: 'assistant',
              content: [],
              usage: {},
              stopReason: 'error',
              errorMessage: 'Workers AI: 429',
            },
          ],
        },
        1
      ).events
    ).toEqual([{ type: 'error', turn: 1, data: { message: 'Workers AI: 429' } }])
    for (const kind of ['pi.user', 'pi.system', 'pi.reset', 'pi.compaction', 'other']) {
      expect(
        mapPiEntry({ id: 1, kind, model: [{ role: 'user', content: 'hi' }] }, 1).events
      ).toEqual([])
    }
  })
})

describe('a Pi turn', () => {
  it('is the registry’s `pi`, a Durable Object runtime on Workers AI, with no login', () => {
    expect(runtimeFor('pi')).toBe(piRuntime)
    expect(piRuntime).toMatchObject({ placement: 'durable-object', provider: 'workers_ai' })
    expect(piRuntime.login).toBeUndefined()
    expect(piRuntime.userLease).toBeUndefined()
    expect(piRuntime.workspaceFiles()).toEqual([])
  })

  it('meters every response under workers_ai and records the turn’s usage', async () => {
    const { pi, sandbox } = await setup()
    sandbox.files.set('/workspace/app/README.md', 'hello')
    pi.faux.setResponses([
      fauxAssistantMessage([fauxToolCall('read', { path: 'README.md' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage([fauxText('It says hello.')]),
    ])
    const sink = recordingSink()
    const outcome = await piRuntime.runTurn(ctx(sandbox, pi), input(), sink)
    expect(outcome).toMatchObject({ stop: null, failure: null, output: true })
    expect(outcome.result?.text).toBe('It says hello.')
    const usage = sink.mappings.flatMap(m => (m.messageUsage ? [m.messageUsage] : []))
    expect(usage).toHaveLength(2)
    expect(ledger.recorded).toHaveLength(2)
    for (const entry of ledger.recorded) {
      expect(entry.model).toBe('@cf/moonshotai/kimi-k2.7-code')
      expect(entry.opts).toEqual({
        provider: 'workers_ai',
        billing: 'metered',
        claim: expect.any(Function),
      })
    }
    expect(ledger.recorded.map(r => r.usage)).toEqual(usage.map(u => u.usage))
    const tokensOut = usage.reduce((n, u) => n + u.usage.outputTokens, 0)
    expect(outcome.result?.usage?.tokensOut).toBe(tokensOut)
    // The row learns there is a conversation, in the object.
    expect(sink.mappings[0]?.resumeId).toBe(piResumeId('pi-runtime'))
  })

  it('runs the pinned model when the policy pins one', async () => {
    const { pi, sandbox } = await setup()
    pi.faux.setResponses([fauxAssistantMessage('Done.')])
    await piRuntime.runTurn(
      ctx(sandbox, pi),
      input({ model: '@cf/zai-org/glm-5.3' }),
      recordingSink()
    )
    expect(ledger.recorded.map(r => r.model)).toEqual(['@cf/zai-org/glm-5.3'])
  })

  it('stops at the budget: `budget.reached`, the object aborted, what it spent still recorded', async () => {
    const { pi, sandbox } = await setup()
    ledger.headroom = 1
    pi.faux.setResponses([
      fauxAssistantMessage([fauxToolCall('read', { path: 'README.md' })], {
        stopReason: 'toolUse',
      }),
      hangUntilAborted(),
    ])
    const sink = recordingSink()
    const outcome = await piRuntime.runTurn(ctx(sandbox, pi), input(), sink)
    expect(outcome.stop).toBeNull()
    expect(outcome.result).toBeNull()
    expect(outcome.failure).toBe(
      'This turn was stopped: the session reached its budget. Ask an app owner to extend it.'
    )
    expect(sink.appended).toEqual([
      expect.objectContaining({
        type: 'budget.reached',
        turn: 1,
        data: expect.objectContaining({ scope: 'session' }),
      }),
    ])
    expect(pi.calls).toContain('abort')
    expect(ledger.recorded.length).toBeGreaterThanOrEqual(1)
  })

  it('refuses images, and a Worker with no Pi object, before anything starts', async () => {
    const { pi, sandbox } = await setup()
    const images = await piRuntime.runTurn(
      ctx(sandbox, pi),
      input({
        attachments: [{ id: 'a', name: 'a.png', contentType: 'image/png', size: 1 }] as never,
      }),
      recordingSink()
    )
    expect(images).toMatchObject({ failure: PI_NO_IMAGES_MESSAGE, output: false })
    const unbound = await piRuntime.runTurn(ctx(sandbox, null), input(), recordingSink())
    expect(unbound).toMatchObject({ failure: PI_NOT_BOUND_MESSAGE, output: false })
    expect(pi.calls).toEqual([])
  })

  it('grants git through the egress (a remote sandbox) but never a model credential', async () => {
    const { pi, sandbox } = await setup()
    pi.faux.setResponses([fauxAssistantMessage('Done.')])
    const asked: string[] = []
    const egress: SessionEgressPort = {
      mode: 'host',
      turnEnv: async () => {
        asked.push('turnEnv')
        return {}
      },
      prepareGit: async () => {
        asked.push('prepareGit')
      },
    }
    await piRuntime.runTurn(ctx(sandbox, pi, { egress }), input(), recordingSink())
    expect(asked).toEqual(['prepareGit'])
  })

  it('its checkpoint copy and restore go through the object', async () => {
    const { pi, sandbox } = await setup()
    pi.faux.setResponses([fauxAssistantMessage('Remember 42.')])
    await piRuntime.runTurn(ctx(sandbox, pi), input(), recordingSink())
    const session = row({ claudeSessionId: piResumeId('pi-runtime') })
    const opts = { cwd: '/workspace/app', home: '/root' }
    const saved = await piRuntime.state.read({ session, sandbox, piAgent: pi.port }, opts)
    expect(saved).toContain('Remember 42.')
    expect(piRuntime.state.key('pi-runtime')).toBe('sessions/pi-runtime/pi.json')
    expect(piRuntime.state.restorable(session)).toBe(true)
    expect(piRuntime.state.restorable(row({ claudeSessionId: 'pi:someone-else' }))).toBe(false)
    expect(await piRuntime.state.read({ session, sandbox }, opts)).toBeNull()
  })
})

describe('the launch-workspace tools', () => {
  const signal = () => ({ abortSignal: new AbortController().signal }) as never

  function tools(sandbox: FakeSandbox, sleep?: (ms: number) => Promise<void>) {
    const host = { sandbox: () => sandbox, cwd: () => '/workspace/app', sleep }
    const list = launchWorkspaceTools(host, createWorkspaceGate(host))
    const by = (name: string) => {
      const tool = list.find(t => t.name === name)
      if (!tool) throw new Error(name)
      return (args: unknown, context = signal()) =>
        tool.execute(args as never, {} as never, context) as Promise<{
          content: { text: string }[]
          isError?: boolean
        }>
    }
    return { list, by }
  }
  const textOf = (r: { content: { text: string }[] }) => r.content.map(c => c.text).join('')

  it('are five, one at a time, and only the read-only ones replay', () => {
    const { list } = tools(new FakeSandbox())
    expect(list.map(t => [t.name, t.replay, t.executionMode])).toEqual([
      ['bash', 'unsafe', 'sequential'],
      ['read', 'safe', 'sequential'],
      ['write', 'unsafe', 'sequential'],
      ['edit', 'unsafe', 'sequential'],
      ['grep', 'safe', 'sequential'],
    ])
  })

  it('wait for the checkout before running, polling — and stop waiting on abort', async () => {
    const sandbox = new FakeSandbox()
    let probes = 0
    sandbox.onExec(/^test -d /, () => ({ exitCode: ++probes >= 3 ? 0 : 1 }))
    sandbox.files.set('/workspace/app/a.txt', 'one')
    const waits: number[] = []
    const { by } = tools(sandbox, async ms => {
      waits.push(ms)
    })
    expect(textOf(await by('read')({ path: 'a.txt' }))).toContain('one')
    expect(probes).toBe(3)
    expect(waits).toEqual([WORKSPACE_POLL_MS, WORKSPACE_POLL_MS])
    // Once seen, never asked again.
    await by('read')({ path: 'a.txt' })
    expect(probes).toBe(3)

    const notYet = new FakeSandbox()
    notYet.onExec(/^test -d /, { exitCode: 1 })
    const controller = new AbortController()
    const pending = tools(notYet).by('read')({ path: 'a.txt' }, {
      abortSignal: controller.signal,
    } as never)
    controller.abort()
    await expect(pending).rejects.toThrow('stopped')
  })

  it('bash runs in the checkout under a timeout, and refuses git push', async () => {
    const sandbox = new FakeSandbox()
    checkoutReady(sandbox)
    sandbox.onProcess(/pnpm test/, { lines: ['1 passed'], exitCode: 0 })
    sandbox.onProcess(/false/, { lines: ['nope'], exitCode: 2 })
    const { by } = tools(sandbox)
    expect(textOf(await by('bash')({ command: 'pnpm test' }))).toBe('1 passed')
    const started = sandbox.processes.at(-1)
    expect(started?.command).toMatch(/^timeout --signal=KILL 600 bash -c 'pnpm test'$/)
    expect(started?.opts?.cwd).toBe('/workspace/app')
    const failed = await by('bash')({ command: 'false' })
    expect(failed.isError).toBe(true)
    expect(textOf(failed)).toContain('[exit code 2]')
    for (const command of ['git push', 'cd x && git push origin main', 'git -C . push']) {
      const refused = await by('bash')({ command })
      expect(refused.isError, command).toBe(true)
      expect(textOf(refused)).toContain('Launch')
    }
    expect(sandbox.processes).toHaveLength(2)
  })

  it('bash kills its process on abort', async () => {
    const sandbox = new FakeSandbox()
    checkoutReady(sandbox)
    sandbox.onProcess(/sleep/, { lines: ['…'], hang: true })
    const controller = new AbortController()
    const run = tools(sandbox).by('bash')({ command: 'sleep 999' }, {
      abortSignal: controller.signal,
    } as never)
    await new Promise(resolve => setTimeout(resolve, 10))
    controller.abort()
    await expect(run).rejects.toThrow('stopped')
    expect(sandbox.killed).toHaveLength(1)
  })

  it('edit replaces exactly one match, and says why when it cannot', async () => {
    const sandbox = new FakeSandbox()
    checkoutReady(sandbox)
    sandbox.files.set('/workspace/app/a.ts', 'const a = 1\nconst b = 1\n')
    const edit = tools(sandbox).by('edit')
    expect((await edit({ path: 'a.ts', oldText: '= 1', newText: '= 2' })).isError).toBe(true)
    expect((await edit({ path: 'a.ts', oldText: 'zzz', newText: 'y' })).isError).toBe(true)
    expect((await edit({ path: 'gone.ts', oldText: 'a', newText: 'b' })).isError).toBe(true)
    await edit({ path: 'a.ts', oldText: 'const a = 1', newText: 'const a = $&2' })
    expect(sandbox.files.get('/workspace/app/a.ts')).toBe('const a = $&2\nconst b = 1\n')
    await edit({ path: 'a.ts', oldText: '1', newText: '3', replaceAll: true })
    expect(sandbox.files.get('/workspace/app/a.ts')).toBe('const a = $&2\nconst b = 3\n')
  })

  it('write makes the directory; read numbers lines and windows a long file; grep is bounded', async () => {
    const sandbox = new FakeSandbox()
    checkoutReady(sandbox)
    sandbox.onExec(/rg --line-number/, { stdout: 'src/a.ts:1:hit\n' })
    const { by } = tools(sandbox)
    await by('write')({ path: 'src/new.ts', content: 'x\ny' })
    expect(sandbox.files.get('/workspace/app/src/new.ts')).toBe('x\ny')
    expect(sandbox.commands).toContain("mkdir -p '/workspace/app/src'")
    sandbox.files.set(
      '/workspace/app/long.txt',
      Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join('\n')
    )
    const window = textOf(await by('read')({ path: 'long.txt', offset: 3, limit: 2 }))
    expect(window).toContain('     3\tl3')
    expect(window).toContain('     4\tl4')
    expect(window).not.toContain('l5')
    expect(window).toContain('lines 5–10 not shown')
    expect(textOf(await by('grep')({ pattern: 'hit' }))).toBe('src/a.ts:1:hit')
  })
})
