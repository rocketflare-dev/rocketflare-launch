/**
 * The runtime seam's equivalence (§18.22): Claude Code as an `AgentRuntime` is the P3 behaviour
 * byte for byte — the same command, the same environment, the same parsed events (the resume id
 * is `claudeSessionId` under its generic name), the same workspace file, and the same transcript
 * paths the checkpoint and restore always used. If any of these drift, every existing session
 * changes; this file is what says so.
 */
import { describe, expect, it } from 'vitest'
import {
  buildClaudeCommand,
  claudeTurnEnv,
  createClaudeStreamParser,
} from '@/api/services/sessions/claude-stream'
import {
  CLAUDE_PROJECT_DIR,
  claudeSettingsLocal,
  claudeTranscriptPath,
  SESSION_HOME,
  SESSION_WORKSPACE,
} from '@/api/services/sessions/rocketflare-dev'
import { resumeIdOf, runtimeFor, runtimeOf } from '@/api/services/sessions/runtimes'
import { claudeCodeRuntime } from '@/api/services/sessions/runtimes/claude-code'
import { codexRuntime } from '@/api/services/sessions/runtimes/codex'
import { transcriptCheckCommand } from '@/api/services/sessions/turn'
import type { SessionRow } from '@/db/schema'
import { claudeStreamJson } from '../helpers/fake-anthropic'
import { FakeSandbox } from '../helpers/fake-sandbox'

const row = (claudeSessionId: string | null) =>
  ({ id: 's1', runtime: 'claude_code', claudeSessionId }) as unknown as SessionRow

describe('the registry', () => {
  it('a row without a runtime — and every row the migration defaulted — is Claude Code', () => {
    expect(runtimeOf({})).toBe(claudeCodeRuntime)
    expect(runtimeOf({ runtime: 'claude_code' })).toBe(claudeCodeRuntime)
    expect(runtimeFor(null)).toBe(claudeCodeRuntime)
    expect(runtimeOf({ runtime: 'codex' })).toBe(codexRuntime)
    expect(resumeIdOf(row('abc'))).toBe('abc')
  })
})

describe('Claude Code through the seam is the P3 turn, byte for byte', () => {
  const input = {
    message: "Fix the header's colour",
    model: 'claude-sonnet-4-5',
    resumeId: 'b6f3c0de-1111-2222-3333-444455556666',
    systemNote: 'You are in a Launch session.',
  }

  it('the command', () => {
    expect(claudeCodeRuntime.buildCommand(input)).toBe(
      buildClaudeCommand({
        message: input.message,
        model: input.model,
        resumeSessionId: input.resumeId,
        systemNote: input.systemNote,
      })
    )
    expect(claudeCodeRuntime.buildCommand({ message: 'hi', model: 'claude-sonnet-4-5' })).toBe(
      buildClaudeCommand({ message: 'hi', model: 'claude-sonnet-4-5' })
    )
  })

  it('the environment, on Launch’s key', () => {
    expect(claudeCodeRuntime.turnEnv({ model: input.model, source: 'platform' })).toEqual(
      claudeTurnEnv(input.model)
    )
  })

  it('the parsed events, with the session id as the resume id', () => {
    const script = claudeStreamJson({
      sessionId: 'claude-sess-9',
      tools: [{ name: 'Read', input: { file_path: 'a.ts' }, result: 'x' }],
      text: 'Done.',
      usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
    })
    const raw = script.lines.map(line => `${line}\n`).join('')
    const theirs = createClaudeStreamParser(3)
    const ours = claudeCodeRuntime.createParser(3)
    const expected = [...theirs.push(raw), ...theirs.end()]
    const got = [...ours.push(raw), ...ours.end()]
    expect(got).toEqual(expected.map(m => ({ ...m, resumeId: m.claudeSessionId })))
    expect(got.some(m => m.resumeId === 'claude-sess-9')).toBe(true)
  })

  it('a refused --resume: error_during_execution with nothing done; anything done is never re-run', () => {
    const refused = {
      subtype: 'error_during_execution',
      isError: true,
      durationMs: 5,
      usage: { tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0 },
      text: null,
    }
    expect(claudeCodeRuntime.resumeRefused({ stop: null, output: false, result: refused })).toBe(
      true
    )
    expect(claudeCodeRuntime.resumeRefused({ stop: null, output: true, result: refused })).toBe(
      false
    )
    expect(
      claudeCodeRuntime.resumeRefused({
        stop: null,
        output: false,
        result: { ...refused, usage: { ...refused.usage, tokensIn: 3 } },
      })
    ).toBe(false)
  })

  it('the workspace file the repo step always wrote', () => {
    expect(claudeCodeRuntime.workspaceFiles()).toEqual([
      { path: `${SESSION_WORKSPACE}/.claude/settings.local.json`, content: claudeSettingsLocal() },
    ])
  })

  it('the transcript paths the checkpoint and the restore always used', async () => {
    const id = 'b6f3c0de-1111-2222-3333-444455556666'
    const sandbox = new FakeSandbox()
    expect(claudeCodeRuntime.state.key('s1')).toBe('sessions/s1/claude.jsonl')
    expect(
      await claudeCodeRuntime.state.locate(sandbox, row(id), {
        cwd: SESSION_WORKSPACE,
        home: SESSION_HOME,
      })
    ).toBe(`${CLAUDE_PROJECT_DIR}/${id}.jsonl`)
    expect(claudeCodeRuntime.state.restorePath(row(id))).toBe(claudeTranscriptPath(id))
    expect(claudeCodeRuntime.state.checkCommand(claudeTranscriptPath(id))).toBe(
      transcriptCheckCommand(id)
    )
    // An id that is not a safe path segment is no conversation at all — as before.
    expect(claudeCodeRuntime.state.restorePath(row('../etc/passwd'))).toBeNull()
    expect(
      await claudeCodeRuntime.state.locate(sandbox, row(null), {
        cwd: SESSION_WORKSPACE,
        home: SESSION_HOME,
      })
    ).toBeNull()
    expect(sandbox.commands).toEqual([])
  })

  it('has no sandbox-host switch: both runtimes run on either host', () => {
    expect(claudeCodeRuntime).not.toHaveProperty('supportsHostEgress')
    expect(codexRuntime).not.toHaveProperty('supportsHostEgress')
  })
})
