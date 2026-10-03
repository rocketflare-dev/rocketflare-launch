/**
 * Claude's relayed sign-in (§18.22-A), without a database: the terminal parsers over the REAL
 * `claude setup-token` output captured in spike S-A1 (`tests/fixtures/claude-login/*.ansi`, Claude
 * Code 2.1.283 under `script` — the `<<<SPIKE: …>>>` lines mark what the spike typed), the relay
 * command, the driver over a `FakeSandbox`, and the subscription halves of the turn environment
 * and the model request. The success screen is synthetic (`tests/helpers/claude-login.ts`).
 */
import { describe, expect, it } from 'vitest'
import { claudeTurnEnv } from '@/api/services/sessions/claude-stream'
import {
  ANTHROPIC_OAUTH_BETA,
  keyedModelRequest,
  type ModelCall,
  withOAuthBeta,
} from '@/api/services/sessions/egress/forward-model'
import { MODEL_KEY_PLACEHOLDER } from '@/api/services/sessions/model-key'
import { claudeCodeRuntime } from '@/api/services/sessions/runtimes/claude-code'
import {
  CLAUDE_LOGIN_ENV,
  CLAUDE_LOGIN_HOSTS,
  CLAUDE_TOKEN_LIFETIME_MS,
  claudeLoginCommand,
  claudeLoginDir,
  claudeLoginDriver,
  claudeLoginLastLine,
  claudeLoginRejectedCode,
  claudeLoginScreenText,
  claudeLoginWantsCode,
  isClaudeLoginCode,
  parseClaudeAuthorizeUrl,
  parseClaudeSetupToken,
} from '@/api/services/sessions/runtimes/claude-code/login'
import {
  claudeLoginFixture,
  emulateClaudeRelay,
  FAKE_CLAUDE_TOKEN as FAKE_TOKEN,
  spikeSegments as segments,
  setupTokenSuccessScreen,
} from '../helpers/claude-login'
import { FakeSandbox } from '../helpers/fake-sandbox'

const WIDE = claudeLoginFixture('setup-token-1000cols.ansi')
const NARROW = claudeLoginFixture('setup-token-200cols.ansi')

const EXPECTED_URL_PREFIX =
  'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e'

describe('reading setup-token’s terminal (spike S-A1 fixtures)', () => {
  it('the URL is the OSC 8 link target — at 1000 columns and at 200, where the visible text wraps', () => {
    for (const raw of [WIDE, NARROW]) {
      const url = parseClaudeAuthorizeUrl(segments(raw)[0] ?? '')
      expect(url).toMatch(new RegExp(`^${EXPECTED_URL_PREFIX.replace(/[?.]/g, '\\$&')}`))
      const parsed = new URL(url as string)
      expect(parsed.searchParams.get('scope')).toBe('user:inference')
      expect(parsed.searchParams.get('redirect_uri')).toBe(
        'https://platform.claude.com/oauth/code/callback'
      )
      expect(parsed.searchParams.get('state')).toBeTruthy()
    }
  })

  it('nothing before the link is a URL; a link to anywhere else is not the sign-in', () => {
    const beforeLink = (segments(WIDE)[0] ?? '').split('\u001b]8;')[0] ?? ''
    expect(parseClaudeAuthorizeUrl(beforeLink)).toBeNull()
    expect(
      parseClaudeAuthorizeUrl(
        '\u001b]8;id=1;https://evil.example/oauth/authorize?x=1\u0007x\u001b]8;;\u0007'
      )
    ).toBeNull()
    expect(
      parseClaudeAuthorizeUrl(
        '\u001b]8;id=1;http://claude.ai/oauth/authorize?x=1\u0007x\u001b]8;;\u0007'
      )
    ).toBeNull()
    // The other authorize hosts the CLI has used are accepted, in a link or (fallback) as text.
    expect(parseClaudeAuthorizeUrl('Open https://claude.ai/oauth/authorize?state=s now')).toBe(
      'https://claude.ai/oauth/authorize?state=s'
    )
    expect(
      parseClaudeAuthorizeUrl(
        '\u001b]8;;https://platform.claude.com/oauth/authorize?a=1\u001b\\link\u001b]8;;\u001b\\'
      )
    ).toBe('https://platform.claude.com/oauth/authorize?a=1')
  })

  it('the prompt is read through the cursor moves that stand in for spaces', () => {
    const first = segments(WIDE)[0] ?? ''
    expect(claudeLoginWantsCode(first)).toBe(true)
    expect(claudeLoginScreenText(first)).toContain('Paste code here if prompted')
    expect(claudeLoginScreenText(first)).not.toContain('\u001b')
  })

  it('a rejected code is recognised in what follows the paste, and not before it', () => {
    for (const raw of [WIDE, NARROW]) {
      const [beforePaste, afterPaste] = segments(raw)
      expect(claudeLoginRejectedCode(beforePaste ?? '')).toBe(false)
      expect(claudeLoginRejectedCode(`${beforePaste}${afterPaste}`)).toBe(true)
    }
  })

  it('the token is captured from the success screen, and nowhere in the fixtures', () => {
    expect(parseClaudeSetupToken(`${WIDE}${setupTokenSuccessScreen()}`)).toBe(FAKE_TOKEN)
    expect(parseClaudeSetupToken(WIDE)).toBeNull()
    expect(parseClaudeSetupToken('sk-ant-oat01-short')).toBeNull()
  })

  it('a code is `<code>#<state>`', () => {
    expect(isClaudeLoginCode('abcDEF_123-x#state-XYZ_9')).toBe(true)
    expect(isClaudeLoginCode('  abc#def \n')).toBe(true)
    for (const bad of ['abc', 'abc#', '#def', 'a#b#c', 'ab c#def', '']) {
      expect(isClaudeLoginCode(bad), bad).toBe(false)
    }
  })
})

