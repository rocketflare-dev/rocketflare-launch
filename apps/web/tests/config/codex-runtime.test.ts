/**
 * Codex as a runtime (§18.22-B), the pure half: the turn and resume commands (flag order from spike
 * S-B1), the files written into `$CODEX_HOME`, the environment (a placeholder key on Launch's
 * account, none on a person's plan), the JSONL → events mapping over the spike's fixtures — the
 * cumulative usage turned into a per-turn delta — the rollout's paths, the device-code prompt
 * parse, `auth.json` handling, redaction, the price and the image pin.
 *
 * The fixtures in `tests/fixtures/codex/` are HAND-WRITTEN from Codex 0.160's source (their first
 * line says so), not captured from a real run.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { estimateCostMicrocents, priceFor } from '@launch/shared/ai/pricing'
import {
  DEFAULT_CODEX_MODEL,
  DEFAULT_SESSION_POLICY,
  runtimePolicyOf,
} from '@launch/shared/launch-sessions'
import { describe, expect, it } from 'vitest'
import { OPENAI_EGRESS_HOSTS } from '@/api/services/sessions/egress/refuse'
import { CODEX_EGRESS_HOSTS } from '@/api/services/sessions/egress/registry'
import { MODEL_KEY_PLACEHOLDER, redactModelKeyText } from '@/api/services/sessions/model-key'
import { SESSION_IMAGE_VERSION } from '@/api/services/sessions/rocketflare-dev'
import { runtimeFor } from '@/api/services/sessions/runtimes'
import { codexRuntime } from '@/api/services/sessions/runtimes/codex'
import {
  codexAuthMetadata,
  decodeJwtClaims,
  jwtExpiry,
  parseCodexAuthJson,
  sameTokens,
  withRefreshedTokens,
} from '@/api/services/sessions/runtimes/codex/auth-json'
import { buildCodexCommand } from '@/api/services/sessions/runtimes/codex/command'
import {
  CODEX_AGENTS_PATH,
  CODEX_CONFIG_PATH,
  CODEX_HOME,
  CODEX_LAUNCH_RULES,
  CODEX_RULES_PATH,
  codexConfigToml,
} from '@/api/services/sessions/runtimes/codex/config'
import {
  codexLoginFailure,
  codexLoginScript,
  parseCodexDevicePrompt,
} from '@/api/services/sessions/runtimes/codex/login'
import {
  codexFindRolloutCommand,
  codexRestorePath,
  threadIdOfRolloutPath,
} from '@/api/services/sessions/runtimes/codex/state'
import {
  codexUsageDelta,
  createCodexStreamParser,
} from '@/api/services/sessions/runtimes/codex/stream'
import { SESSION_BASE_ALLOWED_HOSTS } from '@/api/services/sessions/sandbox-port'
import type { SessionRow } from '@/db/schema'
import { codexAuthJsonText, fakeJwt } from '../helpers/fake-openai'
import { FakeSandbox } from '../helpers/fake-sandbox'

const FIXTURES = path.resolve(__dirname, '../fixtures/codex')
const fixture = (name: string) => readFileSync(path.join(FIXTURES, name), 'utf8')
const THREAD = '0199a213-81c0-7800-8aa1-bbab2a035a53'
const row = (claudeSessionId: string | null) =>
  ({ id: 's1', runtime: 'codex', claudeSessionId }) as unknown as SessionRow

/** Parse a whole fixture, in awkward chunks, the way the turn reads a process. */
function parseAll(text: string, runtimeState: Record<string, unknown> | null = null) {
  const parser = createCodexStreamParser(3, { runtimeState })
  const out = []
  for (let i = 0; i < text.length; i += 37) out.push(...parser.push(text.slice(i, i + 37)))
  out.push(...parser.end())
  return out
}

