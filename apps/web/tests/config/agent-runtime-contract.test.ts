/**
 * The runtime contract (`tests/helpers/runtime-contract.ts`, rocketflare-launch#13), run against
 * both process runtimes. A runtime added later (Pi on a Durable Object, #14) adds a harness here.
 */
import { claudeCodeRuntime } from '@/api/services/sessions/runtimes/claude-code'
import { codexRuntime } from '@/api/services/sessions/runtimes/codex'
import { claudeStreamJsonLines } from '../helpers/fake-anthropic'
import type { FakeSandbox } from '../helpers/fake-sandbox'
import { describeRuntimeContract } from '../helpers/runtime-contract'

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