describe('the relay', () => {
  it('runs setup-token at 2000 columns under script, fed from `in`, its exit code in `exit`', () => {
    const id = '0f6c3a52-0f0b-4a3e-9d7e-2d1f3b4c5d6e'
    const dir = claudeLoginDir(id)
    expect(dir).toBe(`/tmp/launch-login/${id}`)
    expect(claudeLoginCommand(id)).toBe(
      `mkdir -p ${dir} && : > ${dir}/in && cd ${dir} && tail -n +1 -F ${dir}/in 2>/dev/null | ` +
        `script -q -f -e -c 'stty cols 2000 rows 50; claude setup-token; echo $? > ${dir}/exit' ${dir}/out`
    )
    expect(() => claudeLoginDir('../../etc')).toThrow()
    expect(() => claudeLoginCommand("x'; rm -rf / #")).toThrow()
  })

  it('the environment is non-secret and opens no browser; the hosts are the login’s two', () => {
    expect(CLAUDE_LOGIN_ENV).toMatchObject({
      HOME: '/root',
      IS_SANDBOX: '1',
      DISABLE_AUTOUPDATER: '1',
      NODE_USE_SYSTEM_CA: '1',
      BROWSER: '/bin/true',
    })
    expect([...CLAUDE_LOGIN_HOSTS].sort()).toEqual(['api.anthropic.com', 'platform.claude.com'])
    expect(claudeCodeRuntime.login).toBe(claudeLoginDriver)
    expect(claudeLoginDriver.needsCode).toBe(true)
  })
})