describe('the command', () => {
  it('a first turn: exec --json, the sandbox flags before anything else, the quoted message, no stdin', () => {
    expect(buildCodexCommand({ message: "fix the header's colour", model: 'gpt-6.1-sol' })).toBe(
      "codex exec --json -s danger-full-access --skip-git-repo-check -m gpt-6.1-sol 'fix the header'\\''s colour' < /dev/null"
    )
  })

  it('a resume: the global flags BEFORE `resume <thread>` (Codex rejects -s after it)', () => {
    const cmd = buildCodexCommand({ message: 'again', model: 'gpt-6.1-sol', resumeId: THREAD })
    expect(cmd).toBe(
      `codex exec --json -s danger-full-access --skip-git-repo-check -m gpt-6.1-sol resume ${THREAD} 'again' < /dev/null`
    )
    expect(cmd.indexOf('-s danger-full-access')).toBeLessThan(cmd.indexOf('resume'))
  })

  it('images: `-i <path>` each, among the global flags before `resume`, each followed by a flag', () => {
    const attachments = [
      { path: '/workspace/.launch/attachments/a.png', contentType: 'image/png' },
      { path: '/workspace/.launch/attachments/b.jpg', contentType: 'image/jpeg' },
    ]
    const cmd = buildCodexCommand({
      message: 'what is wrong here',
      model: 'gpt-6.1-sol',
      resumeId: THREAD,
      attachments,
    })
    expect(cmd).toBe(
      `codex exec --json -s danger-full-access --skip-git-repo-check -i /workspace/.launch/attachments/a.png -i /workspace/.launch/attachments/b.jpg -m gpt-6.1-sol resume ${THREAD} 'what is wrong here' < /dev/null`
    )
    expect(cmd.lastIndexOf('-i ')).toBeLessThan(cmd.indexOf('resume'))
    expect(() =>
      buildCodexCommand({
        message: 'x',
        model: 'm',
        attachments: [{ path: '/tmp/a b.png; rm -rf /', contentType: 'image/png' }],
      })
    ).toThrow(/image path/)
  })

  it('refuses a model or thread id that is not a plain token; a message that looks like a flag is not one', () => {
    expect(() => buildCodexCommand({ message: 'x', model: 'gpt; rm -rf /' })).toThrow(/model/)
    expect(() =>
      buildCodexCommand({ message: 'x', model: 'gpt-6.1-sol', resumeId: '$(whoami)' })
    ).toThrow(/thread/)
    expect(buildCodexCommand({ message: '--help', model: 'm' })).toContain("' --help'")
  })

  it('is what the runtime builds', () => {
    expect(codexRuntime.buildCommand({ message: 'hi', model: 'gpt-6.1-sol' })).toBe(
      buildCodexCommand({ message: 'hi', model: 'gpt-6.1-sol' })
    )
  })
})

describe('the files and the environment', () => {
  const files = codexRuntime.beforeTurnFiles?.({
    model: 'gpt-6.1-sol',
    systemNote: 'You are in a Launch session.',
    source: 'platform',
  })
  const byPath = new Map((files ?? []).map(f => [f.path, f.content]))

  it('config.toml, AGENTS.md (the system note) and the rules, all under $CODEX_HOME', () => {
    expect(CODEX_HOME).toBe('/root/.codex')
    expect([...byPath.keys()].sort()).toEqual(
      [CODEX_CONFIG_PATH, CODEX_AGENTS_PATH, CODEX_RULES_PATH].sort()
    )
    expect(byPath.get(CODEX_AGENTS_PATH)).toBe('You are in a Launch session.\n')
  })

  it('config.toml never asks, never sandboxes, keeps credentials in a file and phones nothing home', () => {
    const toml = byPath.get(CODEX_CONFIG_PATH) ?? ''
    for (const line of [
      'model = "gpt-6.1-sol"',
      'approval_policy = "never"',
      'sandbox_mode = "danger-full-access"',
      'cli_auth_credentials_store = "file"',
      'check_for_update_on_startup = false',
      'web_search = "disabled"',
      '[analytics]\nenabled = false',
      '[feedback]\nenabled = false',
      '[otel]\nmetrics_exporter = "none"',
      'enable_request_compression = false',
      'memories = false',
    ]) {
      expect(toml).toContain(line)
    }
    // A model id cannot break out of its TOML string.
    expect(codexConfigToml('a"b\\c\n')).toContain('model = "a\\"b\\\\c"')
  })

  it('the rules are the spike’s execpolicy (forbid git push and GitHub CLI writes)', () => {
    const rulesOnly = (text: string) =>
      text
        .split('\n')
        .filter(line => !line.startsWith('#'))
        .join('\n')
        .trim()
    expect(rulesOnly(CODEX_LAUNCH_RULES)).toBe(rulesOnly(fixture('execpolicy-no-push.rules')))
    expect(byPath.get(CODEX_RULES_PATH)).toBe(CODEX_LAUNCH_RULES)
  })

  it('Launch’s account: CODEX_API_KEY is the placeholder; a person’s plan: no key at all (it would beat auth.json)', () => {
    expect(codexRuntime.turnEnv({ model: 'm', source: 'platform' })).toEqual({
      CODEX_HOME: '/root/.codex',
      HOME: '/root',
      NO_COLOR: '1',
      CODEX_API_KEY: MODEL_KEY_PLACEHOLDER,
    })
    const user = codexRuntime.turnEnv({ model: 'm', source: 'user' })
    expect(user).not.toHaveProperty('CODEX_API_KEY')
    expect(user).not.toHaveProperty('OPENAI_API_KEY')
  })
})

