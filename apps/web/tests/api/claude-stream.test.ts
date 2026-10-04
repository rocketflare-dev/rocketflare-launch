/**
 * `services/sessions/claude-stream.ts` (Launch P3, slice 3c): the pure mapping from Claude Code's
 * `--output-format stream-json --verbose` lines to `session_events`, and the turn's command.
 *
 * Fixtures (`tests/fixtures/claude-stream/s7-turn{1,2}.jsonl`) are the S7 spike's chat loop
 * (`spikes/s7-sandbox/output-locked-session.txt`) in Claude Code's own line shape: turn 1
 * `system:init → assistant (Write) → user (tool_result) → assistant ("done") → result:success`,
 * turn 2 — a `--resume` of the same session — `system:init → assistant ("alpha") → result:success`,
 * with S7's metered usage on the `result` line.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SESSION_EVENT_DATA } from '@launch/shared/launch-sessions'
import { describe, expect, it } from 'vitest'
import {
  buildClaudeCommand,
  buildClaudeTurnInputScript,
  CLAUDE_EVENT_STRING_MAX,
  CLAUDE_TURN_INPUT,
  claudeTurnEnv,
  createClaudeStreamParser,
  mapClaudeLine,
  shellQuote,
} from '@/api/services/sessions/claude-stream'
import { MODEL_KEY_PLACEHOLDER } from '@/api/services/sessions/model-key'
import { CLAUDE_PROJECT_DIR, SESSION_HOME } from '@/api/services/sessions/rocketflare-dev'
import { claudeStreamJsonLines } from '../helpers/fake-anthropic'

const fixture = (name: string) =>
  readFileSync(path.join(__dirname, '../fixtures/claude-stream', name), 'utf8')

const S7_SESSION = '9f2eaa21-8db4-464a-b7c5-eff41d6a0c10'

describe('mapClaudeLine on the S7 turns', () => {
  it('turn 1: init → tool.start → tool.end → text, and the result with its usage', () => {
    const parser = createClaudeStreamParser(1)
    const mappings = [...parser.push(fixture('s7-turn1.jsonl')), ...parser.end()]
    expect(mappings).toHaveLength(5)
    expect(mappings[0]?.claudeSessionId).toBe(S7_SESSION)
    const events = mappings.flatMap(m => m.events)
    expect(events.map(e => e.type)).toEqual(['tool.start', 'tool.end', 'text'])
    expect(events[0]).toEqual({
      type: 'tool.start',
      turn: 1,
      data: {
        name: 'Write',
        input: { file_path: '/workspace/chat/notes.txt', content: 'alpha' },
        toolCallId: 'toolu_01Rk8mWq3vJb5tLx9aZcP2dE',
      },
    })
    // The result carries only the id; the name comes back from the tool_use line before it.
    expect(events[1]).toEqual({
      type: 'tool.end',
      turn: 1,
      data: {
        name: 'Write',
        result: 'File created successfully at: /workspace/chat/notes.txt',
        isError: false,
        toolCallId: 'toolu_01Rk8mWq3vJb5tLx9aZcP2dE',
      },
    })
    expect(events[2]).toEqual({ type: 'text', turn: 1, data: { text: 'done' } })
    const result = mappings[4]?.result
    expect(result).toEqual({
      subtype: 'success',
      isError: false,
      durationMs: 6512,
      usage: { tokensIn: 6, tokensOut: 115, cacheRead: 40131, cacheWrite: 4865 },
      text: 'done',
    })
    // Every event's data parses with its contract.
    for (const e of events) expect(SESSION_EVENT_DATA[e.type].safeParse(e.data).success).toBe(true)
  })

  it('turn 2 (resumed): the same session id, one text, a result', () => {
    const lines = fixture('s7-turn2.jsonl').trim().split('\n')
    const mapped = lines.map(line => mapClaudeLine(line, { turn: 2 }))
    expect(mapped[0]?.claudeSessionId).toBe(S7_SESSION)
    expect(mapped.flatMap(m => m.events)).toEqual([
      { type: 'text', turn: 2, data: { text: 'alpha' } },
    ])
    expect(mapped[2]?.result?.subtype).toBe('success')
  })

  it('a line split across chunks anywhere maps the same as whole lines', () => {
    const text = fixture('s7-turn1.jsonl')
    const whole = createClaudeStreamParser(1)
    const expected = [...whole.push(text), ...whole.end()].flatMap(m => m.events)
    for (const size of [1, 7, 64, 300]) {
      const parser = createClaudeStreamParser(1)
      const got = []
      for (let i = 0; i < text.length; i += size) got.push(...parser.push(text.slice(i, i + size)))
      got.push(...parser.end())
      expect(got.flatMap(m => m.events)).toEqual(expected)
    }
  })

  it('matches the fake Claude Code the other suites use', () => {
    const parser = createClaudeStreamParser(3)
    const lines = claudeStreamJsonLines({
      sessionId: 'c1',
      text: 'Changed the heading.',
      tools: [{ name: 'Edit', input: { file_path: 'a.tsx' }, result: 'ok', isError: true }],
    })
    const mappings = parser.push(`${lines.join('\n')}\n`)
    expect(mappings.flatMap(m => m.events).map(e => e.type)).toEqual([
      'tool.start',
      'tool.end',
      'text',
    ])
    expect(mappings.flatMap(m => m.events)[1]?.data).toMatchObject({ name: 'Edit', isError: true })
  })
})

describe('mapClaudeLine: what never becomes an event', () => {
  it('ignores non-JSON, unknown types and thinking blocks', () => {
    expect(mapClaudeLine('npm warn deprecated', { turn: 1 }).events).toEqual([])
    expect(mapClaudeLine('{not json', { turn: 1 }).events).toEqual([])
    expect(mapClaudeLine(JSON.stringify({ type: 'stream_event' }), { turn: 1 }).events).toEqual([])
    const thinking = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'thinking', thinking: 'hmm' }] },
    })
    expect(mapClaudeLine(thinking, { turn: 1 }).events).toEqual([])
  })

  it('redacts the placeholder and anything key-shaped, and clips long strings', () => {
    const env = JSON.stringify({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't1',
            content: [
              {
                type: 'text',
                text: `ANTHROPIC_API_KEY=${MODEL_KEY_PLACEHOLDER}\nOTHER=sk-ant-api03-abcdefghijklmnop`,
              },
            ],
          },
        ],
      },
    })
    const [event] = mapClaudeLine(env, { turn: 1, toolNames: new Map([['t1', 'Bash']]) }).events
    const text = JSON.stringify(event)
    expect(text).not.toContain(MODEL_KEY_PLACEHOLDER)
    expect(text).not.toContain('sk-ant-')
    expect(event?.data).toMatchObject({
      name: 'Bash',
      result: 'ANTHROPIC_API_KEY=[redacted]\nOTHER=[redacted]',
    })

    const big = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'w', name: 'Write', input: { content: 'x'.repeat(10_000) } },
        ],
      },
    })
    const [start] = mapClaudeLine(big, { turn: 1 }).events
    const content = (start?.data as { input: { content: string } } | undefined)?.input.content ?? ''
    expect(content.length).toBeLessThan(CLAUDE_EVENT_STRING_MAX + 100)
    expect(content).toContain('more characters')
  })
})

describe('the turn command', () => {
  it('has the plan’s flags, the policy model and no push', () => {
    const cmd = buildClaudeCommand({
      message: 'Change the heading',
      model: 'claude-sonnet-4-5',
      resumeSessionId: S7_SESSION,
    })
    expect(cmd).toBe(
      `claude -p 'Change the heading' --resume ${S7_SESSION} --output-format stream-json --verbose --permission-mode bypassPermissions --model claude-sonnet-4-5 --disallowedTools "Bash(git push:*)"`
    )
    expect(buildClaudeCommand({ message: 'hi', model: 'm' })).not.toContain('--resume')
  })

  it('appends the system note, quoted, on a first and on a resumed turn', () => {
    // --append-system-prompt does not survive --resume, so a resumed turn carries it too.
    const note = `Don't run the full gate; $(id) stays text`
    for (const resumeSessionId of [null, S7_SESSION]) {
      const cmd = buildClaudeCommand({
        message: 'hi',
        model: 'm',
        resumeSessionId,
        systemNote: note,
      })
      expect(cmd.endsWith(` --append-system-prompt ${shellQuote(note)}`)).toBe(true)
    }
    expect(buildClaudeCommand({ message: 'hi', model: 'm' })).not.toContain(
      '--append-system-prompt'
    )
  })

  it('quotes the message so no shell sees it', () => {
    const evil = `'; rm -rf / #$(whoami)\`id\``
    expect(buildClaudeCommand({ message: evil, model: 'm' })).toContain(shellQuote(evil))
    expect(shellQuote(`it's`)).toBe(`'it'\\''s'`)
    expect(() => buildClaudeCommand({ message: 'x', model: 'm; rm -rf /' })).toThrow()
    expect(() =>
      buildClaudeCommand({ message: 'x', model: 'm', resumeSessionId: '$(id)' })
    ).toThrow()
  })

  it('with images: the stream-json input on stdin, no message in argv, every other flag as before', () => {
    const cmd = buildClaudeCommand({
      message: 'What is wrong here?',
      model: 'claude-sonnet-5',
      resumeSessionId: S7_SESSION,
      systemNote: 'note',
      attachments: [{ path: '/workspace/.launch/attachments/a.png', contentType: 'image/png' }],
    })
    expect(cmd).toBe(
      `claude -p --input-format stream-json --resume ${S7_SESSION} --output-format stream-json --verbose --permission-mode bypassPermissions --model claude-sonnet-5 --disallowedTools "Bash(git push:*)" --append-system-prompt 'note' < ${CLAUDE_TURN_INPUT}`
    )
    expect(cmd).not.toContain('What is wrong')
  })

  it('the input script writes ONE stream-json user line: the images as base64 blocks, then the text', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'claude-input-'))
    // Large enough that GNU base64 wraps it (76 columns): the script must unwrap it.
    const png = Buffer.from(Array.from({ length: 300 }, (_, i) => i % 256))
    const gif = Buffer.from('GIF89a-tiny')
    writeFileSync(path.join(dir, 'a.png'), png)
    writeFileSync(path.join(dir, 'b.gif'), gif)
    const target = path.join(dir, 'out', 'turn-input.jsonl')
    const message = `It's "broken" — $(id) \\ \n stays text`
    const script = buildClaudeTurnInputScript(
      {
        message,
        attachments: [
          { path: path.join(dir, 'a.png'), contentType: 'image/png' },
          { path: path.join(dir, 'b.gif'), contentType: 'image/gif' },
        ],
      },
      target
    )
    execFileSync('sh', ['-c', script])
    const written = readFileSync(target, 'utf8')
    expect(written.endsWith('\n')).toBe(true)
    expect(written.trim().split('\n')).toHaveLength(1)
    expect(JSON.parse(written)).toEqual({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') },
          },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/gif', data: gif.toString('base64') },
          },
          { type: 'text', text: message },
        ],
      },
    })
    expect(() =>
      buildClaudeTurnInputScript({
        message: 'x',
        attachments: [{ path: '/tmp/a.png; rm -rf /', contentType: 'image/png' }],
      })
    ).toThrow(/invalid attachment/)
  })

  it('runs with the placeholder key and the policy model for background calls', () => {
    const env = claudeTurnEnv('claude-sonnet-4-5')
    expect(env.ANTHROPIC_API_KEY).toBe(MODEL_KEY_PLACEHOLDER)
    expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBe('claude-sonnet-4-5')
    expect(JSON.stringify(env)).not.toContain('sk-ant-')
  })

  it('may bypass permissions as root, with the HOME its transcripts are read from', () => {
    const env = claudeTurnEnv('claude-sonnet-4-5')
    // Claude Code refuses bypassPermissions as root without IS_SANDBOX=1.
    expect(env.IS_SANDBOX).toBe('1')
    expect(env.HOME).toBe(SESSION_HOME)
    expect(CLAUDE_PROJECT_DIR.startsWith(`${env.HOME}/.claude/projects/`)).toBe(true)
  })
})
