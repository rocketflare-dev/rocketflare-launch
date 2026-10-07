/**
 * The `launch-workspace` pi extension (rocketflare-launch#14): the five tools a Pi session's agent
 * works with — `bash`, `read`, `write`, `edit`, `grep` — over the session's container through
 * `SandboxPort`, exactly as every other step reaches it. The agent loop runs in a Durable Object;
 * the work runs in the container, so its egress allow-list, its placeholder-only environment and
 * the git proxy's branch rule hold for Pi as they do for Claude Code.
 *
 * - **The workspace may not be ready yet.** A tool call first waits, bounded and abortable, for the
 *   checkout (`<cwd>/.git`) to exist — one cheap `test -d` once it does ({@link WORKSPACE_WAIT_MS}).
 * - **One call at a time.** pi runs a round's tool calls in parallel by default; every tool here is
 *   `executionMode: 'sequential'`, so a `bash` never races the `write` before it.
 * - **Replay.** `read` and `grep` may re-run after an eviction (`replay: 'safe'`); `bash`, `write`
 *   and `edit` may not (`'unsafe'`): pi fails an interrupted one rather than run it twice.
 * - **Abort.** Every tool honours pi's abort signal: the wait stops, and `bash` kills its process.
 * - **Pushing is Launch's job**, as for Claude Code (`CLAUDE_DISALLOWED_TOOLS`): `bash` refuses
 *   `git push`; the checkpoint pushes after the turn.
 * - **Output is bounded** (`PI_TOOL_OUTPUT_MAX_CHARS`…): the model gets the tail of a long command,
 *   a window of a long file, the first matches of a wide search — and is told what was cut.
 */
import { Type } from '@earendil-works/pi-ai'
import type { ToolRegistration } from '@earendil-works/pi-durable'
import { shellQuote } from '../../claude-stream'
import type { SandboxPort } from '../../ports'
import { sessionSharedEnv } from '../../rocketflare-dev'

/** The extension's name in pi's registry. */
export const LAUNCH_WORKSPACE_EXTENSION = 'launch-workspace'

/** Longest a tool call waits for the checkout to appear before it fails, saying so. */
export const WORKSPACE_WAIT_MS = 10 * 60_000
/** How often it looks. */
export const WORKSPACE_POLL_MS = 2_000
/** `bash`'s default and longest run. */
export const PI_BASH_DEFAULT_TIMEOUT_S = 600
export const PI_BASH_MAX_TIMEOUT_S = 1_800
/** The most of a command's output the model gets back (the tail). */
export const PI_TOOL_OUTPUT_MAX_CHARS = 30_000
/** `read`'s window. */
export const PI_READ_MAX_LINES = 2_000
export const PI_READ_MAX_CHARS = 60_000
/** `grep`'s match cap. */
export const PI_GREP_MAX_LINES = 200

/** What the extension needs of the object hosting it. */
export interface PiWorkspaceHost {
  /** The session's container (`ports.sandbox(sessionId)` for the turn in progress). */
  sandbox(): SandboxPort
  /** The checkout the tools run in. */
  cwd(): string
  /** Waits between readiness checks; tests pass a fast one. */
  sleep?(ms: number, signal?: AbortSignal): Promise<void>
}

/** A tool's `ToolExecutionResult` for text. */
const text = (value: string, isError = false) => ({
  content: [{ type: 'text' as const, text: value }],
  ...(isError ? { isError: true } : {}),
})

/** Thrown into pi when its abort signal fired mid-call. */
class ToolAbortedError extends Error {
  constructor() {
    super('The tool call was stopped')
    this.name = 'AbortError'
  }
}

const throwIfAborted = (signal: AbortSignal | undefined) => {
  if (signal?.aborted) throw new ToolAbortedError()
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ToolAbortedError())
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new ToolAbortedError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Keep the LAST `max` characters, saying how much went. */
export function tailClip(value: string, max = PI_TOOL_OUTPUT_MAX_CHARS): string {
  return value.length > max
    ? `[${value.length - max} earlier characters cut]\n${value.slice(-max)}`
    : value
}