describe('the JSONL → events', () => {
  it('turn 1: the thread id, reasoning dropped, a command as Bash, a file change as Edit, the answer', () => {
    const mappings = parseAll(fixture('exec-turn1.jsonl'))
    expect(mappings.find(m => m.resumeId)?.resumeId).toBe(THREAD)
    const events = mappings.flatMap(m => m.events)
    expect(events.map(e => e.type)).toEqual([
      'tool.start',
      'tool.end',
      'tool.start',
      'tool.end',
      'text',
    ])
    expect(events[0]).toEqual({
      type: 'tool.start',
      turn: 3,
      data: { name: 'Bash', input: { command: '/bin/bash -lc ls' }, toolCallId: 'item_1' },
    })
    expect(events[1]).toMatchObject({
      type: 'tool.end',
      data: { name: 'Bash', result: 'README.md\npackage.json\nsrc\n', isError: false },
    })
    expect(events[2]).toMatchObject({ data: { name: 'Edit', toolCallId: 'item_2' } })
    expect(events[3]).toMatchObject({
      data: { name: 'Edit', result: 'update /workspace/app/README.md', isError: false },
    })
    expect(events[4]).toMatchObject({
      type: 'text',
      data: { text: expect.stringMatching(/hello world/) },
    })

    const result = mappings.find(m => m.result)?.result
    expect(result).toEqual({
      subtype: 'success',
      isError: false,
      durationMs: null,
      // OpenAI counts cached input INSIDE input_tokens; the session's counters are disjoint.
      usage: { tokensIn: 24763 - 21504, tokensOut: 412, cacheRead: 21504, cacheWrite: 0 },
      text: 'Listed the files and updated README.md to say "hello world".',
    })
    // The running total is handed back for the next turn to measure from.
    expect(mappings.find(m => m.runtimeState)?.runtimeState).toEqual({
      usage: {
        threadId: THREAD,
        inputTokens: 24763,
        cachedInputTokens: 21504,
        cacheWriteInputTokens: 0,
        outputTokens: 412,
        reasoningOutputTokens: 128,
      },
    })
  })

  it('turn 2 (resumed): usage is the DELTA from turn 1’s running total, not the thread’s total', () => {
    const turn1 = parseAll(fixture('exec-turn1.jsonl'))
    const state = turn1.find(m => m.runtimeState)?.runtimeState ?? null
    const turn2 = parseAll(fixture('exec-resume-turn2.jsonl'), state)
    expect(turn2.find(m => m.resumeId)?.resumeId).toBe(THREAD)
    const usage = turn2.find(m => m.result)?.result?.usage
    const input = 51320 - 24763
    const cached = 45056 - 21504
    expect(usage).toEqual({
      tokensIn: input - cached,
      tokensOut: 530 - 412,
      cacheRead: cached,
      cacheWrite: 0,
    })
  })

  it('a new thread (a fresh conversation) starts from zero, whatever the last total said', () => {
    const stale = {
      usage: {
        threadId: 'another-thread',
        inputTokens: 999_999,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 999_999,
        reasoningOutputTokens: 0,
      },
      somethingElse: 'kept',
    }
    const mappings = parseAll(fixture('exec-turn1.jsonl'), stale)
    expect(mappings.find(m => m.result)?.result?.usage?.tokensOut).toBe(412)
    expect(mappings.find(m => m.runtimeState)?.runtimeState).toMatchObject({
      somethingElse: 'kept',
      usage: { threadId: THREAD },
    })
  })

  it('a counter that went backwards is a restarted count: take the total whole', () => {
    const now = {
      threadId: 't',
      inputTokens: 10,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 5,
      reasoningOutputTokens: 0,
    }
    expect(codexUsageDelta(now, { ...now, inputTokens: 50 })).toMatchObject({ tokensIn: 10 })
  })

  it('a failed turn: an error event with the reason, and NO result (the turn fails with the exit)', () => {
    const mappings = parseAll(fixture('exec-failed.jsonl'))
    expect(mappings.some(m => m.result)).toBe(false)
    const events = mappings.flatMap(m => m.events)
    // The top-level `error` line is not repeated: `turn.failed` carries the same message.
    expect(events).toEqual([
      {
        type: 'error',
        turn: 3,
        data: { message: 'unexpected status 401 Unauthorized: Incorrect API key provided' },
      },
    ])
  })

  it('redacts and clips what lands in an event (a tool that printed auth.json or a key)', () => {
    const parser = createCodexStreamParser(1)
    const auth = codexAuthJsonText()
    const key = ['sk', 'proj', 'abcdefghijklmnopqrstuvwxyz0123'].join('-')
    const item = {
      id: 'i',
      type: 'command_execution',
      command: `cat ~/.codex/auth.json; echo ${key}; echo ${MODEL_KEY_PLACEHOLDER}`,
      aggregated_output: `${auth}\n${'x'.repeat(10_000)}`,
      exit_code: 0,
      status: 'completed',
    }
    const [mapping] = parser.push(`${JSON.stringify({ type: 'item.completed', item })}\n`)
    const text = JSON.stringify(mapping?.events)
    expect(text).not.toContain(key)
    expect(text).not.toContain(MODEL_KEY_PLACEHOLDER)
    expect(text).not.toContain('rt_fake_refresh_token_0001')
    expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]{8,}\.eyJ/)
    expect(text).toContain('more characters')
  })

  it('MCP, web search, sub-agents and todo lists are tools; item.updated and reasoning are nothing', () => {
    const parser = createCodexStreamParser(1)
    const lines = [
      { type: 'item.updated', item: { id: 'a', type: 'todo_list', items: [] } },
      {
        type: 'item.completed',
        item: {
          id: 'm',
          type: 'mcp_tool_call',
          server: 'docs',
          tool: 'search',
          arguments: { q: 'x' },
          result: 'hit',
          status: 'completed',
        },
      },
      { type: 'item.completed', item: { id: 'w', type: 'web_search', query: 'vite' } },
      {
        type: 'item.completed',
        item: { id: 't', type: 'todo_list', items: [{ text: 'one', completed: true }] },
      },
      { type: 'item.completed', item: { id: 'e', type: 'error', message: 'non-fatal' } },
      { type: 'item.completed', item: { id: 'r', type: 'reasoning', text: 'hmm' } },
      { type: 'error', message: 'Reconnecting… 1/5' },
    ]
    const events = parser
      .push(`${lines.map(l => JSON.stringify(l)).join('\n')}\n`)
      .flatMap(m => m.events)
    expect(
      events.filter(e => e.type === 'tool.start').map(e => (e.data as { name: string }).name)
    ).toEqual(['mcp__docs__search', 'WebSearch', 'TodoWrite'])
    expect(events.find(e => e.type === 'error')).toMatchObject({ data: { message: 'non-fatal' } })
    expect(events).toHaveLength(7)
  })

  it('a non-zero exit is a failed tool, with the code', () => {
    const parser = createCodexStreamParser(1)
    const item = {
      id: 'c',
      type: 'command_execution',
      command: 'false',
      aggregated_output: 'nope',
      exit_code: 2,
      status: 'failed',
    }
    const events = parser.push(`${JSON.stringify({ type: 'item.completed', item })}\n`)[0]?.events
    expect(events?.[1]).toMatchObject({ data: { isError: true, result: 'nope\n[exit code 2]' } })
  })
})

