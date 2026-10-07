/**
 * The ONE input module every command shares (issue #6):
 *
 * - a body from `--data <json|@file|->` (`readDataArg`, or `readDataObject` when it must be an
 *   object) and a text from `--file <path|@path|->` (`readTextArg`), reading stdin and files
 *   through injectable seams;
 * - validation with the SAME `@launch/shared` schema the route validates with, BEFORE any request
 *   (`parseBody`: exit 1 listing every issue as `path: message`, nothing sent);
 * - the confirmation a destructive command asks for: `--yes`, or a `y` at a terminal prompt, or a
 *   refusal (exit 1) when there is neither (`confirmAction`; `confirmConsequence` states the
 *   consequence first and says "Nothing changed." on a no). Tests inject `confirm`;
 * - a secret from a hidden prompt or stdin, never argv and never echoed (`readSecret`,
 *   `promptHiddenOnTerminal`);
 * - a download streamed into a new `0600` file (`downloadToFile`).
 */
import { type FileHandle, open, readFile, rm } from 'node:fs/promises'
import { createInterface } from 'node:readline/promises'
import { InvalidArgumentError } from 'commander'
import type { z } from 'zod'
import type { DownloadResponse } from '../api'
import type { CommandContext } from '../context'
import { CliError } from '../errors'

// ---- stdin, files, --data ------------------------------------------------------------------

/** Read the whole of stdin. */
export async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

export interface InputSeams {
  /** Injected for tests: the whole of stdin. */
  readStdin?: () => Promise<string>
  /** Injected for tests: read a file. */
  readFile?: (path: string) => Promise<string>
}

/** `-` → stdin, `@path` (or, for `--file`, any path) → the file, anything else as given. */
async function readSource(
  value: string,
  options: InputSeams & { bareIsPath: boolean; label: string }
): Promise<string> {
  const read = options.readFile ?? ((p: string) => readFile(p, 'utf8'))
  if (value === '-') return (options.readStdin ?? readAllStdin)()
  const path = value.startsWith('@') ? value.slice(1) : options.bareIsPath ? value : null
  if (path === null) return value
  try {
    return await read(path)
  } catch (error) {
    const reason = (error as { code?: string }).code ?? (error as Error).message ?? String(error)
    throw new CliError(`${options.label}: cannot read ${path} (${reason})`)
  }
}

/**
 * `--data <json|@file|->` → the parsed JSON value. A parse failure is exit 1 naming the flag —
 * never echoing the text.
 */
export async function readDataArg(
  value: string,
  options: InputSeams & { label?: string } = {}
): Promise<unknown> {
  const label = options.label ?? '--data'
  const text = await readSource(value, { ...options, bareIsPath: false, label })
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new CliError(`${label} is not JSON: ${(error as Error).message}`, {
      hint: `Pass inline JSON ('{"key":"value"}'), @file.json, or - to read stdin.`,
    })
  }
}

/** `--data` that must be a JSON object; `undefined` when the flag was not given. */
export async function readDataObject(
  value: string | undefined,
  options: InputSeams & { label?: string } = {}
): Promise<Record<string, unknown> | undefined> {
  if (value === undefined) return undefined
  return asObject(await readDataArg(value, options), options.label)
}

/** `--file <path|@path|->` → the text. */
export function readTextArg(value: string, options: InputSeams & { label?: string } = {}) {
  return readSource(value, { ...options, bareIsPath: true, label: options.label ?? '--file' })
}

/** A plain JSON object (the base a flag merges into), or exit 1. */
export function asObject(value: unknown, label = '--data'): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value))
    return value as Record<string, unknown>
  throw new CliError(`${label} must be a JSON object`)
}

/** A commander parser: an integer ≥ 1, else a usage error naming the flag. */
export function positiveInt(label: string) {
  return (value: string) => {
    const n = Number(value)
    if (!Number.isInteger(n) || n < 1)
      throw new InvalidArgumentError(`${label} must be a positive integer`)
    return n
  }
}

/** A commander parser: one of `values`, else a usage error naming the flag. */
export function oneOf<T extends string>(flag: string, values: readonly T[]) {
  return (value: string): T => {
    if (!(values as readonly string[]).includes(value))
      throw new InvalidArgumentError(`${flag} must be one of ${values.join(', ')}`)
    return value as T
  }
}

/** `a,b , c` → `['a','b','c']` (a repeatable commander option). Pure. */
export function listOption(value: string, previous: string[] = []): string[] {
  return [
    ...previous,
    ...value
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
  ]
}

// ---- validation ----------------------------------------------------------------------------

/** One line per zod issue: `path: message`. Pure. */
export function issueLines(issues: readonly z.ZodIssue[]): string[] {
  return issues.map(i => `${i.path.length ? i.path.join('.') : '(body)'}: ${i.message}`)
}

/**
 * `value` checked with the route's own schema; exit 1 listing every issue, before any request.
 * `what` words the message ("Invalid flag change: …").
 */
export function parseBody<T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  value: unknown,
  what = 'request'
): T {
  const parsed = schema.safeParse(value)
  if (parsed.success) return parsed.data
  throw new CliError(`Invalid ${what}:\n  ${issueLines(parsed.error.issues).join('\n  ')}`, {
    hint: 'Nothing was sent.',
  })
}

