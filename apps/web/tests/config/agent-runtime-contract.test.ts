/**
 * The runtime contract (`tests/helpers/runtime-contract.ts`, rocketflare-launch#13), run against
 * both process runtimes and Pi (#14) — its Durable Object's logic in-process over pi-durable's
 * MemoryStorage, Workers AI faked by pi-ai's faux provider (`tests/helpers/pi.ts`).
 *
 * Pi meters every turn itself (no proxy sees its model calls), so the budget read and the usage
 * write are stubbed here: the contract has no database. `pi-runtime.test.ts` pins the metering.
 */
import { fauxAssistantMessage } from '@earendil-works/pi-ai'
import { vi } from 'vitest'
import { claudeCodeRuntime } from '@/api/services/sessions/runtimes/claude-code'
import { codexRuntime } from '@/api/services/sessions/runtimes/codex'
import { piResumeId, piRuntime } from '@/api/services/sessions/runtimes/pi'
import { claudeStreamJsonLines } from '../helpers/fake-anthropic'
import type { FakeSandbox } from '../helpers/fake-sandbox'
import { checkoutReady, createFakePi, type FakePi, hangUntilAborted } from '../helpers/pi'
import { describeRuntimeContract } from '../helpers/runtime-contract'

vi.mock('@/api/services/sessions/budget', async importOriginal => ({
  ...(await importOriginal<typeof import('@/api/services/sessions/budget')>()),
  budgetHeadroom: async () => ({
    microcents: Number.POSITIVE_INFINITY,
    scope: 'session',
    spentMicrocents: 0,
    capMicrocents: 0,
  }),
}))
vi.mock('@/api/services/sessions/turn-meter', async importOriginal => ({
  ...(await importOriginal<typeof import('@/api/services/sessions/turn-meter')>()),
  recordTurnUsage: async () => {},
}))

/** `test -s <path>`: a non-empty file in the fake container. */
function answerTestS(sandbox: FakeSandbox): void {
  sandbox.onExec(/^test -s /, command => {
    const path = command.slice('test -s '.length).trim()
    return { exitCode: sandbox.files.get(path) ? 0 : 1 }
  })
}

describeRuntimeContract({
  runtime: claudeCodeRuntime,
  resumeId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  container: answerTestS,
  scriptTurn(sandbox, turn) {
    sandbox.onProcess(/claude -p/, {
      lines: claudeStreamJsonLines({ sessionId: turn.resumeId, text: turn.text }),
      hang: turn.hang,
    })
  },
})

/** Codex finds a thread's rollout by NAME anywhere under its sessions dir (`codex/state.ts`). */
function codexRollouts(sandbox: FakeSandbox, command: string): string[] {
  const match = /find (\S+) -type f -name 'rollout-\*-([0-9a-fA-F-]+)\*\.jsonl'/.exec(command)
  if (!match) return []
  const [, dir, thread] = match
  return [...sandbox.files.entries()]
    .filter(
      ([path, content]) =>
        path.startsWith(`${dir}/`) &&
        /\/rollout-[^/]*\.jsonl$/.test(path) &&
        path.includes(thread ?? '') &&
        content.length > 0
    )
    .map(([path]) => path)
}

describeRuntimeContract({
  runtime: codexRuntime,
  resumeId: '0199a213-81c0-7800-8aa1-bbab2a035a53',
  container(sandbox) {
    answerTestS(sandbox)
    // `checkCommand`: `test -n "$(find …)"` — first, because it contains a `find` too.
    sandbox.onExec(/^test -n "\$\(find /, command => ({
      exitCode: codexRollouts(sandbox, command).length > 0 ? 0 : 1,
    }))
    sandbox.onExec(/^find /, command => ({
      stdout: codexRollouts(sandbox, command)
        .slice(0, 1)
        .map(path => `${path}\n`)
        .join(''),
    }))
  },
  scriptTurn(sandbox, turn) {
    sandbox.onProcess(/codex exec/, {
      lines: [
        JSON.stringify({ type: 'thread.started', thread_id: turn.resumeId }),
        JSON.stringify({ type: 'turn.started' }),
        JSON.stringify({
          type: 'item.completed',
          item: { id: 'item_0', type: 'agent_message', text: turn.text },
        }),
        JSON.stringify({
          type: 'turn.completed',
          usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 },
        }),
      ],
      hang: turn.hang,
    })
  },
})

/** Each contract container's Pi object (the contract makes a fresh container per test). */
const piObjects = new WeakMap<FakeSandbox, FakePi>()
const piOf = (sandbox: FakeSandbox) => {
  const pi = piObjects.get(sandbox)
  if (!pi) throw new Error('no Pi object for this container')
  return pi
}

/** A conversation as Pi's object exports it: one exchange, round-tripped through a real export. */
async function piConversation(): Promise<string> {
  const pi = await createFakePi({ sandbox: () => ({}) as never })
  await pi.core.importTranscript(
    JSON.stringify({
      format: 'launch-pi-transcript',
      version: 1,
      entries: [
        { kind: 'pi.user', model: [{ role: 'user', content: 'Remember 42.', timestamp: 1 }] },
      ],
    })
  )
  const exported = await pi.core.exportTranscript()
  await pi.close()
  if (!exported) throw new Error('no export')
  return exported
}

describeRuntimeContract({
  runtime: piRuntime,
  resumeId: piResumeId('contract-pi'),
  conversation: await piConversation(),
  async container(sandbox) {
    checkoutReady(sandbox)
    piObjects.set(sandbox, await createFakePi({ sandbox: () => sandbox }))
  },
  context: sandbox => ({ piAgent: piOf(sandbox).port }),
  scriptTurn(sandbox, turn) {
    piOf(sandbox).faux.setResponses([
      turn.hang ? hangUntilAborted() : fauxAssistantMessage(turn.text),
    ])
  },
  failNextStart: (sandbox, error) => piOf(sandbox).failNextStart(error),
  dropOutputNext: (sandbox, count) => piOf(sandbox).failDrains(count),
})
