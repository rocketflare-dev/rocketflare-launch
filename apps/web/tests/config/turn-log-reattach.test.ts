/**
 * `reattachingLogs` (`runtimes/process/logs.ts`) against a port shaped like the Sandbox SDK 0.12.10:
 * every attach replays the process's accumulated stdout as ONE chunk (and its stderr), then the
 * live chunks — so a re-attach must skip, by characters and mid-line, exactly what was read.
 */
import { describe, expect, it } from 'vitest'
import {
  SandboxInterruptedError,
  type SandboxLogEvent,
  type SandboxPort,
} from '@/api/services/sessions/ports'
import { turnAliveScript } from '@/api/services/sessions/runtimes/process/kill'
import { reattachingLogs } from '@/api/services/sessions/runtimes/process/logs'

type Attach = () => AsyncIterable<SandboxLogEvent>

/** A port whose n-th `streamLogs` is `attaches[n]`, and whose liveness answer is `alive`. */
function port(attaches: Attach[], alive: () => string = () => 'alive\n') {
  const asked: string[] = []
  let n = 0
  const sandbox = {
    streamLogs: () => {
      const next = attaches[n++]
      if (!next) throw new Error('no more attaches scripted')
      return next()
    },
    exec: async (command: string) => {
      asked.push(command)
      return { exitCode: 0, stdout: alive(), stderr: '' }
    },
  } as unknown as SandboxPort
  return { sandbox, asked, attaches: () => n }
}

async function* events(list: SandboxLogEvent[], then?: Error): AsyncIterable<SandboxLogEvent> {
  for (const event of list) yield event
  if (then) throw then
}

const out = (data: string): SandboxLogEvent => ({ type: 'stdout', data })
const err = (data: string): SandboxLogEvent => ({ type: 'stderr', data })
const exit = (exitCode = 0): SandboxLogEvent => ({ type: 'exit', exitCode })
const dropped = () => new Error('Network connection lost')

async function read(sandbox: SandboxPort, over: { maxReattaches?: number } = {}) {
  const seen: SandboxLogEvent[] = []
  const counts: number[] = []
  for await (const event of reattachingLogs(sandbox, 'proc-1', {
    ...over,
    signal: new AbortController().signal,
    sleep: async () => {},
    probeCallMs: 1_000,
    sessionId: 's',
    onReattach: count => counts.push(count),
  })) {
    seen.push(event)
  }
  return { seen, counts }
}

const stdoutOf = (seen: SandboxLogEvent[]) =>
  seen.map(e => (e.type === 'stdout' ? e.data : '')).join('')

describe('reattachingLogs', () => {
  it('skips the replayed output by characters, mid-line, and hands on the rest once', async () => {
    const { sandbox, asked } = port([
      () => events([out('{"a":1}\n{"b"'), err('warn: x')], dropped()),
      () => events([out('{"a":1}\n{"b":2}\n'), err('warn: xy'), out('{"c":"é"}\n'), exit(0)]),
    ])
    const { seen, counts } = await read(sandbox)
    expect(stdoutOf(seen)).toBe('{"a":1}\n{"b":2}\n{"c":"é"}\n')
    expect(
      seen.filter(e => e.type === 'stderr').map(e => (e.type === 'stderr' ? e.data : ''))
    ).toEqual(['warn: x', 'y'])
    expect(seen.at(-1)).toEqual(exit(0))
    expect(counts).toEqual([1])
    expect(asked).toEqual([turnAliveScript()])
  })

  it('re-attaches to a process that ended meanwhile: its last output and its exit', async () => {
    const { sandbox } = port(
      [() => events([out('one\n')], dropped()), () => events([out('one\ntwo\n'), exit(3)])],
      () => 'exited\n'
    )
    const { seen } = await read(sandbox)
    expect(stdoutOf(seen)).toBe('one\ntwo\n')
    expect(seen.at(-1)).toEqual(exit(3))
  })

  it('a process gone with its record: one try, then the stream’s error', async () => {
    const { sandbox, attaches } = port(
      [
        () => events([out('one\n')], dropped()),
        () => events([], new Error('Process not found')),
        () => events([exit(0)]),
      ],
      () => 'exited\n'
    )
    await expect(read(sandbox)).rejects.toThrow('Process not found')
    expect(attaches()).toBe(2)
  })

  it('gives up after its re-attaches with the last error', async () => {
    const { sandbox, asked } = port(Array(10).fill(() => events([], dropped())))
    await expect(read(sandbox, { maxReattaches: 2 })).rejects.toThrow('Network connection lost')
    expect(asked).toHaveLength(2)
  })

  it('a container that does not answer: no re-attach, the stream’s error', async () => {
    const { sandbox, attaches } = port([() => events([], dropped())], () => '')
    await expect(read(sandbox)).rejects.toThrow('Network connection lost')
    expect(attaches()).toBe(1)
  })

  it('a stream that only ended early, and cannot be re-attached, ends as it always did', async () => {
    const { sandbox } = port([() => events([out('one\n')])], () => '')
    const { seen } = await read(sandbox)
    expect(seen).toEqual([out('one\n')])
  })

  it('a replaced container is thrown at once, never re-attached', async () => {
    const { sandbox, asked } = port([() => events([], new SandboxInterruptedError())])
    await expect(read(sandbox)).rejects.toBeInstanceOf(SandboxInterruptedError)
    expect(asked).toEqual([])
  })

  it('a reader stopped during the wait never asks and never attaches again', async () => {
    const reader = new AbortController()
    const { sandbox, asked, attaches } = port([() => events([], dropped()), () => events([exit()])])
    const seen: SandboxLogEvent[] = []
    for await (const event of reattachingLogs(sandbox, 'proc-1', {
      signal: reader.signal,
      // The Stop lands while it waits; the sleep itself never ends.
      sleep: () => {
        reader.abort()
        return new Promise<void>(() => {})
      },
      probeCallMs: 1_000,
      sessionId: 's',
    })) {
      seen.push(event)
    }
    expect(seen).toEqual([])
    expect(asked).toEqual([])
    expect(attaches()).toBe(1)
  })
})