describe('the driver over a FakeSandbox', () => {
  const loginId = '5b0d7f1e-8c3a-4d2b-9e6f-1a2b3c4d5e6f'
  const dir = claudeLoginDir(loginId)
  const setup = () => {
    const sandbox = emulateClaudeRelay(new FakeSandbox({ name: `login-${loginId}` }))
    return { sandbox, ctx: { sandbox, loginId } }
  }

  it('start runs the relay with the login environment', async () => {
    const { sandbox, ctx } = setup()
    await claudeLoginDriver.start(ctx)
    expect(sandbox.processes).toHaveLength(1)
    expect(sandbox.processes[0]?.command).toBe(claudeLoginCommand(loginId))
    expect(sandbox.processes[0]?.opts?.env).toEqual({ ...CLAUDE_LOGIN_ENV })
  })

  it('readPrompt: nothing yet → null; the screen with the link → the URL; an early exit → a sentence', async () => {
    const { sandbox, ctx } = setup()
    expect(await claudeLoginDriver.readPrompt(ctx)).toBeNull()
    sandbox.files.set(`${dir}/out`, (segments(WIDE)[0] ?? '').slice(0, 200))
    expect(await claudeLoginDriver.readPrompt(ctx)).toBeNull()
    sandbox.files.set(`${dir}/out`, segments(WIDE)[0] ?? '')
    const prompt = await claudeLoginDriver.readPrompt(ctx)
    expect(prompt?.userCode).toBeNull()
    expect(prompt?.verificationUrl.startsWith(EXPECTED_URL_PREFIX)).toBe(true)

    const crashed = setup()
    crashed.sandbox.files.set(`${dir}/out`, 'Error: something broke')
    crashed.sandbox.files.set(`${dir}/exit`, '1\n')
    await expect(claudeLoginDriver.readPrompt(crashed.ctx)).rejects.toThrow(/stopped before/)
  })

  it('submitCode writes the code, then appends Enter as its own key press; a malformed code never reaches the CLI', async () => {
    const { sandbox, ctx } = setup()
    await expect(claudeLoginDriver.submitCode?.(ctx, 'no-hash-here')).rejects.toThrow(/#/)
    expect(sandbox.files.has(`${dir}/in`)).toBe(false)
    await claudeLoginDriver.submitCode?.(ctx, '  theCode_1#theState-2 ')
    // One write of "code\r" reads as a single paste and never submits (seen live): Enter is appended
    // after it, never written with it, and the file is never rewritten (tail -F would replay it).
    expect(sandbox.files.get(`${dir}/in`)).toBe('theCode_1#theState-2')
    expect(sandbox.commands.at(-1)).toBe(`sleep 0.5; printf '\\r' >> ${dir}/in`)
  })

  it('poll: running, a rejected code (the CLI waits for Enter) → a sentence, then the exit', async () => {
    const { sandbox, ctx } = setup()
    const [beforePaste, afterPaste] = segments(WIDE)
    sandbox.files.set(`${dir}/out`, beforePaste ?? '')
    expect(await claudeLoginDriver.poll(ctx)).toEqual({ state: 'running' })
    sandbox.files.set(`${dir}/exit`, '')
    expect(await claudeLoginDriver.poll(ctx)).toEqual({ state: 'running' })
    sandbox.files.set(`${dir}/out`, `${beforePaste}${afterPaste}`)
    sandbox.files.delete(`${dir}/exit`)
    await expect(claudeLoginDriver.poll(ctx)).rejects.toThrow(/did not accept that code/)
    sandbox.files.set(`${dir}/exit`, '0\n')
    expect(await claudeLoginDriver.poll(ctx)).toEqual({ state: 'exited', exitCode: 0 })
  })

  it('capture: the token, a year, value-free metadata — and the login directory is gone', async () => {
    const { sandbox, ctx } = setup()
    sandbox.files.set(`${dir}/in`, 'code#state\r')
    sandbox.files.set(`${dir}/out`, `${segments(WIDE)[0]}${setupTokenSuccessScreen()}`)
    sandbox.files.set(`${dir}/exit`, '0\n')
    const before = Date.now()
    const captured = await claudeLoginDriver.capture(ctx)
    expect(captured.kind).toBe('claude_oauth_token')
    expect(captured.secret).toBe(FAKE_TOKEN)
    const expires = captured.expiresAt?.getTime() ?? 0
    expect(expires).toBeGreaterThanOrEqual(before + CLAUDE_TOKEN_LIFETIME_MS)
    expect(expires).toBeLessThanOrEqual(Date.now() + CLAUDE_TOKEN_LIFETIME_MS)
    expect(JSON.stringify(captured.metadata)).not.toContain('sk-ant')
    expect([...sandbox.files.keys()].filter(p => p.startsWith(dir))).toEqual([])
    expect(sandbox.commands.at(-1)).toBe(`rm -rf ${dir}`)
  })

  it('capture after a failed exit, or with no token printed, fails — and still removes the directory', async () => {
    for (const [out, exit] of [
      [`${segments(WIDE)[0]}${setupTokenSuccessScreen()}`, '1\n'],
      [segments(WIDE)[0] ?? '', '0\n'],
    ] as const) {
      const { sandbox, ctx } = setup()
      sandbox.files.set(`${dir}/out`, out)
      sandbox.files.set(`${dir}/exit`, exit)
      const err = await claudeLoginDriver.capture(ctx).catch(e => e as Error)
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).message).toMatch(/without a token/)
      expect((err as Error).message).not.toContain('sk-ant')
      expect([...sandbox.files.keys()].filter(p => p.startsWith(dir))).toEqual([])
    }
  })

  it('a failed sign-in says the exit code and the CLI’s last line, never a token or the code', async () => {
    const { sandbox, ctx } = setup()
    const code = `${'c'.repeat(40)}#${'s'.repeat(20)}`
    sandbox.files.set(
      `${dir}/out`,
      `${code}\r\n\u001b[2GOAuth\u001b[8Gerror:\u001b[15Grequest\u001b[23Gfailed\u001b[30G${FAKE_TOKEN}\r\n`
    )
    sandbox.files.set(`${dir}/exit`, '1\n')
    const err = (await claudeLoginDriver.capture(ctx).catch(e => e)) as Error
    expect(err.message).toMatch(/\(exit 1\): “OAuth error: request failed \[redacted\]”/)
    expect(err.message).not.toContain('sk-ant')
    expect(err.message).not.toContain(code)
    expect(claudeLoginLastLine(code)).toBeNull()
  })

  it('a token split by a cursor move on screen is still read from the raw output', () => {
    const [head, tail] = [FAKE_TOKEN.slice(0, 30), FAKE_TOKEN.slice(30)]
    expect(parseClaudeSetupToken(`${head}\u001b[1C${tail}\r\n`)).toBe(FAKE_TOKEN)
  })
})

