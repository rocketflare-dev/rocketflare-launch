/**
 * The Pi session object's logic (rocketflare-launch#14, `runtimes/pi/core.ts`) over pi-durable in
 * Node, with pi-ai's faux provider as Workers AI: a turn is one idempotent operation, its
 * transcript entries are drained by cursor and mapped onto `session_events`, the tools run in the
 * (fake) container, and the conversation round-trips through its export.
 */
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai'
import { afterEach, describe, expect, it } from 'vitest'
import type { PiDrainResult, PiTurnRequest } from '@/api/services/sessions/runtimes/pi/protocol'
import { FakeSandbox } from '../helpers/fake-sandbox'
import { checkoutReady, createFakePi, type FakePi, hangUntilAborted } from '../helpers/pi'

const open: FakePi[] = []
afterEach(async () => {
  for (const pi of open.splice(0)) await pi.close()
})

async function setup() {
  const sandbox = new FakeSandbox({ name: 'pi-core' })
  checkoutReady(sandbox)
  const pi = await createFakePi({ sandbox: () => sandbox })
  open.push(pi)
  return { sandbox, pi }
}

const request = (turn: number, over: Partial<PiTurnRequest> = {}): PiTurnRequest => ({
  sessionId: 'pi-core',
  turn,
  operationId: `pi-core:${turn}`,
  message: 'Add a button',
  model: '@cf/moonshotai/kimi-k2.7-code',
  systemNote: 'You are in a Launch session.',
  cwd: '/workspace/app',
  sandboxHost: 'local',
  fresh: turn === 1,
  ...over,
})

