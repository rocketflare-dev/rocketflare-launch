/**
 * `processRuntime(cli)` (rocketflare-launch#13): an `AgentRuntime` that runs each turn as ONE CLI
 * process in the session's container — `placement: 'container'`. Everything CLI-specific comes from
 * the `CliAdapter` (`claude-code/`, `codex/`); everything about driving a process — the egress
 * grant, the credential lease, starting it, reading and watching it, the resume retry, killing it
 * by pid — is `turn.ts` here, once, for every CLI.
 *
 * - `runTurn` → `runProcessTurn` (`turn.ts`).
 * - `cancel` → the turn's kill script by pid (`kill.ts`), what the salvage runs on an orphaned turn.
 * - `state` → the CLI's conversation FILE (`RuntimeStateFiles`) as a `RuntimeStateStore`: `read`
 *   locates the file and reads it, `restore` writes it back and checks it is there. The file's own
 *   members stay readable on it (`locate`, `restorePath`, `checkCommand`).
 *
 * The adapter's members stay readable on the runtime too (`claudeCodeRuntime.buildCommand`…): their
 * equivalence tests pin them there, and nothing outside `runtimes/` calls them.
 */
import type {
  AgentRuntime,
  CliAdapter,
  RuntimeContext,
  RuntimeStateFiles,
  RuntimeStateStore,
} from '../types'
import { stopOrphanedTurnProcess } from './kill'
import { runProcessTurn } from './turn'

/** A `RuntimeStateStore` over a CLI's conversation file, which it still is. */
export type ProcessStateStore = RuntimeStateStore & RuntimeStateFiles

/** What `processRuntime` returns: the runtime, with its adapter's members on it. */
export type ProcessRuntime = Omit<CliAdapter, 'state'> &
  AgentRuntime & {
    placement: 'container'
    /** The adapter it drives. */
    cli: CliAdapter
    state: ProcessStateStore
  }

/** The CLI's conversation file as a {@link RuntimeStateStore}. */
export function processStateStore(files: RuntimeStateFiles): ProcessStateStore {
  return {
    ...files,
    async read(ctx: RuntimeContext, opts: { cwd: string; home: string }) {
      const path = await files.locate(ctx.sandbox, ctx.session, opts)
      return path ? ctx.sandbox.readFile(path) : null
    },
    restorable: row => files.restorePath(row) !== null,
    async restore(ctx: RuntimeContext, content: string) {
      const path = files.restorePath(ctx.session)
      if (!path) return false
      await ctx.sandbox.writeFile(path, content)
      const check = await ctx.sandbox.exec(files.checkCommand(path), { timeoutMs: 15_000 })
      return check.exitCode === 0
    },
  }
}

export function processRuntime(cli: CliAdapter): ProcessRuntime {
  const runtime: ProcessRuntime = {
    ...cli,
    placement: 'container',
    cli,
    state: processStateStore(cli.state),
    runTurn: (ctx, input, sink) => runProcessTurn(cli, runtime, ctx, input, sink),
    cancel: ctx => stopOrphanedTurnProcess(ctx.sandbox, ctx.logger),
  }
  return runtime
}