/** A path the model gave, absolute against the checkout. */
export function resolvePath(cwd: string, path: string): string {
  if (path.startsWith('/')) return path
  const rel = path.replace(/^\.\//, '')
  return rel ? `${cwd.replace(/\/$/, '')}/${rel}` : cwd
}

/** `git push` in a command: Launch pushes, the agent does not. */
const GIT_PUSH_RE = /(^|[;&|(\s`])git(\s+-[^\s]+(\s+[^\s-][^\s]*)?)*\s+push\b/

/**
 * Wait until the checkout exists: once per host until it is seen, then never again (a container
 * that dies under the session is the turn's liveness probe's business, not the tools').
 */
export function createWorkspaceGate(host: PiWorkspaceHost) {
  let ready = false
  const sleep = host.sleep ?? abortableSleep
  return {
    reset() {
      ready = false
    },
    async wait(signal: AbortSignal | undefined): Promise<void> {
      if (ready) return
      const deadline = Date.now() + WORKSPACE_WAIT_MS
      for (;;) {
        throwIfAborted(signal)
        const probe = await host
          .sandbox()
          .exec(`test -d ${shellQuote(`${host.cwd()}/.git`)}`, { timeoutMs: 15_000 })
          .catch(() => null)
        if (probe?.exitCode === 0) {
          ready = true
          return
        }
        if (Date.now() >= deadline) {
          throw new Error(
            'The session workspace is not ready yet (the repository has not been cloned). Try again shortly.'
          )
        }
        await sleep(WORKSPACE_POLL_MS, signal)
      }
    },
  }
}

export type WorkspaceGate = ReturnType<typeof createWorkspaceGate>

/** The `bash` tool: one command in the checkout, its process killed on abort or timeout. */
async function runBash(
  host: PiWorkspaceHost,
  command: string,
  timeoutSeconds: number,
  signal: AbortSignal | undefined
) {
  if (GIT_PUSH_RE.test(command)) {
    return text(
      'Pushing is Launch’s job: it commits and pushes the session branch after every turn. Do not run git push.',
      true
    )
  }
  const sandbox = host.sandbox()
  const seconds = Math.min(Math.max(1, Math.round(timeoutSeconds)), PI_BASH_MAX_TIMEOUT_S)
  const proc = await sandbox.startProcess(
    `timeout --signal=KILL ${seconds} bash -c ${shellQuote(command)}`,
    { cwd: host.cwd(), env: sessionSharedEnv() }
  )
  const reader = new AbortController()
  const onAbort = () => reader.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  let output = ''
  let exitCode: number | null = null
  try {
    for await (const event of sandbox.streamLogs(proc.id, { signal: reader.signal })) {
      if (event.type === 'exit') exitCode = event.exitCode
      else output = tailClip(output + event.data, PI_TOOL_OUTPUT_MAX_CHARS * 2)
    }
  } catch (err) {
    if (!signal?.aborted) throw err
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
  if (signal?.aborted) {
    await sandbox.kill(proc.id, 'SIGKILL').catch(() => {})
    throw new ToolAbortedError()
  }
  const body = tailClip(output.trimEnd()) || '(no output)'
  if (exitCode === 137) {
    return text(`${body}\n\n[stopped after ${seconds}s: the command timed out]`, true)
  }
  return exitCode === 0 ? text(body) : text(`${body}\n\n[exit code ${exitCode ?? 'unknown'}]`, true)
}

/** The extension's tools, bound to the host. */
export function launchWorkspaceTools(host: PiWorkspaceHost, gate: WorkspaceGate) {
  const ready = async (signal: AbortSignal | undefined) => {
    await gate.wait(signal)
    throwIfAborted(signal)
  }

  const bash: ToolRegistration = {
    name: 'bash',
    description:
      'Run a shell command (bash) in the session checkout and return its combined output. Use it to run tests, builds, git (status, diff, log, commit), package managers and anything else. Long output keeps its last part. Do not push: Launch pushes after every turn.',
    parameters: Type.Object({
      command: Type.String({ description: 'The command to run, as you would type it in bash.' }),
      timeout: Type.Optional(
        Type.Number({
          description: `Seconds before it is killed (default ${PI_BASH_DEFAULT_TIMEOUT_S}, at most ${PI_BASH_MAX_TIMEOUT_S}).`,
        })
      ),
    }),
    replay: 'unsafe',
    executionMode: 'sequential',
    async execute(args, _api, context) {
      const { command, timeout } = args as { command: string; timeout?: number }
      await ready(context.abortSignal)
      return runBash(host, command, timeout ?? PI_BASH_DEFAULT_TIMEOUT_S, context.abortSignal)
    },
  }

  const read: ToolRegistration = {
    name: 'read',
    description: `Read a text file, with line numbers. Paths are relative to the checkout or absolute. Returns at most ${PI_READ_MAX_LINES} lines from \`offset\` (1-based).`,
    parameters: Type.Object({
      path: Type.String({ description: 'The file to read.' }),
      offset: Type.Optional(Type.Number({ description: 'First line to return (1-based).' })),
      limit: Type.Optional(Type.Number({ description: 'How many lines to return.' })),
    }),
    replay: 'safe',
    executionMode: 'sequential',
    async execute(args, _api, context) {
      const { path, offset, limit } = args as { path: string; offset?: number; limit?: number }
      await ready(context.abortSignal)
      const file = resolvePath(host.cwd(), path)
      const content = await host.sandbox().readFile(file)
      if (content === null) return text(`No such file: ${file}`, true)
      const lines = content.split('\n')
      const start = Math.max(1, Math.floor(offset ?? 1))
      const count = Math.min(PI_READ_MAX_LINES, Math.max(1, Math.floor(limit ?? PI_READ_MAX_LINES)))
      const window = lines.slice(start - 1, start - 1 + count)
      let body = window.map((line, i) => `${String(start + i).padStart(6)}\t${line}`).join('\n')
      if (body.length > PI_READ_MAX_CHARS) body = `${body.slice(0, PI_READ_MAX_CHARS)}\n[cut]`
      const end = start - 1 + window.length
      const more =
        end < lines.length ? `\n[lines ${end + 1}–${lines.length} not shown; use offset]` : ''
      return text((body || '(empty file)') + more)
    },
  }

  const write: ToolRegistration = {
    name: 'write',
    description:
      'Write a whole file (created, or replaced), making its directory. Prefer edit for a change to an existing file.',
    parameters: Type.Object({
      path: Type.String({ description: 'The file to write.' }),
      content: Type.String({ description: 'Its complete new content.' }),
    }),
    replay: 'unsafe',
    executionMode: 'sequential',
    async execute(args, _api, context) {
      const { path, content } = args as { path: string; content: string }
      await ready(context.abortSignal)
      const file = resolvePath(host.cwd(), path)
      const dir = file.slice(0, file.lastIndexOf('/')) || '/'
      const sandbox = host.sandbox()
      await sandbox.exec(`mkdir -p ${shellQuote(dir)}`, { timeoutMs: 15_000 })
      await sandbox.writeFile(file, content)
      return text(`Wrote ${file} (${content.split('\n').length} lines)`)
    },
  }

  const edit: ToolRegistration = {
    name: 'edit',
    description:
      'Replace exact text in a file. `oldText` must match the file exactly (whitespace included) and only once, unless `replaceAll` is set. Read the file first.',
    parameters: Type.Object({
      path: Type.String({ description: 'The file to change.' }),
      oldText: Type.String({ description: 'The exact text to replace.' }),
      newText: Type.String({ description: 'What replaces it.' }),
      replaceAll: Type.Optional(Type.Boolean({ description: 'Replace every occurrence.' })),
    }),
    replay: 'unsafe',
    executionMode: 'sequential',
    async execute(args, _api, context) {
      const { path, oldText, newText, replaceAll } = args as {
        path: string
        oldText: string
        newText: string
        replaceAll?: boolean
      }
      await ready(context.abortSignal)
      const file = resolvePath(host.cwd(), path)
      const sandbox = host.sandbox()
      const content = await sandbox.readFile(file)
      if (content === null) return text(`No such file: ${file}`, true)
      if (!oldText) return text('oldText is empty: use write to create a file.', true)
      const count = content.split(oldText).length - 1
      if (count === 0) return text(`oldText was not found in ${file}. Read it again.`, true)
      if (count > 1 && !replaceAll) {
        return text(
          `oldText occurs ${count} times in ${file}: add context to make it unique, or set replaceAll.`,
          true
        )
      }
      const next = replaceAll
        ? content.split(oldText).join(newText)
        : content.replace(oldText, () => newText)
      await sandbox.writeFile(file, next)
      return text(`Edited ${file} (${replaceAll ? count : 1} replacement${count > 1 ? 's' : ''})`)
    },
  }

  const grep: ToolRegistration = {
    name: 'grep',
    description: `Search file contents with a regular expression (ripgrep syntax; git-ignored files and node_modules skipped). Returns up to ${PI_GREP_MAX_LINES} matching lines as path:line:text.`,
    parameters: Type.Object({
      pattern: Type.String({ description: 'The regular expression.' }),
      path: Type.Optional(
        Type.String({ description: 'A file or directory (default: the checkout).' })
      ),
      glob: Type.Optional(Type.String({ description: 'Only files matching this glob, e.g. *.ts' })),
    }),
    replay: 'safe',
    executionMode: 'sequential',
    async execute(args, _api, context) {
      const { pattern, path, glob } = args as { pattern: string; path?: string; glob?: string }
      await ready(context.abortSignal)
      const where = shellQuote(resolvePath(host.cwd(), path ?? '.'))
      const p = shellQuote(pattern)
      const rg = `rg --line-number --no-heading --color=never${glob ? ` --glob ${shellQuote(glob)}` : ''} -e ${p} -- ${where}`
      const fallback = `grep -rnE --exclude-dir=.git --exclude-dir=node_modules${glob ? ` --include=${shellQuote(glob)}` : ''} -e ${p} -- ${where}`
      const result = await host
        .sandbox()
        .exec(
          `{ if command -v rg >/dev/null 2>&1; then ${rg}; else ${fallback}; fi; } | head -n ${PI_GREP_MAX_LINES + 1}`,
          { cwd: host.cwd(), timeoutMs: 60_000 }
        )
      const lines = result.stdout.split('\n').filter(Boolean)
      if (lines.length === 0) return text('No matches.')
      const shown = lines.slice(0, PI_GREP_MAX_LINES).join('\n')
      return text(
        tailClip(shown) +
          (lines.length > PI_GREP_MAX_LINES ? `\n[more than ${PI_GREP_MAX_LINES} matches]` : '')
      )
    },
  }

  return [bash, read, write, edit, grep]
}

/** The system section every Pi request carries before the session's own instructions. */
export function workspacePreamble(cwd: string): string {
  return [
    'You are a coding agent working in a git checkout of an app, inside a sandboxed container.',
    `The checkout is ${cwd}; relative paths are resolved against it.`,
    'Use the tools to inspect and change the code: read files before editing them, prefer edit for small changes, and run the app’s own checks (tests, typecheck, lint) with bash when you have changed something.',
    'Launch commits and pushes your work after every turn: never run git push. Finish with a short summary of what you did.',
  ].join('\n')
}

/** The `launch-workspace` extension: the preamble section and the five tools. */
export function launchWorkspaceExtension(host: PiWorkspaceHost, gate: WorkspaceGate) {
  return {
    name: LAUNCH_WORKSPACE_EXTENSION,
    sections: [
      {
        key: 'launch-workspace',
        render: () => workspacePreamble(host.cwd()),
      },
    ],
    tools: launchWorkspaceTools(host, gate),
  }
}