/** Drain until pi settles the operation, everything it produced on the way. */
async function drainAll(pi: FakePi, operationId: string) {
  let cursor = 0
  const items: PiDrainResult['items'] = []
  for (let i = 0; i < 500; i++) {
    const drained = await pi.core.drain(operationId, cursor)
    items.push(...drained.items)
    cursor = drained.items.at(-1)?.seq ?? cursor
    if (drained.settled) return { items, settled: drained.settled }
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  throw new Error('never settled')
}

describe('PiSessionCore', () => {
  it('runs a turn: text and usage drained by cursor, each entry once, then settled', async () => {
    const { pi } = await setup()
    pi.faux.setResponses([fauxAssistantMessage('Added the button.')])
    expect(await pi.core.startTurn(request(1))).toEqual({ accepted: true, resumed: false })
    const { items, settled } = await drainAll(pi, 'pi-core:1')
    expect(settled).toEqual({ status: 'done', text: 'Added the button.' })
    const events = items.flatMap(i => i.mapping.events)
    expect(events).toEqual([{ type: 'text', turn: 1, data: { text: 'Added the button.' } }])
    const usage = items.map(i => i.mapping.messageUsage).filter(Boolean)
    expect(usage).toHaveLength(1)
    expect(usage[0]).toMatchObject({ model: '@cf/moonshotai/kimi-k2.7-code' })
    expect(usage[0]?.usage.outputTokens).toBeGreaterThan(0)
    // Strictly increasing cursors; a drain after the last one brings nothing new.
    const seqs = items.map(i => i.seq)
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs)
    expect(new Set(seqs).size).toBe(seqs.length)
    expect((await pi.core.drain('pi-core:1', seqs.at(-1) ?? 0)).items).toEqual([])
  })

  it('is idempotent on the operation: a repeated startTurn submits nothing new', async () => {
    const { pi } = await setup()
    pi.faux.setResponses([fauxAssistantMessage('Once.'), fauxAssistantMessage('Twice?')])
    await pi.core.startTurn(request(1))
    expect(await pi.core.startTurn(request(1))).toMatchObject({ accepted: false })
    const { items } = await drainAll(pi, 'pi-core:1')
    expect(items.flatMap(i => i.mapping.events).map(e => e.data)).toEqual([{ text: 'Once.' }])
    expect(pi.faux.getPendingResponseCount()).toBe(1)
  })

  it('runs the tools in the container and maps them to tool.start / tool.end', async () => {
    const { pi, sandbox } = await setup()
    sandbox.files.set('/workspace/app/README.md', 'hello\nworld')
    pi.faux.setResponses([
      fauxAssistantMessage([fauxToolCall('read', { path: 'README.md' }, { id: 'call-1' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage([fauxText('It says hello.')]),
    ])
    await pi.core.startTurn(request(1))
    const { items, settled } = await drainAll(pi, 'pi-core:1')
    expect(settled?.status).toBe('done')
    const events = items.flatMap(i => i.mapping.events)
    expect(events.map(e => e.type)).toEqual(['tool.start', 'tool.end', 'text'])
    expect(events[0]?.data).toEqual({
      name: 'Read',
      input: { path: 'README.md' },
      toolCallId: 'call-1',
    })
    expect(events[1]?.data).toMatchObject({ name: 'Read', isError: false, toolCallId: 'call-1' })
    expect(String((events[1]?.data as { result?: string } | undefined)?.result)).toContain('hello')
    // Two model responses, each metered.
    expect(items.filter(i => i.mapping.messageUsage)).toHaveLength(2)
  })

  it('a later turn sees only its own entries, and says it resumed', async () => {
    const { pi } = await setup()
    pi.faux.setResponses([fauxAssistantMessage('First.'), fauxAssistantMessage('Second.')])
    await pi.core.startTurn(request(1))
    await drainAll(pi, 'pi-core:1')
    expect(await pi.core.startTurn(request(2))).toEqual({ accepted: true, resumed: true })
    const { items } = await drainAll(pi, 'pi-core:2')
    expect(items.flatMap(i => i.mapping.events)).toEqual([
      { type: 'text', turn: 2, data: { text: 'Second.' } },
    ])
  })

  it('a fresh turn on a conversation it holds starts it over', async () => {
    const { pi } = await setup()
    let seen = 0
    pi.faux.setResponses([
      fauxAssistantMessage('First.'),
      context => {
        seen = context.messages.filter(m => m.role === 'assistant').length
        return fauxAssistantMessage('New.')
      },
    ])
    await pi.core.startTurn(request(1))
    await drainAll(pi, 'pi-core:1')
    await pi.core.startTurn(request(2, { fresh: true }))
    await drainAll(pi, 'pi-core:2')
    expect(seen).toBe(0)
  })

  it('abort stops a running turn: settled unanswered, no throw', async () => {
    const { pi } = await setup()
    pi.faux.setResponses([hangUntilAborted()])
    await pi.core.startTurn(request(1))
    await new Promise(resolve => setTimeout(resolve, 20))
    await pi.core.abort()
    const { settled } = await drainAll(pi, 'pi-core:1')
    expect(settled?.status).toBe('unanswered')
  })

  it('a long-poll drain waits for news: empty after its wait, early once the turn settles', async () => {
    const { pi } = await setup()
    pi.faux.setResponses([hangUntilAborted()])
    await pi.core.startTurn(request(1))
    // Read what the turn writes up front (the person's message, pi's bookkeeping) until a long
    // poll finds nothing: the model never answers, so that one waits out its whole 300 ms.
    let cursor = 0
    let quiet: PiDrainResult | null = null
    let quietMs = 0
    for (let i = 0; i < 20 && !quiet; i++) {
      const from = Date.now()
      const drained = await pi.core.drain('pi-core:1', cursor, 300)
      cursor = drained.items.at(-1)?.seq ?? cursor
      if (drained.items.length === 0) {
        quiet = drained
        quietMs = Date.now() - from
      }
    }
    expect(quiet).toEqual({ items: [], settled: null })
    expect(quietMs).toBeGreaterThanOrEqual(250)
    // Settled while the call waits: it answers then, not at the end of its 10 s.
    const settledFrom = Date.now()
    setTimeout(() => void pi.core.abort(), 50)
    const waited = await pi.core.drain('pi-core:1', cursor, 10_000)
    expect(waited.settled?.status).toBe('unanswered')
    expect(Date.now() - settledFrom).toBeLessThan(5_000)
  })

  it('drains an operation it never started as unanswered', async () => {
    const { pi } = await setup()
    expect(await pi.core.drain('nope:1', 0)).toEqual({
      items: [],
      settled: { status: 'unanswered', reason: 'not_found' },
    })
  })

  it('round-trips the conversation through its export, and an object that holds one keeps it', async () => {
    const { pi } = await setup()
    expect(await pi.core.exportTranscript()).toBeNull()
    pi.faux.setResponses([fauxAssistantMessage('Remember 42.')])
    await pi.core.startTurn(request(1))
    await drainAll(pi, 'pi-core:1')
    const exported = await pi.core.exportTranscript()
    expect(exported).toContain('Remember 42.')

    const { pi: other } = await setup()
    expect(await other.core.importTranscript('not json')).toBe(false)
    expect(await other.core.importTranscript(exported ?? '')).toBe(true)
    expect(await other.core.exportTranscript()).toBe(exported)
    let replayed = 0
    other.faux.setResponses([
      context => {
        replayed = context.messages.filter(m => m.role === 'assistant').length
        return fauxAssistantMessage('Still 42.')
      },
    ])
    expect((await other.core.startTurn(request(2, { fresh: false }))).resumed).toBe(true)
    await drainAll(other, 'pi-core:2')
    expect(replayed).toBe(1)
    // It holds a conversation now: a second import changes nothing.
    expect(await other.core.importTranscript(exported ?? '')).toBe(true)
  })
})