describe('the rollout (conversation state)', () => {
  it('R2 key, the canonical restore path Codex’s lookup accepts, and a check that finds ANY rollout of the thread', () => {
    expect(codexRuntime.state.key('s1')).toBe('sessions/s1/codex.jsonl')
    const restore = codexRuntime.state.restorePath(row(THREAD))
    expect(restore).toBe(codexRestorePath(THREAD))
    expect(restore).toBe(`/root/.codex/sessions/launch/rollout-1970-01-01T00-00-00-${THREAD}.jsonl`)
    expect(threadIdOfRolloutPath(restore ?? '')).toBe(THREAD)
    expect(codexRuntime.state.checkCommand(restore ?? '')).toBe(
      `test -n "$(${codexFindRolloutCommand(THREAD)})"`
    )
    expect(codexRuntime.state.restorePath(row(null))).toBeNull()
    expect(codexRuntime.state.restorePath(row('not-a-uuid; rm -rf /'))).toBeNull()
  })

  it('locate asks the container for the newest rollout of the thread, and trusts only a matching path', async () => {
    const found = `/root/.codex/sessions/2026/10/03/rollout-2026-10-03T07-00-00-${THREAD}.jsonl`
    const sandbox = new FakeSandbox().onExec(/find \/root\/.codex\/sessions/, {
      stdout: `${found}\n`,
    })
    const opts = { cwd: '/workspace/app', home: '/root' }
    expect(await codexRuntime.state.locate(sandbox, row(THREAD), opts)).toBe(found)
    expect(sandbox.commands[0]).toContain(`-name 'rollout-*-${THREAD}*.jsonl'`)

    const liar = new FakeSandbox().onExec(/find/, { stdout: '/etc/passwd\n' })
    expect(await codexRuntime.state.locate(liar, row(THREAD), opts)).toBeNull()
    const none = new FakeSandbox()
    expect(await codexRuntime.state.locate(none, row(null), opts)).toBeNull()
    expect(none.commands).toEqual([])
  })

  it('never retries a turn without its thread (the rollout is checked before a resume)', () => {
    expect(codexRuntime.resumeRefused({ stop: null, output: false, result: null })).toBe(false)
  })
})