// ---- confirmation --------------------------------------------------------------------------

/** Every destructive command's escape hatches: `--yes`, and the prompt tests inject. */
export interface ConfirmOptions {
  /** Go ahead without asking. Required when stdin is not a terminal. */
  yes?: boolean
  /** Injected for tests: answer the confirmation prompt. */
  confirm?: (question: string) => Promise<boolean>
}

/** `question [y/N]` on stderr; true for `y`/`yes`. */
export async function askOnTerminal(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim())
  } finally {
    rl.close()
  }
}

/**
 * True to go ahead: `--yes`, or a `y` on a terminal. With neither a terminal nor `--yes` it
 * REFUSES (exit 1, `refusal`) rather than guess; a "no" returns false and the caller does nothing.
 */
export async function confirmAction(
  question: string,
  options: ConfirmOptions,
  refusal = `Refusing without confirmation: ${question}`
): Promise<boolean> {
  if (options.yes) return true
  const ask = options.confirm ?? (process.stdin.isTTY ? askOnTerminal : undefined)
  if (!ask) throw new CliError(refusal, { hint: 'Re-run with --yes once you have decided.' })
  return ask(question)
}

/**
 * State the consequence (stderr), then `confirmAction`; a "no" logs "Nothing changed." and
 * returns false.
 */
export async function confirmConsequence(
  ctx: CommandContext,
  options: ConfirmOptions,
  question: string,
  consequence?: string
): Promise<boolean> {
  if (consequence) ctx.log.warn(consequence)
  if (await confirmAction(question, options)) return true
  ctx.log.info('Nothing changed.')
  return false
}

// ---- secrets -------------------------------------------------------------------------------

/**
 * Ask for one value on the terminal WITHOUT echoing it (raw mode; Enter ends, Ctrl-C rejects with
 * `cancelled`). The value is never written anywhere.
 */
export async function promptHiddenOnTerminal(
  question: string,
  cancelled = 'Cancelled — nothing was sent'
): Promise<string> {
  const stdin = process.stdin
  process.stderr.write(question)
  return new Promise<string>((resolve, reject) => {
    let value = ''
    const finish = () => {
      stdin.off('data', onData)
      stdin.setRawMode(false)
      stdin.pause()
      process.stderr.write('\n')
    }
    const onData = (chunk: Buffer | string) => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\r' || char === '\n' || char === '\u0004') {
          finish()
          resolve(value)
          return
        }
        if (char === '\u0003') {
          finish()
          reject(new CliError(cancelled))
          return
        }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1)
        else value += char
      }
    }
    stdin.setRawMode(true)
    stdin.resume()
    stdin.on('data', onData)
  })
}

export interface SecretSeams {
  /** Injected for tests: the hidden prompt. */
  promptHidden?: (question: string) => Promise<string>
  /** Injected for tests: the whole of stdin. */
  readStdin?: () => Promise<string>
  /** Injected for tests: whether stdin is a terminal. */
  isTTY?: boolean
}

/**
 * A secret from a hidden TTY prompt or, when stdin is not a terminal, from stdin (trimmed). Never
 * from argv, never echoed; an empty answer is refused.
 */
export async function readSecret(question: string, options: SecretSeams = {}): Promise<string> {
  const tty = options.isTTY ?? Boolean(process.stdin.isTTY)
  const value = tty
    ? await (options.promptHidden ?? promptHiddenOnTerminal)(question)
    : await (options.readStdin ?? readAllStdin)()
  const trimmed = value.trim()
  if (!trimmed) throw new CliError('No value given — nothing was sent')
  return trimmed
}

// ---- downloads -----------------------------------------------------------------------------

/**
 * Stream a download into a new `0600` file (`wx` unless `force`; `w` keeps an existing file's
 * mode, so it is tightened); a cut-off one is removed rather than left short. `onChunk` sees each
 * chunk as it is written (the audit export counts its lines). Returns the bytes written.
 */
export async function downloadToFile(
  download: Pick<DownloadResponse, 'body'>,
  out: string,
  force = false,
  onChunk?: (chunk: Uint8Array) => void
): Promise<number> {
  let file: FileHandle
  try {
    file = await open(out, force ? 'w' : 'wx', 0o600)
    await file.chmod(0o600)
  } catch (error) {
    const code = (error as { code?: string }).code
    throw new CliError(
      code === 'EEXIST' ? `${out} already exists` : `cannot write ${out}: ${code ?? error}`,
      { hint: code === 'EEXIST' ? 'Pass --force to replace it.' : undefined }
    )
  }
  let bytes = 0
  try {
    for await (const chunk of download.body) {
      bytes += chunk.byteLength
      onChunk?.(chunk)
      await file.write(chunk)
    }
  } catch (error) {
    await file.close()
    await rm(out, { force: true })
    throw new CliError(`the download was cut off: ${(error as Error).message ?? error}`, {
      hint: 'Nothing was kept; run it again.',
      cause: error,
    })
  }
  await file.close()
  return bytes
}