describe('the turn environment on a subscription', () => {
  it('user: the placeholder OAuth token and NO API key (it would win); platform: unchanged', () => {
    const user = claudeTurnEnv('claude-sonnet-4-5', 'user')
    expect(user.CLAUDE_CODE_OAUTH_TOKEN).toBe(MODEL_KEY_PLACEHOLDER)
    expect('ANTHROPIC_API_KEY' in user).toBe(false)
    const platform = claudeTurnEnv('claude-sonnet-4-5', 'platform')
    expect(platform).toEqual({
      ANTHROPIC_API_KEY: MODEL_KEY_PLACEHOLDER,
      ANTHROPIC_SMALL_FAST_MODEL: 'claude-sonnet-4-5',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-sonnet-4-5',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_AUTOUPDATER: '1',
      NODE_USE_SYSTEM_CA: '1',
      IS_SANDBOX: '1',
      HOME: '/root',
    })
    expect(Object.keys(platform)[0]).toBe('ANTHROPIC_API_KEY')
    expect(claudeTurnEnv('claude-sonnet-4-5')).toEqual(platform)
    // Everything but the credential is the same.
    const { CLAUDE_CODE_OAUTH_TOKEN: _t, ...userRest } = user
    const { ANTHROPIC_API_KEY: _k, ...platformRest } = platform
    expect(userRest).toEqual(platformRest)
    expect(claudeCodeRuntime.turnEnv({ model: 'm', source: 'user' })).toEqual(
      claudeTurnEnv('m', 'user')
    )
  })
})

describe('the keyed request on a subscription', () => {
  const call: ModelCall = {
    path: '/v1/messages',
    search: '?beta=true',
    body: '{"model":"claude-sonnet-4-5"}',
    model: 'claude-sonnet-4-5',
  }
  const sandboxRequest = (beta?: string) =>
    new Request('https://api.anthropic.com/v1/messages?beta=true', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${MODEL_KEY_PLACEHOLDER}`,
        'anthropic-version': '2023-06-01',
        ...(beta ? { 'anthropic-beta': beta } : {}),
      },
      body: call.body,
    })

  it('oauth: Bearer real token, no x-api-key, the beta flag merged once with the client’s own', async () => {
    const req = keyedModelRequest(
      sandboxRequest('claude-code-20250219,oauth-2025-04-20, interleaved-thinking-2025-05-14'),
      call,
      { kind: 'oauth', token: FAKE_TOKEN }
    )
    expect(req.url).toBe('https://api.anthropic.com/v1/messages?beta=true')
    expect(req.headers.get('authorization')).toBe(`Bearer ${FAKE_TOKEN}`)
    expect(req.headers.get('x-api-key')).toBeNull()
    expect(req.headers.get('anthropic-beta')).toBe(
      'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14'
    )
    expect(await req.text()).toBe(call.body)

    const bare = keyedModelRequest(sandboxRequest(), call, { kind: 'oauth', token: FAKE_TOKEN })
    expect(bare.headers.get('anthropic-beta')).toBe(ANTHROPIC_OAUTH_BETA)
  })

  it('api_key: exactly as before — x-api-key, no Authorization, the beta header untouched', () => {
    const req = keyedModelRequest(sandboxRequest('claude-code-20250219'), call, {
      kind: 'api_key',
      key: 'sk-ant-api03-test',
    })
    expect(req.headers.get('x-api-key')).toBe('sk-ant-api03-test')
    expect(req.headers.get('authorization')).toBeNull()
    expect(req.headers.get('anthropic-beta')).toBe('claude-code-20250219')
  })

  it('withOAuthBeta keeps order, trims, drops empties, never doubles', () => {
    expect(withOAuthBeta(null)).toBe(ANTHROPIC_OAUTH_BETA)
    expect(withOAuthBeta(' a , ,b ')).toBe(`a,b,${ANTHROPIC_OAUTH_BETA}`)
    expect(withOAuthBeta(`${ANTHROPIC_OAUTH_BETA},a`)).toBe(`${ANTHROPIC_OAUTH_BETA},a`)
  })
})