describe('auth.json', () => {
  it('parses what Codex writes, decodes (never verifies) the claims, fingerprints the account', async () => {
    const auth = parseCodexAuthJson(codexAuthJsonText({ plan: 'pro', accessExp: 2_000_000_000 }))
    expect(auth?.tokens.refresh_token).toBe('rt_fake_refresh_token_0001')
    expect(jwtExpiry(auth?.tokens.access_token ?? '')?.getTime()).toBe(2_000_000_000_000)
    const metadata = await codexAuthMetadata(auth as NonNullable<typeof auth>)
    expect(metadata.plan).toBe('pro')
    expect(metadata.account).toMatch(/^[0-9a-f]{12}$/)
    expect(JSON.stringify(metadata)).not.toContain('acct-fake-0001')
    expect(decodeJwtClaims('not.a-jwt')).toBeNull()
    expect(parseCodexAuthJson('{"tokens":{}}')).toBeNull()
    expect(parseCodexAuthJson('nope')).toBeNull()
  })

  it('a refresh replaces the tokens it returned, keeps the rest, and stamps last_refresh', () => {
    const auth = parseCodexAuthJson(codexAuthJsonText()) as NonNullable<
      ReturnType<typeof parseCodexAuthJson>
    >
    const next = withRefreshedTokens(
      auth,
      { access_token: fakeJwt({ n: 2 }), refresh_token: 'rt_2' },
      new Date('2026-10-03T08:00:00Z')
    )
    expect(next.tokens).toMatchObject({ refresh_token: 'rt_2', id_token: auth.tokens.id_token })
    expect(next.tokens.account_id).toBe('acct-fake-0001')
    expect(next.last_refresh).toBe('2026-10-03T08:00:00.000Z')
    expect(sameTokens(auth, next)).toBe(false)
    expect(sameTokens(auth, { ...auth, last_refresh: 'later' })).toBe(true)
  })
})

describe('the device-code sign-in (output parse)', () => {
  it('reads the URL and the one-time code out of Codex’s coloured prompt', () => {
    expect(parseCodexDevicePrompt(fixture('login-device-prompt.ansi'))).toEqual({
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'K7QX-M2PD',
    })
  })

  it('nothing until both are printed; a URL on another host is never relayed', () => {
    const full = fixture('login-device-prompt.ansi')
    expect(parseCodexDevicePrompt(full.slice(0, full.indexOf('2. Enter')))).toBeNull()
    expect(parseCodexDevicePrompt(full.replace(/auth\.openai\.com/g, 'evil.example'))).toBeNull()
    expect(parseCodexDevicePrompt('')).toBeNull()
  })

  it('a failure becomes a sentence; "not enabled" says where to turn it on', () => {
    expect(
      codexLoginFailure(
        'Error logging in with device code: device code login is not enabled for this Codex server.',
        1
      )
    ).toMatch(/ChatGPT’s security settings, or ask your workspace admin/)
    expect(
      codexLoginFailure('Error logging in with device code: device auth failed with status 500', 1)
    ).toBe('Codex could not sign in: device auth failed with status 500')
    expect(codexLoginFailure('', 2)).toBe('Codex could not sign in (exit code 2).')
  })

  it('the runner keeps the CLI’s streams and exit code in files, and gives it no stdin', () => {
    const script = codexLoginScript('/tmp/launch-login-x')
    expect(script).toContain('export CODEX_HOME=/tmp/launch-login-x/home')
    expect(script).toContain(
      'codex login --device-auth > /tmp/launch-login-x/out 2> /tmp/launch-login-x/err < /dev/null'
    )
    expect(script).toContain('mv /tmp/launch-login-x/exit.tmp /tmp/launch-login-x/exit')
  })
})

describe('around the runtime', () => {
  it('is registered, provider openai', () => {
    expect(runtimeFor('codex')).toBe(codexRuntime)
    expect(codexRuntime.provider).toBe('openai')
    expect(codexRuntime.login?.needsCode).toBe(false)
    expect(codexRuntime.login?.hosts).toEqual(['auth.openai.com'])
  })

  it('Codex’s hosts are on the allow-list, the same three the handlers serve', () => {
    expect([...CODEX_EGRESS_HOSTS].sort()).toEqual([...OPENAI_EGRESS_HOSTS].sort())
    for (const host of CODEX_EGRESS_HOSTS) {
      expect(SESSION_BASE_ALLOWED_HOSTS as readonly string[]).toContain(host)
    }
  })

  it('OpenAI keys and JWTs are redacted; words that merely contain "sk-" are not', () => {
    const key = ['sk', 'proj', 'A1b2C3d4E5f6G7h8I9j0K1l2'].join('-')
    const legacy = ['sk', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4'].join('-')
    const jwt = fakeJwt({ sub: 'someone', exp: 1 })
    expect(redactModelKeyText(`a ${key} b ${legacy} c ${jwt}`)).toBe(
      'a [redacted] b [redacted] c [redacted]'
    )
    expect(redactModelKeyText('"refresh_token": "rt_opaque_value_123"')).toBe(
      '"refresh_token": "[redacted]"'
    )
    expect(
      redactModelKeyText('the disk-usage-analyzer-component-widget task-runner-sk-thing')
    ).toBe('the disk-usage-analyzer-component-widget task-runner-sk-thing')
  })

  it('the default Codex model is Codex 0.160’s own default, and it is priced', () => {
    expect(DEFAULT_CODEX_MODEL).toBe('gpt-6.1-sol')
    expect(runtimePolicyOf(DEFAULT_SESSION_POLICY, 'codex').model).toBe(DEFAULT_CODEX_MODEL)
    expect(priceFor('openai', 'gpt-6.1-sol-2026-09-30')).toEqual({
      input: 2,
      output: 10,
      cacheRead: 0.1,
      cacheWrite: 2.5,
    })
    // 1M uncached in + 1M cached + 1M out = $2 + $0.10 + $10.
    expect(
      estimateCostMicrocents('openai', 'gpt-6.1-sol', {
        inputTokens: 1_000_000,
        cacheReadTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheWriteTokens: 0,
      })
    ).toBe(1_210_000_000)
  })

  it('the image pins Codex, and its version label moved with SESSION_IMAGE_VERSION', () => {
    const dockerfile = readFileSync(
      path.resolve(__dirname, '../../containers/session/Dockerfile'),
      'utf8'
    )
    expect(dockerfile).toContain('ARG CODEX_VERSION=0.160.0')
    expect(dockerfile).toContain(`"@openai/codex@\${CODEX_VERSION}"`)
    expect(dockerfile).toContain('codex --version')
    expect(SESSION_IMAGE_VERSION).toBe('session-6')
    expect(dockerfile).toContain(
      `LABEL dev.rocketflare.launch.session-image="${SESSION_IMAGE_VERSION}"`
    )
  })
})
